import { type Context, Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../audit/auditStore';
import { authService, LoginFailed } from '../auth/authService';
import { clearSessionCookie, setSessionCookie } from '../auth/cookieSession';
import { signToken,verifyToken } from '../auth/jwt';
import {
  checkLoginRate,
  clearLoginAttempts,
  recordLoginFailure,
} from '../auth/loginRateLimit';
import { pool } from '../db/pool';
import { loginRecord } from '../org/loginRecord';
import { AuditAction } from '../shared/enterpriseServerConstants';

export const authRoutes = new Hono();

/**
 * True when the request arrived over TLS. The node adapter is HTTP-only, so
 * behind a TLS-terminating proxy the client only sees `forwarded: https`;
 * honor `x-forwarded-proto` and `x-forwarded-ssl-protocol` for that case.
 */
function isSecureRequest(c: Context): boolean {
  if (c.req.url.startsWith('https://')) return true;
  const fwd = c.req.header('x-forwarded-proto');
  if (fwd && fwd.split(',')[0]!.trim().toLowerCase() === 'https') return true;
  return (c.req.header('x-forwarded-ssl-protocol') ?? '').trim().toLowerCase() === 'on';
}

/**
 * Best-effort client IP for login-event recording. Behind a proxy the
 * first `x-forwarded-for` hop is the client; otherwise fall back to the
 * socket address when the serving adapter exposes it on the Hono request
 * (the node:http bridge in server.ts does not, so in-process tests and
 * that bridge yield `null`).
 */
function clientIp(c: Context): string | null {
  const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (first) return first;
  const socket = (c.req as { socket?: { remoteAddress?: string } }).socket;
  return socket?.remoteAddress ?? null;
}

/**
 * Public list of orgs for the login page. The SPA fetches this on mount:
 * when there is exactly one org, it skips the org selector entirely
 * (single-tenant deployments); when there are multiple, it renders a
 * dropdown so the user can pick. No auth required — a user who has not
 * logged in yet must be able to discover the org list.
 */
authRoutes.get('/auth/orgs', async (c) => {
  const r = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM orgs ORDER BY created_at ASC`
  );
  return c.json({ orgs: r.rows });
});

authRoutes.post('/auth/login', async (c) => {
  // orgName is optional: when omitted and exactly one org exists, the
  // server uses it. When omitted and multiple orgs exist, the SPA is
  // expected to have rendered the selector and posted the chosen name.
  const parsed = z
    .object({
      orgName: z.string().optional(),
      username: z.string(),
      password: z.string(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid' }, 400);
  }
  const body = parsed.data;
  // Client metadata for login-event recording (Task 10). Both are
  // best-effort: absent headers/sockets yield null.
  const ip = clientIp(c);
  const device = c.req.header('user-agent')?.trim() || null;

  let orgName = body.orgName;
  if (!orgName) {
    const r = await pool.query<{ name: string }>(
      `SELECT name FROM orgs ORDER BY created_at ASC LIMIT 2`
    );
    if (r.rows.length === 0) {
      return c.json({ error: 'invalid' }, 401);
    }
    if (r.rows.length > 1) {
      // Multiple orgs and the SPA didn't tell us which one — force the
      // user to pick. The LoginPage will render the selector on the
      // next render.
      return c.json({ error: 'org_required' }, 400);
    }
    orgName = r.rows[0]!.name;
  }

  const key = `${orgName}:${body.username}`;
  if (!checkLoginRate(key)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  try {
    const { token, claims } = await authService.login(orgName, body.username, body.password);
    clearLoginAttempts(key);
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.Login,
    });
    // login_events is the per-attempt record of login activity (served via
    // /admin/audit?include=login); the audit_events row above still feeds
    // the plain audit feed. Recording is best-effort: a transient DB error
    // must not turn a successful login into a 500.
    try {
      await loginRecord.recordLogin(claims.orgId, claims.sub, ip, device, 'success');
    } catch {
      // Best-effort: the login itself succeeded; fall through to the token.
    }
    // Also establish a browser session cookie so org-restricted share pages
    // can authenticate in a plain browser (Phase 2). `secure` tracks the
    // request protocol; the node adapter is HTTP-only, so honor a
    // proxy-terminated HTTPS header when present.
    setSessionCookie(c, token, isSecureRequest(c));
    return c.json({ token });
  } catch (e) {
    if (e instanceof LoginFailed) {
      recordLoginFailure(key);
      // Record the attempt in login_events. LoginFailed does not carry
      // orgId/userId, so resolve them best-effort here: unknown org → skip
      // (the attempt can't be attributed); known org → always record
      // (user_id is null when the username is unknown). A recording
      // failure must not turn the 401 into a 500.
      try {
        const orgRow = await pool.query<{ id: string }>(
          `SELECT id FROM orgs WHERE name = $1`,
          [orgName]
        );
        const orgId = orgRow.rows[0]?.id;
        if (orgId) {
          const userRow = await pool.query<{ id: string }>(
            `SELECT id FROM users WHERE org_id = $1 AND username = $2`,
            [orgId, body.username]
          );
          await loginRecord.recordLogin(
            orgId,
            userRow.rows[0]?.id ?? null,
            ip,
            device,
            'failed'
          );
        }
      } catch {
        // Best-effort recording: fall through to the 401 either way.
      }
      return c.json({ error: 'invalid' }, 401);
    }
    throw e;
  }
});

authRoutes.post('/auth/logout', async (c) => {
  // Clears the browser session cookie for org-restricted share pages. It is
  // idempotent and does not require a valid token: the JWT is single-purpose
  // (re-validated by the server, never revoked), so logout is cookie hygiene
  // rather than token invalidation.
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.post('/auth/refresh', async (c) => {
  const h = c.req.header('authorization');
  if (!h?.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  try {
    const claims = await verifyToken(h.slice(7));
    // Re-read the user's current roles from the DB. Login-time roles are
    // frozen into the JWT, so a role granted (or revoked) by an admin via
    // PATCH /admin/users/:id never reaches the token until the user logs in
    // again. Without this, /auth/refresh re-signs the stale claims and the
    // desktop's /api/agent-marketplace keeps filtering out role-scoped agents.
    const urow = await pool.query<{ extra_roles: string[] | null }>(
      `SELECT extra_roles FROM users WHERE id = $1 AND org_id = $2`,
      [claims.sub, claims.orgId]
    );
    const roles = urow.rows[0] ? (urow.rows[0].extra_roles ?? []) : claims.roles;
    const token = await signToken({ ...claims, roles });
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.TokenRefresh,
    });
    return c.json({ token });
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
});