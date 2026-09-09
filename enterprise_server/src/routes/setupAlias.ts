import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';

import { signToken } from '../auth/jwt';
import { invitationService } from '../setup/invitationService';
import { Role } from '../shared/enterpriseServerConstants';
import { pool } from '../db/pool';
import { seedBuiltinProviders } from '../org/builtinProviders';

/**
 * SPA-driven setup surface at /api/setup/*. The whole router is hard-closed
 * (HTTP 410) once any org has `setup_completed_at` set, except for `/status`
 * which the SPA polls to decide whether to render the setup wizard or
 * redirect to /login.
 *
 * The flow is three steps:
 *   1. POST /start with { orgName } → server creates the org, mints a fresh
 *      invite code, returns { orgId, orgName, code, expiresAt }.
 *   2. The user enters username + password.
 *   3. POST /redeem with { orgId, code, username, password } → server
 *      creates the first super-admin inside a transaction that also flips
 *      `orgs.setup_completed_at` to now(), then signs a JWT and returns
 *      { userId, token, orgId, orgName } so the SPA can skip a separate
 *      /auth/login round-trip.
 */
export const setupAliasRoutes = new Hono();

/**
 * Hard-closure middleware. Runs before every handler below. /status is
 * exempt so the SPA can still detect "setup already done" and bounce to
 * /login instead of showing a broken wizard.
 *
 * The router is mounted at /api/setup, so inside the middleware the
 * `c.req.path` is the suffix (e.g. `/status`, `/start`, `/redeem`).
 */
setupAliasRoutes.use('*', async (c, next) => {
  // /status is exempt so the SPA can still detect "setup already done" and
  // bounce to /login instead of showing a broken wizard. Match by suffix
  // because the router is mounted under /api/setup and `c.req.path` here
  // is the full URL path (e.g. /api/setup/status).
  if (c.req.path.endsWith('/status')) return next();
  const r = await pool.query<{ one: number }>(
    'SELECT 1 AS one FROM orgs WHERE setup_completed_at IS NOT NULL LIMIT 1'
  );
  if (r.rows.length > 0) {
    return c.json({ error: 'setup_closed' }, 410);
  }
  return next();
});

setupAliasRoutes.get('/status', async (c) => {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM users) AS exists`
  );
  const p = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM init_invitations
     WHERE status='pending' AND expires_at > now()`
  );
  const closed = await pool.query<{ at: Date | null }>(
    `SELECT setup_completed_at AS at FROM orgs
     WHERE setup_completed_at IS NOT NULL
     ORDER BY setup_completed_at DESC LIMIT 1`
  );
  return c.json({
    superAdminExists: r.rows[0]?.exists ?? false,
    hasPendingInvite: Number(p.rows[0]?.count ?? '0') > 0,
    setupCompletedAt: closed.rows[0]?.at ? closed.rows[0]!.at!.toISOString() : null,
  });
});

/**
 * Mint the first org + first invite code. orgName is the user-visible
 * identity (login is by name); the server picks a random `org-<8hex>` id
 * and never shows it to the user. INSERT uses ON CONFLICT DO NOTHING so
 * a refresh mid-flow doesn't fail. If the org already existed (name
 * collision, retried request, etc.) we surface 409 with a clear error.
 */
setupAliasRoutes.post('/start', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { orgName?: unknown };
  const orgName = typeof body.orgName === 'string' ? body.orgName.trim() : '';
  if (orgName.length < 1 || orgName.length > 64) {
    return c.json({ error: 'invalid_org_name' }, 400);
  }
  const orgId = `org-${randomBytes(4).toString('hex')}`;

  let inserted = false;
  try {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO orgs(id, name) VALUES ($1, $2) RETURNING id`,
      [orgId, orgName]
    );
    inserted = r.rows.length > 0;
  } catch (e) {
    // Postgres unique-violation on orgs_name_unique.
    if (
      e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505'
    ) {
      return c.json({ error: 'duplicate_org_name' }, 409);
    }
    throw e;
  }

  if (!inserted) {
    // Should not happen with RETURNING — defensive only.
    return c.json({ error: 'org_create_failed' }, 500);
  }

  // Seed the 9 built-in providers + models so a fresh org matches an upgraded one.
  await seedBuiltinProviders(orgId);

  const inv = await invitationService.rotate(orgId);
  return c.json({
    orgId,
    orgName,
    code: inv.code,
    expiresAt: inv.expiresAt.toISOString(),
  });
});

/**
 * Create the first super-admin and close setup. The transaction inside
 * invitationService.redeem writes users + init_invitations.status +
 * orgs.setup_completed_at atomically; on the next request the hard-
 * closure middleware will start returning 410.
 */
setupAliasRoutes.post('/redeem', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    orgId?: unknown;
    code?: unknown;
    username?: unknown;
    password?: unknown;
  };
  if (
    typeof body.orgId !== 'string' ||
    typeof body.code !== 'string' ||
    typeof body.username !== 'string' ||
    typeof body.password !== 'string'
  ) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  try {
    const userId = await invitationService.redeem(body.code, {
      orgId: body.orgId,
      username: body.username,
      password: body.password,
    });
    const orgRow = await pool.query<{ name: string }>(
      `SELECT name FROM orgs WHERE id = $1`,
      [body.orgId]
    );
    const orgName = orgRow.rows[0]?.name ?? '';
    const token = await signToken({
      sub: userId,
      orgId: body.orgId,
      roles: [Role.SuperAdmin],
    });
    return c.json({ userId, token, orgId: body.orgId, orgName });
  } catch {
    return c.json({ error: 'invitation_unavailable' }, 410);
  }
});
