// enterprise_server/tests/routes/sso.desktop.test.ts
// Desktop (random-port loopback) half of the SSO dance:
//   authorize accepts desktop_port and stores the loopback URL (WITH the
//   actual port) on the state row, and the desktop callback 302-redirects
//   the JWT back to that stored URL. A port-less hardcoded redirect
//   (port 80, nothing listening) would never reach the desktop.
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

// Stub the network for the full authorize→callback exchange (token exchange + userinfo).
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { Hono } from 'hono';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { ssoRoutes } from '../../src/routes/sso';

function buildApp(): Hono { const a = new Hono(); a.route('/', ssoRoutes); return a; }

describe('routes/sso — desktop callback', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','Acme Co')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url, userinfo_url, client_id, scopes, enabled, sort_order)
       VALUES ('c1','o1','Okta','generic-oidc','oidc','https://idp.example/a','https://idp.example/t','https://idp.example/u','cid','openid email', true, 0)`
    );
    fetchMock.mockReset();
    // Pin the configured SSO_DESKTOP_REDIRECT_PORT so the existing
    // assertions (which expect the default 53231) hold. Tests that
    // exercise overrides explicitly set/restore their own value. The
    // two dedicated tests below cover the "deliberately unset" and
    // "out-of-range" paths.
    process.env.SSO_DESKTOP_REDIRECT_PORT = '53231';
  });

  test('desktop callback 302s the JWT to the STORED loopback port', async () => {
    const a = buildApp();

    // Start the dance. The desktop_port query param is accepted for
    // backward compatibility but the server ignores it and uses the
    // fixed SSO_DESKTOP_REDIRECT_PORT (default 53231). The IdP compares
    // redirect_uri as a literal string, so a random port would be
    // rejected with error 20029.
    const auth = await a.request('/auth/sso/c1/authorize?orgName=Acme Co&return=desktop&desktop_port=51999');
    expect(auth.status).toBe(302);
    const idp = new URL(auth.headers.get('location')!);
    expect(idp.hostname).toBe('idp.example');
    const state = idp.searchParams.get('state')!;
    expect(state).toBeTruthy();

    // The loopback URL (with the FIXED port) is sent to the IdP as
    // redirect_uri and stored on the state row it just created. The
    // desktop binds the same port (src/main/sso/genericSsoLogin.ts).
    expect(idp.searchParams.get('redirect_uri')).toBe('http://localhost:53231/callback');
    const row = await testPool.query<{ state: string; return_target: string; redirect_uri: string | null }>(
      `SELECT state, return_target, redirect_uri FROM sso_login_states WHERE state = $1`,
      [state]
    );
    expect(row.rows[0]?.return_target).toBe('desktop');
    expect(row.rows[0]?.redirect_uri).toBe('http://localhost:53231/callback');

    // Complete the IdP dance: token exchange + userinfo.
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-1', email: 'a@x.com' }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const cb = await a.request(`/auth/sso/desktop/callback?state=${encodeURIComponent(state)}&code=CODE`);
    expect(cb.status).toBe(302);
    const loc = cb.headers.get('location')!;
    // The redirect MUST use the stored port — a hardcoded
    // `http://localhost/callback` (port 80) would fail this assertion.
    expect(loc).toContain('http://localhost:53231/callback?token=');
    const token = new URL(loc).searchParams.get('token')!;
    expect(token).toContain('eyJ'); // a real JWT, not an error string
  });

  test('desktop_port query param is ignored — server always uses the fixed port', async () => {
    // Different desktop_port values must all resolve to the same
    // redirect_uri (the fixed port), so the IdP's allow-list (which
    // contains a single literal entry) always matches.
    const a = buildApp();
    for (const dp of ['51999', '11111', '60000']) {
      const r = await a.request(`/auth/sso/c1/authorize?orgName=Acme Co&return=desktop&desktop_port=${dp}`);
      expect(r.status).toBe(302);
      const idp = new URL(r.headers.get('location')!);
      expect(idp.searchParams.get('redirect_uri')).toBe('http://localhost:53231/callback');
    }
  });

  test('SSO_DESKTOP_REDIRECT_PORT env var overrides the fixed port', async () => {
    // Deployments that collide on 53231 can pick their own port. The
    // server's redirect_uri MUST follow the override, otherwise the
    // IdP will reject the authorize request.
    const prev = process.env.SSO_DESKTOP_REDIRECT_PORT;
    process.env.SSO_DESKTOP_REDIRECT_PORT = '61234';
    try {
      const a = buildApp();
      const r = await a.request('/auth/sso/c1/authorize?orgName=Acme Co&return=desktop&desktop_port=51999');
      expect(r.status).toBe(302);
      const idp = new URL(r.headers.get('location')!);
      expect(idp.searchParams.get('redirect_uri')).toBe('http://localhost:61234/callback');
    } finally {
      if (prev === undefined) delete process.env.SSO_DESKTOP_REDIRECT_PORT;
      else process.env.SSO_DESKTOP_REDIRECT_PORT = prev;
    }
  });

  test('out-of-range SSO_DESKTOP_REDIRECT_PORT falls back to the port-less URL', async () => {
    // If the env var is set to a non-integer or out-of-range value, the
    // server should still respond (with the port-less fallback) rather
    // than crashing the authorize request.
    const prev = process.env.SSO_DESKTOP_REDIRECT_PORT;
    process.env.SSO_DESKTOP_REDIRECT_PORT = 'not-a-port';
    try {
      const a = buildApp();
      const r = await a.request('/auth/sso/c1/authorize?orgName=Acme Co&return=desktop&desktop_port=51999');
      expect(r.status).toBe(302);
      const idp = new URL(r.headers.get('location')!);
      expect(idp.searchParams.get('redirect_uri')).toBe('http://localhost/callback');
    } finally {
      if (prev === undefined) delete process.env.SSO_DESKTOP_REDIRECT_PORT;
      else process.env.SSO_DESKTOP_REDIRECT_PORT = prev;
    }
  });

  test('authorize with a missing or invalid desktop_port stores the port-less fallback', async () => {
    const a = buildApp();

    // No port param at all → still uses the fixed default (53231).
    // The previous behavior (port-less fallback) was needed when the
    // port came from the query string; now the server always has a
    // valid port, so the fallback only triggers for a misconfigured
    // env var (covered by a separate test below).
    const noPort = await a.request('/auth/sso/c1/authorize?orgName=Acme Co&return=desktop');
    expect(noPort.status).toBe(302);
    const stateA = new URL(noPort.headers.get('location')!).searchParams.get('state')!;
    const rowA = await testPool.query<{ redirect_uri: string | null }>(
      `SELECT redirect_uri FROM sso_login_states WHERE state = $1`, [stateA]
    );
    expect(rowA.rows[0]?.redirect_uri).toBe('http://localhost:53231/callback');

    // Garbage port query param is also ignored — the server still uses
    // the fixed default. (Previously this hit the port-less fallback.)
    const badPort = await a.request('/auth/sso/c1/authorize?orgName=Acme Co&return=desktop&desktop_port=notaport');
    expect(badPort.status).toBe(302);
    const idpB = new URL(badPort.headers.get('location')!);
    expect(idpB.searchParams.get('redirect_uri')).toBe('http://localhost:53231/callback');
    const stateB = idpB.searchParams.get('state')!;
    const rowB = await testPool.query<{ redirect_uri: string | null }>(
      `SELECT redirect_uri FROM sso_login_states WHERE state = $1`, [stateB]
    );
    expect(rowB.rows[0]?.redirect_uri).toBe('http://localhost:53231/callback');
  });

  test('desktop callback with an unknown state returns 400 state_invalid', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/desktop/callback?state=unknown&code=CODE');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'state_invalid' });
  });

  test('desktop callback with missing params returns 400 invalid_request', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/desktop/callback');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });
});
