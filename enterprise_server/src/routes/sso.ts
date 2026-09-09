// enterprise_server/src/routes/sso.ts
// SSO member-login federation routes.
//   Public (pre-login) half: providers listing, authorize, console callback.
//   Desktop half: desktop callback to a random-port loopback (state-gated).
//   Admin half: SSO connection CRUD behind PP.SsoView/SsoCreate/SsoEdit.
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../audit/auditStore';
import { signToken } from '../auth/jwt';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import { Role } from '../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../shared/permissionPoints';
import {
  renderConsoleCallbackHtml,
  renderWebBindCallbackHtml,
  renderWebBindErrorHtml,
} from '../sso/consoleCallback';
import { getDesktopRedirectPort, resolveDesktopRedirectPort } from '../sso/desktopRedirectPort';
import { finishSsoCallback } from '../sso/finishCallback';
import { resolveProviderLogoUrl } from '../sso/logos';
import { buildAuthorizeUrl } from '../sso/oauth';
import { ssoLoginContextStore } from '../sso/ssoLoginContext';
import { consumeState, createState } from '../sso/state';
import type { SsoConnectionRow, SsoPublicProvider } from '../sso/types';
import {
  encryptClientSecret,
  maskClientSecret,
  redactConnectionSecrets,
} from '../vault/ssoSecret';
import { ssoDesktopExchangeRoutes } from './sso/desktopExchange';

export const ssoRoutes = new Hono();

// Mount the public desktop bridge the loopback forwards IdP callbacks
// to. Kept separate from the rest of ssoRoutes so it can be added
// without disturbing the mount order / auth gating around other routes.
ssoRoutes.route('/', ssoDesktopExchangeRoutes);

// ---- Public (pre-login) listing ----

// The desktop fetches this BEFORE starting the OAuth dance so the
// `redirect_uri` it sends to the IdP is always aligned with the value
// the server (and the desktop, on its own loopback) will use. Keeping
// the server as the single source of truth means an admin changes the
// port in `enterprise_server/.env` once and every desktop gets the
// new value next login — no per-machine config. Public (no auth) on
// purpose: the desktop cannot have a session before login, and the
// value is non-sensitive (it is also visible in the `redirect_uri`
// the server embeds in the IdP-facing authorize URL).
ssoRoutes.get('/auth/sso/redirect-port', (c) => {
  return c.json({ port: getDesktopRedirectPort() });
});

ssoRoutes.get('/auth/sso/providers', async (c) => {
  const orgName = c.req.query('orgName');
  if (!orgName) return c.json({ providers: [] }, 400);
  const r = await pool.query<{ id: string; name: string; provider_type: string; sort_order: number; logo_url: string | null }>(
    `SELECT sc.id, sc.name, sc.provider_type, sc.sort_order, sc.logo_url
     FROM sso_connections sc JOIN orgs o ON o.id = sc.org_id
     WHERE o.name = $1 AND sc.enabled = true
     ORDER BY sc.sort_order ASC, sc.created_at ASC`,
    [orgName]
  );
  // The logo URL is resolved per-row: an explicit per-connection
  // `logo_url` wins, otherwise the server falls back to the built-in
  // default for the provider_type. The desktop and web login pages
  // expect an absolute URL (or null) here so they can drop it straight
  // into an <img src> without a base-url config.
  const origin = new URL(c.req.url).origin;
  const providers: SsoPublicProvider[] = r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider_type: row.provider_type,
    sort_order: row.sort_order,
    logoUrl: resolveProviderLogoUrl(row.logo_url, row.provider_type, origin),
  }));
  return c.json<{ providers: SsoPublicProvider[] }>({ providers });
});

// ---- Authorize (start the dance) ----

