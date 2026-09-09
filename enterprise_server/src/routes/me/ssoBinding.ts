// enterprise_server/src/routes/me/ssoBinding.ts
// User-driven SSO self-binding half. `/me/sso-binding/start` initiates a
// fresh SSO flow scoped to the calling user (no pre-existing connection
// required) and parks a self_binding context in ssoLoginContextStore so
// finishSsoCallback knows to write the binding instead of fast-pathing.
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../../audit/auditStore';
import { requireAuth } from '../../auth/middleware';
import { pool } from '../../db/pool';
import { type SsoConnectionWithBinding } from '../../sso/bindingTypes';
import { getDesktopRedirectPort } from '../../sso/desktopRedirectPort';
import { resolveProviderLogoUrl } from '../../sso/logos';
import { buildAuthorizeUrl } from '../../sso/oauth';
import { type SsoLoginContext,ssoLoginContextStore } from '../../sso/ssoLoginContext';
import { createState } from '../../sso/state';
import { type SsoConnectionRow,STATE_TTL_MS } from '../../sso/types';

export const meSsoBindingRoutes = new Hono();
meSsoBindingRoutes.use('/me/sso-binding/*', requireAuth);
meSsoBindingRoutes.use('/me/sso-binding', requireAuth);

const startSchema = z.object({
  connectionId: z.string().min(1),
  returnTarget: z.enum(['console', 'desktop', 'web']).default('desktop'),
});

meSsoBindingRoutes.post('/me/sso-binding/start', async (c) => {
  const claims = c.get('claims');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = startSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const r = await pool.query<SsoConnectionRow & { org_id: string }>(
    `SELECT * FROM sso_connections WHERE id = $1 AND org_id = $2`,
    [parsed.data.connectionId, claims.orgId]
  );
  const conn = r.rows[0];
  if (!conn) return c.json({ error: 'connection_not_found' }, 404);
  if (!conn.enabled) return c.json({ error: 'connection_disabled' }, 409);

  // PKCE + state. Reuse the public authorize flow's contract.
  //
  // /me/sso-binding/start is reachable from both the desktop client and
  // the enterprise web admin console. The IdP's `redirect_uri` must
  // point at the right callback for the caller's `returnTarget`:
  //   - 'desktop'   → the desktop's loopback (`getDesktopRedirectPort()`)
  //   - 'web'       → the server's /auth/sso/bind-callback (which writes
  //                   the new token to localStorage AND sets
  //                   sessionStorage.ssoBindJustSucceeded, then redirects
  //                   to /account/sso-bindings — NOT /auth/sso/callback,
  //                   whose renderer drops the user on the dashboard
  //                   with no toast feedback).
  //   - 'console'   → the server's /auth/sso/callback (which writes the
  //                   token to localStorage and redirects to '/').
  // The state row's `returnTarget` lets finishSsoCallback choose the
  // right result shape (`web_self_binding_success` for 'web',
  // `{ token }` for 'console' / 'desktop').
  const origin = new URL(c.req.url).origin;
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = parsed.data.returnTarget === 'desktop'
    ? `http://localhost:${getDesktopRedirectPort()}/callback`
    : `${origin}/auth/sso/callback`;
  const { state } = await createState({
    orgId: conn.org_id, connectionId: conn.id, returnTarget: parsed.data.returnTarget,
    codeVerifier: verifier, redirectUri,
  });

  const expiresAt = new Date(Date.now() + STATE_TTL_MS);  // matches createState TTL
  const ctx: SsoLoginContext = {
    kind: 'self_binding',
    orgId: conn.org_id, connectionId: conn.id, userId: claims.sub,
    returnTarget: parsed.data.returnTarget,
    redirectUri, codeVerifier: verifier, expiresAt,
  };
  ssoLoginContextStore.set(state, ctx);

  const authorizeUrl = buildAuthorizeUrl(conn, state, challenge, redirectUri);

  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub, action: 'sso_user_binding_start',
    payload: { ssoConnectionId: conn.id },
  });
  return c.json({ authorizeUrl });
});

meSsoBindingRoutes.delete('/me/sso-binding', async (c) => {
  const claims = c.get('claims');
  // Capture before clearing for the audit payload.
  const before = await pool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(
    `SELECT sso_connection_id, sso_external_id FROM users WHERE id = $1 AND org_id = $2`,
    [claims.sub, claims.orgId]
  );
  await pool.query(
    `UPDATE users SET sso_connection_id = NULL, sso_external_id = NULL
      WHERE id = $1 AND org_id = $2`,
    [claims.sub, claims.orgId]
  );
  const prev = before.rows[0];
  if (prev?.sso_connection_id && prev.sso_external_id) {
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub, action: 'sso_user_self_unbound',
      payload: { ssoConnectionId: prev.sso_connection_id, externalId: prev.sso_external_id },
    });
  }
  return c.json({ ok: true });
});

// List every enabled SSO connection in the caller's org, annotated with
// the caller's binding status. Drives the desktop "SSO 账号绑定" page.
meSsoBindingRoutes.get('/me/sso-binding/connections', async (c) => {
  const claims = c.get('claims');
  const origin = new URL(c.req.url).origin;
  // One round-trip: pull enabled connections for the org, left-joined
  // to the caller's row keyed on the (sub, connection) match so the
  // `bound` flag and `external_id` line up per-connection. The
  // `org_id = c.org_id` guard on the join keeps the LEFT JOIN from
  // inflating `bound=true` for cross-org users.
  const r = await pool.query<{
    id: string;
    name: string;
    provider_type: string;
    sort_order: number;
    enabled: boolean;
    logo_url: string | null;
    bound: boolean;
    external_id: string | null;
  }>(
    `SELECT
       c.id, c.name, c.provider_type, c.sort_order, c.enabled, c.logo_url,
       (u.sso_connection_id IS NOT NULL) AS bound,
       u.sso_external_id AS external_id
     FROM sso_connections c
     LEFT JOIN users u
       ON u.id = $1
      AND u.org_id = c.org_id
      AND c.id = u.sso_connection_id
     WHERE c.org_id = $2
       AND c.enabled = true
     ORDER BY c.sort_order ASC, c.name ASC`,
    [claims.sub, claims.orgId]
  );
  const connections: SsoConnectionWithBinding[] = r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    sortOrder: row.sort_order,
    enabled: row.enabled,
    logoUrl: resolveProviderLogoUrl(row.logo_url, row.provider_type, origin),
    bound: row.bound,
    externalId: row.external_id,
  }));
  return c.json({ connections });
});
