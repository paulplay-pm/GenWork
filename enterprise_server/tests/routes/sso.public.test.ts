// enterprise_server/tests/routes/sso.public.test.ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

// Stub the network for the full authorize→callback dance (token exchange + userinfo).
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { Hono } from 'hono';
import { jwtVerify } from 'jose';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { ssoRoutes } from '../../src/routes/sso';
import { ssoLoginContextStore } from '../../src/sso/ssoLoginContext';

function buildApp(): Hono { const a = new Hono(); a.route('/', ssoRoutes); return a; }

describe('routes/sso — public half', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','Acme Co')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url, userinfo_url, client_id, scopes, enabled, sort_order, require_prebinding)
       VALUES ('c1','o1','Okta','generic-oidc','oidc','https://idp.example/a','https://idp.example/t','https://idp.example/u','cid','openid email', true, 0, false),
              ('c2','o1','Disabled','generic-oauth2','oauth2','https://x/a','https://x/t','https://x/u','cid2','', false, 1, false)`
    );
  });

  test('GET /auth/sso/providers returns only enabled, sorted, no secrets', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/providers?orgName=Acme Co');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { providers: Array<Record<string, unknown>> };
    expect(j.providers).toHaveLength(1);
    expect(j.providers[0]!.name).toBe('Okta');
    expect(j.providers[0]).not.toHaveProperty('client_id');
    expect(j.providers[0]).not.toHaveProperty('client_secret');
    // Each public provider carries a logoUrl the login UI can use as the
    // <img src> for the SSO button. A null/undefined logoUrl here would
    // leave the desktop and web login pages with no logo to render.
    expect(j.providers[0]).toHaveProperty('logoUrl');
  });

  test('public provider list surfaces per-connection logoUrl, falling back to built-in for known provider_type', async () => {
    // c1: explicit logo_url, c3: no logo_url, provider_type=feishu
    // (which has a built-in default). The public endpoint must resolve
    // either way and never leak the raw column null as the absence of a
    // logo.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url, userinfo_url, client_id, scopes, enabled, sort_order, require_prebinding, logo_url)
       VALUES ('c3','o1','Feishu Default','feishu','oidc','https://x/a','https://x/t','https://x/u','cid','', true, 2, false, NULL),
              ('c4','o1','Feishu Custom','feishu','oidc','https://y/a','https://y/t','https://y/u','cid','', true, 3, false, 'https://cdn.example/feishu.png')`
    );
    const a = buildApp();
    const res = await a.request('/auth/sso/providers?orgName=Acme Co');
    const j = (await res.json()) as {
      providers: Array<{ name: string; provider_type: string; logoUrl: string | null }>;
    };
    const byName = new Map(j.providers.map(p => [p.name, p]));
    // Okta (generic-oidc, no built-in) → null when no logo_url is set.
    expect(byName.get('Okta')!.logoUrl).toBeNull();
    // Feishu without logo_url → falls back to built-in default URL.
    expect(byName.get('Feishu Default')!.logoUrl).toMatch(/^https?:\/\//);
    // Feishu with explicit logo_url → that URL wins, not the default.
    expect(byName.get('Feishu Custom')!.logoUrl).toBe('https://cdn.example/feishu.png');
  });

  test('GET /auth/sso/:id/authorize 302s to IdP with PKCE + state', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/c1/authorize?orgName=Acme Co&return=console');
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('https://idp.example/a');
    expect(new URL(loc).searchParams.get('state')).toBeTruthy();
    expect(new URL(loc).searchParams.get('code_challenge')).toBeTruthy();
    expect(new URL(loc).searchParams.get('code_challenge_method')).toBe('S256');
  });

  test('GET /auth/sso/providers for unknown org returns empty list (404 to org lookup is acceptable; we pick 200+empty for UX)', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/providers?orgName=Nope');
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const j = (await res.json()) as { providers: unknown[] };
      expect(j.providers).toEqual([]);
    }
  });

  test('callback state is one-shot: replaying the same state returns sso_state_invalid, not a JWT', async () => {
    const a = buildApp();
    fetchMock.mockReset();
    // The single valid callback performs token exchange + userinfo.
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-1', email: 'a@x.com' }), { status: 200, headers: { 'content-type': 'application/json' } }));

    // Start the dance and capture the one-shot state from the IdP redirect.
    const auth = await a.request('/auth/sso/c1/authorize?orgName=Acme Co&return=console');
    expect(auth.status).toBe(302);
    const loc = new URL(auth.headers.get('location')!);
    const state = loc.searchParams.get('state')!;
    expect(state).toBeTruthy();

    // First callback: state consumed, token issued (JWT present in HTML).
    const first = await a.request(`/auth/sso/callback?state=${encodeURIComponent(state)}&code=CODE`);
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain('genwork.enterprise.auth.token');
    expect(firstHtml).toContain('eyJ'); // a real JWT (eyJ… is the base64 JWT header)

    // Replay with the SAME state: state already consumed → session-expired, no JWT.
    const second = await a.request(`/auth/sso/callback?state=${encodeURIComponent(state)}&code=CODE`);
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(secondHtml).toContain('sso_state_invalid');
    expect(secondHtml).not.toContain('eyJ');
  });

  test('GET /auth/sso/redirect-port returns the env-configured port', async () => {
    // The endpoint is the desktop's pre-flight read of the SSO callback
    // port. It must reflect whatever SSO_DESKTOP_REDIRECT_PORT resolves
    // to so the desktop and server agree on the IdP-facing redirect_uri.
    const prev = process.env.SSO_DESKTOP_REDIRECT_PORT;
    process.env.SSO_DESKTOP_REDIRECT_PORT = '61234';
    try {
      const a = buildApp();
      const res = await a.request('/auth/sso/redirect-port');
      expect(res.status).toBe(200);
      const j = (await res.json()) as { port: number };
      expect(j.port).toBe(61234);
    } finally {
      if (prev === undefined) delete process.env.SSO_DESKTOP_REDIRECT_PORT;
      else process.env.SSO_DESKTOP_REDIRECT_PORT = prev;
    }
  });

  test('GET /auth/sso/redirect-port falls back to the default when env is unset', async () => {
    // No env var set -> default 53231. The endpoint must NEVER return
    // null/undefined or 500; the desktop's pre-flight fetch would
    // otherwise wedge the login flow.
    const prev = process.env.SSO_DESKTOP_REDIRECT_PORT;
    delete process.env.SSO_DESKTOP_REDIRECT_PORT;
    try {
      const a = buildApp();
      const res = await a.request('/auth/sso/redirect-port');
      expect(res.status).toBe(200);
      const j = (await res.json()) as { port: number };
      expect(j.port).toBe(53231);
    } finally {
      if (prev !== undefined) process.env.SSO_DESKTOP_REDIRECT_PORT = prev;
    }
  });

  test('GET /auth/sso/redirect-port is public (no Authorization header required)', async () => {
    // The desktop has no session before login, so the endpoint must
    // accept requests without a Bearer token. A 401 here would mean the
    // middleware accidentally caught this path.
    const a = buildApp();
    const res = await a.request('/auth/sso/redirect-port');
    expect(res.status).not.toBe(401);
  });
});