ssoRoutes.get('/auth/sso/:id/authorize', async (c) => {
  const id = c.req.param('id');
  const orgName = c.req.query('orgName');
  const returnTarget = (c.req.query('return') === 'desktop' ? 'desktop' : 'console') as 'console' | 'desktop';
  if (!orgName) return c.json({ error: 'orgName_required' }, 400);

  // Select the FULL connection row: buildAuthorizeUrl reads client_id/scopes
  // in addition to authorize_url/protocol/enabled.
  const r = await pool.query<SsoConnectionRow & { org_id: string }>(
    `SELECT sc.*
     FROM sso_connections sc JOIN orgs o ON o.id = sc.org_id
     WHERE sc.id = $1 AND o.name = $2`,
    [id, orgName]
  );
  const conn = r.rows[0];
  if (!conn || !conn.enabled || !conn.authorize_url || conn.protocol === 'saml2') {
    return c.json({ error: 'unknown_connection' }, 404);
  }

  // PKCE: 64-byte verifier → S256 challenge.
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  // Desktop redirect_uri is FIXED, not random. The IdP (Feishu, Okta,
  // etc.) compares redirect_uri as a literal string against the
  // Authorized redirect URI list registered on the enterprise app; a
  // random per-attempt port would make the IdP reject the authorize
  // request with error 20029 ("重定向 URL 有误"). The desktop binds this
  // same port (see src/main/sso/genericSsoLogin.ts) — the value
  // comes from the server's SSO_DESKTOP_REDIRECT_PORT (loaded from
  // enterprise_server/.env) and the desktop fetches it via
  // GET /auth/sso/redirect-port. `desktop_port` is still accepted as a
  // query param for backward compatibility, but the server ignores it
  // and uses the fixed value. The fallback URL (port-less) is kept
  // for the case where SSO_DESKTOP_REDIRECT_PORT resolves to an
  // invalid value, so a misconfigured deployment still 404s at the IdP
  // instead of crashing the API.
  const resolved = resolveDesktopRedirectPort();
  const redirectUri =
    returnTarget === 'desktop'
      ? (resolved.port !== null
          ? `http://localhost:${resolved.port}/callback`
          : 'http://localhost/callback')
      : `${new URL(c.req.url).origin}/auth/sso/callback`;

  const { state } = await createState({
    orgId: conn.org_id, connectionId: id, returnTarget, codeVerifier: verifier, redirectUri,
  });
  return c.redirect(buildAuthorizeUrl(conn, state, challenge, redirectUri), 302);
});

// ---- Console callback (server-rendered HTML) ----
//
// This single URL serves three call paths, all of which the org admin
// registers ONCE in the IdP developer console:
//   1. Member login (returnTarget: 'console') → redirect to '/'.
//   2. Two-stage bind+login (returnTarget: 'console'|'desktop' via the
//      ready_to_finalize store entry, see /auth/sso/bind).
//   3. Web self-binding (returnTarget: 'web' from /me/sso-binding/start)
//      → writes the new JWT to localStorage, sets
//      sessionStorage.ssoBindJustSucceeded='1', redirects to
//      /account/sso-bindings. The page's mount-time useEffect dispatches
//      the matching toast.
// The state row's `returnTarget` is the discriminator; we resolve it
// after consumeState so the routes stay correct even if a future
// returnTarget is added.
ssoRoutes.get('/auth/sso/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
  const error = c.req.query('error');

  // Peek the parked context for IdP error routing. consumeState is
  // one-shot, so we MUST check the store before consuming the state row
  // on the error path. If we don't know returnTarget (e.g. stale state
  // with no parked context), fall back to the console login flow.
  const peekedCtx = state ? ssoLoginContextStore.get(state) : undefined;
  const isWeb = peekedCtx?.returnTarget === 'web';

  if (error) {
    const code = `sso_${error}`;
    if (isWeb) {
      return c.html(renderWebBindErrorHtml({ code }));
    }
    return c.html(renderConsoleCallbackHtml({ token: '', redirectTo: '/login?error=' + code, errorMessage: error }));
  }

  // NEW (post-bind): after /auth/sso/bind completes, the bind POST returns
  // `returnTo = /auth/sso/callback?state=…` with NO `code` query param (the
  // original code was already exchanged in the first callback hit, and the
  // state row has been DELETE-RETURNINGed by consumeState). The store carries
  // the boundUserId across the two-step flow.
  //
  // The store check MUST run before the `!code` validation below, because
  // the post-bind callback has no `code` (the bind page's
  //   location.assign(j.returnTo)
  // sets only `?state=…`). If we validated `!code` first, every successful
  // two-stage bind would redirect the user to /login?error=sso_invalid_request
  // instead of issuing the token.
  if (state) {
    const ctx = ssoLoginContextStore.get(state);
    if (ctx?.kind === 'ready_to_finalize') {
      ssoLoginContextStore.delete(state);
      // Read the user's extra_roles so a first strict-mode bind+login does not
      // downgrade an org_admin (the same roles fix the self_binding branch and
      // strict-mode fast path already apply).
      const roleRes = await pool.query<{ extra_roles: string[] | null }>(
        `SELECT extra_roles FROM users WHERE id = $1 AND org_id = $2`, [ctx.boundUserId, ctx.orgId]
      );
      const roles = roleRes.rows[0]?.extra_roles ?? [Role.User];
      const token = await signToken({ sub: ctx.boundUserId, orgId: ctx.orgId, roles });
      // A desktop-originated two-stage flow must hand the token to the loopback
      // the desktop is still polling (genericSsoLogin.ts), not render it into
      // the browser's localStorage (which the desktop never reads).
      if (ctx.returnTarget === 'desktop') {
        const base = ctx.redirectUri || 'http://localhost/callback';
        const sep = base.includes('?') ? '&' : '?';
        return c.redirect(`${base}${sep}token=${encodeURIComponent(token)}`, 302);
      }
      return c.html(renderConsoleCallbackHtml({ token, redirectTo: '/' }));
    }
  }

  if (!state || !code) {
    if (isWeb) {
      return c.html(renderWebBindErrorHtml({ code: 'bind_invalid_request' }));
    }
    return c.html(renderConsoleCallbackHtml({ token: '', redirectTo: '/login?error=sso_invalid_request', errorMessage: 'invalid request' }));
  }

  const consumed = await consumeState(state);
  if (!consumed) {
    if (isWeb) {
      return c.html(renderWebBindErrorHtml({ code: 'bind_invalid_request' }));
    }
    return c.html(renderConsoleCallbackHtml({ token: '', redirectTo: '/login?error=sso_state_invalid', errorMessage: 'session expired' }));
  }

  // Hand off to the JIT + token-issuance service (implemented in Task 10).
  const result = await finishSsoCallback({ code, state: consumed, redirectUri: consumed.redirectUri ?? '' });
  if ('pendingBind' in result) {
    return c.redirect(`/bind-sso?state=${encodeURIComponent(state)}`, 302);
  }
  if ('error' in result) {
    if (consumed.returnTarget === 'web') {
      return c.html(renderWebBindErrorHtml({ code: result.error }));
    }
    return c.html(renderConsoleCallbackHtml({ token: '', redirectTo: '/login?error=' + result.error }));
  }
  // Success shape: web returns { kind: 'web_self_binding_success', token, ... };
  // console / desktop return { token }.
  if ('kind' in result && result.kind === 'web_self_binding_success') {
    return c.html(renderWebBindCallbackHtml({ token: result.token, redirectTo: '/account/sso-bindings' }));
  }
  return c.html(renderConsoleCallbackHtml({ token: result.token, redirectTo: '/' }));
});

