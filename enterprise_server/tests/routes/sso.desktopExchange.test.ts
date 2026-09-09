// enterprise_server/tests/routes/sso.desktopExchange.test.ts
// Desktop-bridge endpoint the loopback forwards IdP callbacks to.
// Production bug being fixed: the GenWork desktop's loopback server only
// resolves `?token=…` / `?error=…`, so when an OIDC IdP (Feishu, Okta,
// …) redirects the browser back with `?code=…&state=…`, the loopback
// silently ignores it and the probe never settles. The fix lives here:
// the desktop POSTs the codes to /auth/sso/desktop/exchange, the server
// runs finishSsoCallback's existing logic, returns a JWT, and the
// loopback self-302s with `?token=` so the existing probe can settle.
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { Hono } from 'hono';
import { jwtVerify } from 'jose';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { ssoRoutes } from '../../src/routes/sso';

function buildApp(): Hono { const a = new Hono(); a.route('/', ssoRoutes); return a; }

describe('routes/sso — desktop exchange', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','Acme Co')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
         authorize_url, token_url, userinfo_url, client_id, scopes, enabled, sort_order, require_prebinding)
       VALUES ('c1','o1','Okta','generic-oidc','oidc',
               'https://idp.example/a','https://idp.example/t','https://idp.example/u',
               'cid','openid email', true, 0, false),
              ('c-strict','o1','Strict','generic-oidc','oidc',
               'https://idp.example/a','https://idp.example/t','https://idp.example/u',
               'cid','openid email', true, 1, true)`
    );
    fetchMock.mockReset();
  });

  test('success: state row exists, code exchanges, user JIT-provisions, returns token', async () => {
    // Insert a state row directly (mimics the prior authorize call).
    await testPool.query(
      `INSERT INTO sso_login_states(state, org_id, sso_connection_id, return_target, code_verifier, redirect_uri, expires_at)
       VALUES ('s1','o1','c1','desktop','v','http://localhost:53231/callback', now() + interval '5 minutes')`
    );
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-1', email: 'a@x.com' }), { status: 200 }));

    const a = buildApp();
    const res = await a.request('/auth/sso/desktop/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'CODE', state: 's1' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { token: string };
    expect(j.token).toMatch(/^eyJ/);
    const { payload } = await jwtVerify(j.token, new TextEncoder().encode(process.env.JWT_SECRET!));
    expect(payload.sub).toBeTruthy();  // JIT'd user
    // state row consumed
    const after = await testPool.query<{ state: string }>(`SELECT state FROM sso_login_states WHERE state='s1'`);
    expect(after.rowCount).toBe(0);
  });

  test('strict-mode unbound: returns 409 pendingBind with bindUrl', async () => {
    await testPool.query(
      `INSERT INTO sso_login_states(state, org_id, sso_connection_id, return_target, code_verifier, redirect_uri, expires_at)
       VALUES ('s-strict','o1','c-strict','desktop','v','http://localhost:53231/callback', now() + interval '5 minutes')`
    );
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-new', email: 'a@x.com' }), { status: 200 }));

    const a = buildApp();
    const res = await a.request('/auth/sso/desktop/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'CODE', state: 's-strict' }),
    });
    expect(res.status).toBe(409);
    const j = await res.json() as { status: string; bindUrl: string; connectionName: string };
    expect(j.status).toBe('pending_bind');
    expect(j.bindUrl).toBe('/bind-sso?state=s-strict');
    expect(j.connectionName).toBe('Strict');
  });

  test('missing state row: returns 400 state_invalid (no crash)', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/desktop/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'CODE', state: 'never-existed' }),
    });
    expect(res.status).toBe(400);
    const j = await res.json() as { error: string };
    expect(j.error).toBe('state_invalid');
  });

  test('malformed body: returns 400 invalid_request', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/desktop/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '' }),
    });
    expect(res.status).toBe(400);
  });
});