describe('routes/sso — callback finalize after /auth/sso/bind', () => {
  beforeEach(async () => {
    ssoLoginContextStore.delete('st-ready');
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','Acme')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, enabled, sort_order, require_prebinding)
       VALUES ('c1','o1','Okta','generic-oidc','oidc','https://idp/a', true, 0, false)`
    );
  });

  test('ready_to_finalize entry in store yields token + clears store', async () => {
    const expires = new Date(Date.now() + 60_000);
    ssoLoginContextStore.set('st-ready', {
      kind: 'ready_to_finalize', orgId: 'o1', connectionId: 'c1',
      boundUserId: 'u-bound', externalId: 'ext-1',
      returnTarget: 'console',
      redirectUri: 'http://x', codeVerifier: 'v', expiresAt: expires,
    });
    const a = buildApp();
    const res = await a.request('/auth/sso/callback?code=C&state=st-ready');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/localStorage/);
    expect(html).toMatch(/eyJ/);  // jwt
    expect(ssoLoginContextStore.get('st-ready')).toBeUndefined();
  });

  test('ready_to_finalize finalizes without a code (post-bind returnTo) (regression: !code check ran before store check)', async () => {
    // Bind POST returns `returnTo = /auth/sso/callback?state=…` with NO
    // `code` query param (the original code was already exchanged in the
    // first callback hit, and the state row was DELETE-RETURNINGed by
    // consumeState). The store check MUST run before the `!code`
    // validation; otherwise the user is redirected to
    // /login?error=sso_invalid_request after a successful bind.
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash)
       VALUES ('u-bind','o1','binduser','x')`
    );
    const expires = new Date(Date.now() + 60_000);
    ssoLoginContextStore.set('st-bind-done', {
      kind: 'ready_to_finalize', orgId: 'o1', connectionId: 'c1',
      boundUserId: 'u-bind', externalId: 'ext-1',
      returnTarget: 'console',
      redirectUri: 'http://x', codeVerifier: 'v', expiresAt: expires,
    });
    const a = buildApp();
    // Note: NO `code` query param. This is the exact URL the bind POST
    // form redirects to via `location.assign(j.returnTo)`.
    const res = await a.request('/auth/sso/callback?state=st-bind-done');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/localStorage/);
    expect(html).toMatch(/eyJ/);  // jwt
    expect(ssoLoginContextStore.get('st-bind-done')).toBeUndefined();
  });

  test('ready_to_finalize finalize preserves extra_roles (no admin downgrade)', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, extra_roles)
       VALUES ('u-admin','o1','admin','x','["org_admin"]'::jsonb)`
    );
    const expires = new Date(Date.now() + 60_000);
    ssoLoginContextStore.set('st-admin', {
      kind: 'ready_to_finalize', orgId: 'o1', connectionId: 'c1',
      boundUserId: 'u-admin', externalId: 'ext-1',
      returnTarget: 'console',
      redirectUri: 'http://x', codeVerifier: 'v', expiresAt: expires,
    });
    const a = buildApp();
    const res = await a.request('/auth/sso/callback?code=C&state=st-admin');
    expect(res.status).toBe(200);
    const html = await res.text();
    // The token's roles must carry the user's extra_roles, not the legacy
    // [Role.User] hardcode — an org_admin completing their first strict-mode
    // bind+login must not be downgraded.
    const m = html.match(/localStorage\.setItem\('genwork\.enterprise\.auth\.token', '([^']+)'\)/);
    expect(m).toBeTruthy();
    const { payload } = await jwtVerify(m![1], new TextEncoder().encode(process.env.JWT_SECRET!));
    expect(payload.sub).toBe('u-admin');
    expect((payload as { roles?: string[] }).roles).toEqual(['org_admin']);
  });

  test('ready_to_finalize finalize for desktop returnTarget redirects token to loopback', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u-d','o1','d','x')`
    );
    const expires = new Date(Date.now() + 60_000);
    ssoLoginContextStore.set('st-desk', {
      kind: 'ready_to_finalize', orgId: 'o1', connectionId: 'c1',
      boundUserId: 'u-d', externalId: 'ext-1',
      returnTarget: 'desktop', redirectUri: 'http://localhost:53231/callback',
      codeVerifier: 'v', expiresAt: expires,
    });
    const a = buildApp();
    const res = await a.request('/auth/sso/callback?code=C&state=st-desk');
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('http://localhost:53231/callback?token=');
    expect(new URL(loc).searchParams.get('token')).toContain('eyJ');
  });

  test('no store entry + no state row → existing sso_state_invalid path', async () => {
    const a = buildApp();
    const res = await a.request('/auth/sso/callback?code=C&state=unknown');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/sso_state_invalid/);
  });

  // ---- web self_binding half: /auth/sso/callback handles the
  // returnTarget='web' shape the user-facing /me/sso-binding/start flow
  // parks. The single registered IdP callback URL serves both the
  // console login flow and the web self-binding flow; the route
  // discriminates on the parked context's returnTarget so the admin
  // does NOT need to register a second URL with the IdP (which would
  // trigger Feishu 20029 on any org that hasn't registered the new
  // URL — see the regression test below).
  describe('web self_binding via /auth/sso/callback (returnTarget=web)', () => {
    // Park a self_binding context for `u-current` against connection
    // c1, with the given returnTarget. The state row is created via
    // createState so consumeState is happy.
    const parkSelfBinding = async (userId: string, returnTarget: 'web' | 'console'): Promise<string> => {
      await testPool.query(
        `INSERT INTO users(id, org_id, username, password_hash)
         VALUES ($1,'o1','u-x','x') ON CONFLICT (id) DO NOTHING`,
        [userId],
      );
      const verifier = 'verifier-' + Math.random().toString(36).slice(2);
      const { state } = await (
        await import('../../src/sso/state')
      ).createState({
        orgId: 'o1', connectionId: 'c1', returnTarget, codeVerifier: verifier,
        redirectUri: 'http://localhost/auth/sso/callback',
      });
      const expires = new Date(Date.now() + 60_000);
      ssoLoginContextStore.set(state, {
        kind: 'self_binding', orgId: 'o1', connectionId: 'c1', userId,
        returnTarget, redirectUri: 'http://localhost/auth/sso/callback',
        codeVerifier: verifier, expiresAt: expires,
      });
      return state;
    };

    // Mock the IdP dance: token exchange + userinfo returning the
    // requested externalId. Same fetchMock order the existing
    // finishCallbackSelfBinding tests use.
    const mockIdpDance = (externalId: string): void => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'AT' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ sub: externalId }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    };

    test('success path → HTML writes new token to localStorage + ssoBindJustSucceeded + redirects to /account/sso-bindings', async () => {
      const state = await parkSelfBinding('u-current', 'web');
      mockIdpDance('ext-alice');
      const a = buildApp();
      const res = await a.request(`/auth/sso/callback?code=C&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // The page's mount-time useEffect reads sessionStorage.ssoBindJustSucceeded
      // and dispatches the 绑定成功 toast. Without the success flag, the user
      // would land on the page with no feedback that the bind completed.
      expect(html).toMatch(/sessionStorage\.setItem\('ssoBindJustSucceeded',\s*'1'\)/);
      // The new token must land in localStorage (same key the SPA's auth
      // store reads on init — see web/src/auth/store.ts:readStoredSession).
      const m = html.match(/localStorage\.setItem\('genwork\.enterprise\.auth\.token',\s*'([^']+)'\)/);
      expect(m).toBeTruthy();
      expect(m![1]).toMatch(/^eyJ/);
      // Redirect is to /account/sso-bindings, NOT '/' (which would dump
      // the user on the dashboard with no toast).
      expect(html).toMatch(/location\.assign\('\/account\/sso-bindings'\)/);
    });

    test('error path (bind_external_id_exists) → ssoBindError flag set + redirect with ?error=bind_external_id_exists', async () => {
      // Park a self_binding for u-current (creates u-current in the DB),
      // then insert u-other and pre-bind them to the same externalId
      // the IdP will return — the pre-check fires bind_external_id_exists.
      const state = await parkSelfBinding('u-current', 'web');
      await testPool.query(
        `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id)
         VALUES ('u-other','o1','bob','x','c1','ext-bob') ON CONFLICT (id) DO NOTHING`,
      );
      mockIdpDance('ext-bob');  // IdP returns bob's externalId → pre-check fires
      const a = buildApp();
      const res = await a.request(`/auth/sso/callback?code=C&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/sessionStorage\.setItem\('ssoBindError',\s*'bind_external_id_exists'\)/);
      // Redirect carries ?error= in the URL (deep-link fallback for non-JS).
      expect(html).toMatch(/location\.assign\('\/account\/sso-bindings\?error=bind_external_id_exists'\)/);
      // The other user's binding is preserved (no row mutation).
      const other = await testPool.query<{ sso_connection_id: string; sso_external_id: string }>(
        `SELECT sso_connection_id, sso_external_id FROM users WHERE id='u-other'`,
      );
      expect(other.rows[0]?.sso_external_id).toBe('ext-bob');
    });

    test('IdP ?error=access_denied → ssoBindError=sso_access_denied (web path)', async () => {
      const state = await parkSelfBinding('u-current', 'web');
      const a = buildApp();
      const res = await a.request(
        `/auth/sso/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/sessionStorage\.setItem\('ssoBindError',\s*'sso_access_denied'\)/);
      expect(html).toMatch(/location\.assign\('\/account\/sso-bindings\?error=sso_access_denied'\)/);
    });

    test('console returnTarget still uses renderConsoleCallbackHtml (regression: web branch must not hijack console flow)', async () => {
      const state = await parkSelfBinding('u-current', 'console');
      mockIdpDance('ext-alice');
      const a = buildApp();
      const res = await a.request(`/auth/sso/callback?code=C&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // Console flow redirects to '/' (the dashboard), NOT
      // /account/sso-bindings. The web branch's redirect would mean a
      // console login lands the user on the SSO bindings page instead
      // of the dashboard, which is wrong.
      expect(html).toMatch(/location\.assign\('\/'\)/);
      // And NO ssoBindJustSucceeded flag (the console flow does not bind).
      expect(html).not.toMatch(/ssoBindJustSucceeded/);
    });
  });
});