// ---- Desktop callback (random-port loopback; target URL stored in state) ----

// Deprecated in production flow: the production desktop now POSTs the
// `code + state` pair to `POST /auth/sso/desktop/exchange` (see
// ./sso/desktopExchange.ts) instead of letting the IdP redirect the
// browser straight here. Reasons the POST was added:
//   * the loopback host's OAuth probe only resolves `?token=` /
//     `?error=` query params and would otherwise ignore the IdP's
//     `?code=…&state=…` redirect, hanging the login flow until timeout;
//   * keeping the PKCE code exchange server-side means the desktop
//     never touches client_secret and the secret never appears in a
//     browser-visible redirect URI.
// This handler is preserved only as a fallback for ad-hoc browser-direct
// testing (e.g. `curl`-driven dance against the loopback). Existing
// tests in tests/routes/sso.desktop.test.ts still rely on it.
ssoRoutes.get('/auth/sso/desktop/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
  if (!state || !code) return c.json({ error: 'invalid_request' }, 400);
  const consumed = await consumeState(state);
  if (!consumed) return c.json({ error: 'state_invalid' }, 400);
  // The actual loopback target (INCLUDING the port the desktop chose) was
  // stored on the state row at authorize time — redirect to it in BOTH the
  // error and success paths so the desktop always learns the outcome.
  const base = consumed.redirectUri || 'http://localhost/callback';
  const sep = base.includes('?') ? '&' : '?';
  const result = await finishSsoCallback({ code, state: consumed, redirectUri: base });
  // P1 does not implement the two-stage flow for desktop; an unbound strict-mode
  // identity is sent to the web /bind-sso page to complete binding in the browser
  // (spec §7.2) rather than a loopback redirect carrying a bogus ?token=.
  if ('pendingBind' in result) {
    return c.redirect(`/bind-sso?state=${encodeURIComponent(state)}`, 302);
  }
  if ('error' in result) {
    return c.redirect(`${base}${sep}error=${encodeURIComponent(result.error)}`, 302);
  }
  return c.redirect(`${base}${sep}token=${encodeURIComponent(result.token)}`, 302);
});

