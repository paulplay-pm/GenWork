// enterprise_server/tests/me/ssoBinding.test.ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { meSsoBindingRoutes } from '../../src/routes/me/ssoBinding';
import { Role } from '../../src/shared/enterpriseServerConstants';
import { ssoLoginContextStore } from '../../src/sso/ssoLoginContext';

function buildApp(): Hono {
  const a = new Hono();
  // Apply auth the same way the real mount does.
  a.use('/me/*', async (c, next) => {
    const auth = c.req.header('authorization');
    if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthenticated' }, 401);
    const token = auth.slice(7);
    try {
      const { jwtVerify } = await import('jose');
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
      const { payload } = await jwtVerify(token, secret);
      c.set('claims', { sub: payload.sub as string, orgId: payload.orgId as string, roles: (payload.roles as string[]) ?? [] });
      await next();
    } catch { return c.json({ error: 'unauthenticated' }, 401); }
  });
  a.route('/', meSsoBindingRoutes);
  return a;
}

async function tokenFor(userId: string, orgId: string): Promise<string> {
  return signToken({ sub: userId, orgId, roles: [Role.User] });
}

describe('routes/me/ssoBinding', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    ssoLoginContextStore.delete('st-sb');
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, enabled, sort_order, require_prebinding)
       VALUES ('c1','o1','Acme','generic-oidc','oidc','https://idp/a', true, 0, false)`
    );
  });

  test('start, no auth → 401', async () => {
    const res = await buildApp().request('/me/sso-binding/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId: 'c1' }) });
    expect(res.status).toBe(401);
  });

  test('start, valid → 200 {authorizeUrl}, store entry kind=self_binding, sso_login_states row inserted, audit', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ connectionId: 'c1' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { authorizeUrl: string };
    expect(j.authorizeUrl).toMatch(/^https:\/\/idp\/a\?/);
    expect(j.authorizeUrl).toMatch(/response_type=code/);
    // Lock in Ruling 14: /me/sso-binding/start must produce an authorize URL
    // whose `redirect_uri` points at the desktop's loopback (so the IdP
    // redirects the OS browser back to the desktop and the bind completes),
    // NOT the server's own /auth/sso/callback (which would log the user into
    // the web admin instead of finishing the bind).
    const redirectUri = new URL(j.authorizeUrl).searchParams.get('redirect_uri');
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(redirectUri).not.toMatch(/\/auth\/sso\/callback/);
    // The state row's returnTarget must be 'desktop' so the server's
    // /auth/sso/callback finalize branch hands the token to the loopback
    // rather than rendering it into the browser.
    const state = new URL(j.authorizeUrl).searchParams.get('state')!;
    const ssoState = await testPool.query<{ return_target: string; phase: string }>(
      `SELECT return_target, phase FROM sso_login_states WHERE state = $1`, [state]
    );
    expect(ssoState.rows[0]?.return_target).toBe('desktop');
    // Lock in Ruling 2: the in-memory ssoLoginContextStore — not the row's
    // `phase` column — is the source of truth for the self_binding context.
    // createState must therefore leave the column at its migration 043 default.
    expect(ssoState.rows[0]?.phase).toBe('sso_completed');
    const ctx = ssoLoginContextStore.get(state);
    expect(ctx?.kind).toBe('self_binding');
    if (ctx?.kind === 'self_binding') expect(ctx.userId).toBe('u1');
    const audit = await testPool.query(`SELECT 1 FROM audit_events WHERE action='sso_user_binding_start' AND user_id='u1'`);
    expect(audit.rowCount).toBe(1);
  });

  test('start, returnTarget=web → authorizeUrl redirect_uri is the shared /auth/sso/callback (IdP-registered)', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ connectionId: 'c1', returnTarget: 'web' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { authorizeUrl: string };
    const redirectUri = new URL(j.authorizeUrl).searchParams.get('redirect_uri');
    // The web flow's IdP redirect_uri MUST point at the URL the org admin
    // already registered in the IdP developer console — /auth/sso/callback,
    // which is the same URL the console login flow uses. The admin only
    // registers one web URL with the IdP; using a different URL here
    // triggers Feishu 20029 "redirect_uri mismatch" and the bind never
    // completes. The callback handler (sso.ts) routes on the parked
    // context's returnTarget === 'web' to render the post-bind HTML
    // (localStorage token + sessionStorage.ssoBindJustSucceeded +
    // redirect to /account/sso-bindings).
    expect(redirectUri).toMatch(/\/auth\/sso\/callback$/);
    // Should NOT be the desktop's loopback (which carries a port).
    expect(redirectUri).not.toMatch(/^http:\/\/localhost:\d+\/callback$/);
    // Parked context's returnTarget is 'web'
    const state = new URL(j.authorizeUrl).searchParams.get('state')!;
    const ctx = ssoLoginContextStore.get(state);
    expect(ctx?.kind).toBe('self_binding');
    if (ctx?.kind === 'self_binding') expect(ctx.returnTarget).toBe('web');
  });

  test('start, connectionId 跨 org → 404 connection_not_found', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2','Other')`);
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ connectionId: 'c1-cross' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe('connection_not_found');
  });

  test('start, connection disabled → 409 connection_disabled', async () => {
    await testPool.query(`UPDATE sso_connections SET enabled=false WHERE id='c1'`);
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ connectionId: 'c1' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('connection_disabled');
  });

  test('start, user already bound → still allowed (overwrite path); authorizeUrl returned', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','u1','x','c1','ext-old','[]'::jsonb)`
    );
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ connectionId: 'c1' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { authorizeUrl: string };
    expect(j.authorizeUrl).toMatch(/^https:\/\/idp\/a\?/);
  });

  test('DELETE, no auth → 401', async () => {
    const res = await buildApp().request('/me/sso-binding', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  test('DELETE, with binding → 200, clears users.sso_*, audit; user_idp_identities untouched', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','u1','x','c1','ext-1','[]'::jsonb)`
    );
    await testPool.query(
      `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
       VALUES ('id-1','o1','u1','c1','ext-1')`
    );
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding', { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const u = await testPool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(`SELECT sso_connection_id, sso_external_id FROM users WHERE id='u1'`);
    expect(u.rows[0]).toEqual({ sso_connection_id: null, sso_external_id: null });
    const ids = await testPool.query(`SELECT 1 FROM user_idp_identities WHERE user_id='u1' AND sso_connection_id='c1' AND external_id='ext-1'`);
    expect(ids.rowCount).toBe(1);  // preserved
    const audit = await testPool.query(`SELECT 1 FROM audit_events WHERE action='sso_user_self_unbound' AND user_id='u1'`);
    expect(audit.rowCount).toBe(1);
  });

  test('DELETE, no binding → 200 (idempotent)', async () => {
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1','o1','u1','x')`);
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding', { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });
});