// ---- Admin CRUD (SsoView / SsoCreate / SsoEdit) ----

// Full connection column list (same set as src/sso/finishCallback.ts).
const COLS = `id, org_id, name, provider_type, protocol, authorize_url, token_url, userinfo_url, client_id, client_secret_encrypted, client_secret_masked, scopes, identity_id_field, login_name_field, email_field, email_domain_whitelist, require_prebinding, logo_url, enabled, sort_order, created_by, created_at, updated_at`;

const baseSchema = z.object({
  orgId: z.string(),
  name: z.string().min(1).max(100),
  providerType: z.enum(['generic-oidc','generic-oauth2','azure-ad','feishu','dingtalk','wecom','saml2']),
  protocol: z.enum(['oidc','oauth2','saml2']),
  authorizeUrl: z.string().optional().default(''),
  tokenUrl: z.string().optional().default(''),
  userinfoUrl: z.string().optional().default(''),
  clientId: z.string().optional().default(''),
  clientSecret: z.string().optional().default(''),  // blank = keep
  scopes: z.string().optional().default(''),
  identityIdField: z.string().min(1).default('sub'),
  loginNameField: z.string().optional().default(''),
  emailField: z.string().min(1).default('email'),
  emailDomainWhitelist: z.array(z.string()).default([]),
  // The per-connection logo is uploaded via POST /admin/sso-connections/:id/logo
  // and cleared via DELETE on the same path; it is NOT part of the JSON
  // create/patch body.
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  // require_prebinding column default is `true` since migration 044; the
  // zod default must match so a request body that omits the field agrees
  // with what the DB row would otherwise be populated with. Without this
  // alignment, an admin POST without `requirePrebinding` would land a
  // false row and silently downgrade the new strict-by-default behavior.
  requirePrebinding: z.boolean().default(true),
});
const patchSchema = baseSchema.partial().extend({ orgId: z.string().optional() });
type PatchData = z.infer<typeof patchSchema>;

ssoRoutes.use('/admin/sso-connections/*', requireAuth);

ssoRoutes.get('/admin/sso-connections', requirePermission(PP.SsoView), async (c) => {
  const claims = c.get('claims');
  const r = await pool.query(
    `SELECT ${COLS} FROM sso_connections WHERE org_id = $1 ORDER BY sort_order ASC, created_at ASC`,
    [claims.orgId]
  );
  return c.json(r.rows.map((row) => redactConnectionSecrets(row as Record<string, unknown>)));
});

ssoRoutes.post('/admin/sso-connections', requirePermission(PP.SsoCreate), async (c) => {
  const claims = c.get('claims');
  const parsed = baseSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  if (parsed.data.orgId !== claims.orgId) return c.json({ error: 'org_mismatch' }, 400);
  const id = randomUUID();
  const secretEnc = parsed.data.clientSecret ? encryptClientSecret(parsed.data.clientSecret) : null;
  const secretMask = parsed.data.clientSecret ? maskClientSecret(parsed.data.clientSecret) : null;
  await pool.query(
    `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url, userinfo_url, client_id, client_secret_encrypted, client_secret_masked, scopes, identity_id_field, login_name_field, email_field, email_domain_whitelist, require_prebinding, enabled, sort_order, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20)`,
    [id, claims.orgId, parsed.data.name, parsed.data.providerType, parsed.data.protocol,
     parsed.data.authorizeUrl || null, parsed.data.tokenUrl || null, parsed.data.userinfoUrl || null,
     parsed.data.clientId || null, secretEnc, secretMask, parsed.data.scopes || null,
     parsed.data.identityIdField, parsed.data.loginNameField || null, parsed.data.emailField,
     JSON.stringify(parsed.data.emailDomainWhitelist), parsed.data.requirePrebinding, parsed.data.enabled, parsed.data.sortOrder, claims.sub]
  );
  await auditStore.write({ orgId: claims.orgId, userId: claims.sub, action: 'sso_connection_create', targetType: 'sso_connection', targetId: id, payload: { name: parsed.data.name } });
  return c.json({ id }, 201);
});

ssoRoutes.get('/admin/sso-connections/:id', requirePermission(PP.SsoView), async (c) => {
  const claims = c.get('claims');
  const r = await pool.query(`SELECT ${COLS} FROM sso_connections WHERE id = $1 AND org_id = $2`, [c.req.param('id'), claims.orgId]);
  if (!r.rowCount) return c.json({ error: 'not_found' }, 404);
  return c.json(redactConnectionSecrets(r.rows[0] as Record<string, unknown>));
});

ssoRoutes.patch('/admin/sso-connections/:id', requirePermission(PP.SsoEdit), async (c) => {
  const claims = c.get('claims');
  const parsed = patchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const existing = await pool.query(`SELECT ${COLS} FROM sso_connections WHERE id = $1 AND org_id = $2`, [c.req.param('id'), claims.orgId]);
  if (!existing.rowCount) return c.json({ error: 'not_found' }, 404);
  const row = existing.rows[0] as Record<string, unknown>;
  // Seed a camelCase base from the live row so a partial patch only
  // overrides the fields actually sent (zod omits absent keys; the row's
  // columns are snake_case). clientSecret stays blank as a sentinel:
  // blank/absent keeps the stored secret. The per-connection logo is
  // managed by separate /logo endpoints, so PATCH does not touch it.
  const prev: PatchData = {
    name: row.name as string,
    providerType: row.provider_type as PatchData['providerType'],
    protocol: row.protocol as PatchData['protocol'],
    authorizeUrl: (row.authorize_url as string | null) ?? '',
    tokenUrl: (row.token_url as string | null) ?? '',
    userinfoUrl: (row.userinfo_url as string | null) ?? '',
    clientId: (row.client_id as string | null) ?? '',
    clientSecret: '',
    scopes: (row.scopes as string | null) ?? '',
    identityIdField: row.identity_id_field as string,
    loginNameField: (row.login_name_field as string | null) ?? '',
    emailField: row.email_field as string,
    emailDomainWhitelist: (row.email_domain_whitelist as string[] | null) ?? [],
    enabled: row.enabled as boolean,
    sortOrder: row.sort_order as number,
    requirePrebinding: row.require_prebinding as boolean,
  };
  const merged: PatchData = { ...prev, ...parsed.data };
  const secretEnc = parsed.data.clientSecret ? encryptClientSecret(parsed.data.clientSecret) : (row.client_secret_encrypted as string | null) ?? null;
  const secretMask = parsed.data.clientSecret
    ? maskClientSecret(parsed.data.clientSecret)
    : (row.client_secret_masked as string | null) ?? null;
  await pool.query(
    `UPDATE sso_connections SET
       name = $1, provider_type = $2, protocol = $3,
       authorize_url = $4, token_url = $5, userinfo_url = $6,
       client_id = $7, client_secret_encrypted = $8, client_secret_masked = $9,
       scopes = $10, identity_id_field = $11, login_name_field = $12,
       email_field = $13, email_domain_whitelist = $14::jsonb,
       require_prebinding = $15, enabled = $16, sort_order = $17, updated_at = now()
     WHERE id = $18 AND org_id = $19`,
    [merged.name, merged.providerType, merged.protocol,
     merged.authorizeUrl || null, merged.tokenUrl || null, merged.userinfoUrl || null,
     merged.clientId || null, secretEnc, secretMask,
     merged.scopes || null, merged.identityIdField, merged.loginNameField || null,
     merged.emailField, JSON.stringify(merged.emailDomainWhitelist),
     merged.requirePrebinding, merged.enabled, merged.sortOrder, c.req.param('id'), claims.orgId]
  );
  await auditStore.write({ orgId: claims.orgId, userId: claims.sub, action: 'sso_connection_update', targetType: 'sso_connection', targetId: c.req.param('id'), payload: { changedKeys: Object.keys(parsed.data) } });
  return c.json({ ok: true });
});

ssoRoutes.delete('/admin/sso-connections/:id', requirePermission(PP.SsoEdit), async (c) => {
  const claims = c.get('claims');
  const r = await pool.query(
    `UPDATE sso_connections SET enabled = false, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING id`,
    [c.req.param('id'), claims.orgId]
  );
  if (!r.rowCount) return c.json({ error: 'not_found' }, 404);
  await auditStore.write({ orgId: claims.orgId, userId: claims.sub, action: 'sso_connection_disable', targetType: 'sso_connection', targetId: c.req.param('id') });
  return c.json({ ok: true });
});
