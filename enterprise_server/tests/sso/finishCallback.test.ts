// enterprise_server/tests/sso/finishCallback.test.ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

// Stub the network: token exchange + userinfo return canned values.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { type JWTPayload,jwtVerify, SignJWT } from 'jose';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { finishSsoCallback } from '../../src/sso/finishCallback';
import { ssoLoginContextStore } from '../../src/sso/ssoLoginContext';
import { consumeState,createState } from '../../src/sso/state';
import { encryptClientSecret } from '../../src/vault/ssoSecret';

describe('sso/finishCallback', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','Acme')`);
    // require_prebinding=false is explicit: migration 044 flipped the DB
    // default to true, but these tests exercise the legacy JIT / resolveUser
    // path, which only runs when the strict gate is off.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
         authorize_url, token_url, userinfo_url, client_id, scopes,
         identity_id_field, email_field, require_prebinding, email_domain_whitelist)
       VALUES ('c1','o1','Acme','generic-oidc','oidc',
               'https://idp/a','https://idp/t','https://idp/u','cid','openid email',
               'sub','email', false, '[]'::jsonb)`
    );
    fetchMock.mockReset();
  });

  test('issues a JWT for a brand-new user and binds the identity', async () => {
    fetchMock
      // token exchange
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200, headers: { 'content-type':'application/json' } }))
      // userinfo
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-1', email: 'a@x.com', preferred_username: 'a' }), { status: 200, headers: { 'content-type':'application/json' } }));

    const { state } = await createState({ orgId: 'o1', connectionId: 'c1', returnTarget: 'console', codeVerifier: 'verifier' });
    const consumed = await consumeState(state);
    expect(consumed).not.toBeNull();
    const r = await finishSsoCallback({ code: 'CODE', state: consumed!, redirectUri: 'http://localhost/cb' });
    expect('token' in r).toBe(true);
    const u = await testPool.query<{ username: string; email: string }>(`SELECT username, email FROM users WHERE org_id='o1'`);
    expect(u.rows[0]).toEqual({ username: 'a', email: 'a@x.com' });
  });

  test('returns error when token exchange fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 500 }));
    const { state } = await createState({ orgId: 'o1', connectionId: 'c1', returnTarget: 'console' });
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'C', state: consumed!, redirectUri: 'http://x' });
    expect('error' in r).toBe(true);
  });

  // ---- ID-token (confidential client) branch: R14 guard + R13a aud + field mapping ----

  const SHARED_SECRET = 'a-shared-secret-of-sufficient-length';

  // A second, confidential connection (client secret at rest) so the ID-token
  // branch is exercised without touching the existing secret-less c1 tests.
  // require_prebinding=false: same reasoning as the c1 INSERT above.
  async function seedSecretConnection(): Promise<void> {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
         authorize_url, token_url, userinfo_url, client_id, client_secret_encrypted, scopes,
         identity_id_field, login_name_field, email_field, require_prebinding, email_domain_whitelist)
       VALUES ('c2','o1','Secret IdP','generic-oidc','oidc',
               'https://idp2/a','https://idp2/t','https://idp2/u','cid',
               $1,'openid email','sub','preferred_username','email', false, '[]'::jsonb)`,
      [encryptClientSecret(SHARED_SECRET)]
    );
  }

  function signIdToken(claims: JWTPayload): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(SHARED_SECRET));
  }

  test('verifies the ID token (awaited) and maps identity from its claims', async () => {
    await seedSecretConnection();
    const idToken = await signIdToken({ sub: 'ext-id', email: 'prefname2@x.com', preferred_username: 'prefname', aud: 'cid' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT', id_token: idToken }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const { state } = await createState({ orgId: 'o1', connectionId: 'c2', returnTarget: 'console', codeVerifier: 'verifier' });
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'CODE', state: consumed!, redirectUri: 'http://localhost/cb' });
    expect('token' in r).toBe(true);
    // Exactly ONE fetch: token exchange only — the verified id_token was the
    // identity source, not userinfo. (A missing `await verifyIdToken` would
    // leave `identity` as a Promise → `missing_external_id` → no token.)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // username comes from login_name_field (preferred_username), email from
    // email_field — both from the verified payload, and the two values differ
    // so the email local-part cannot masquerade as the username.
    const u = await testPool.query<{ username: string; email: string }>(`SELECT username, email FROM users WHERE org_id='o1'`);
    expect(u.rows[0]).toEqual({ username: 'prefname', email: 'prefname2@x.com' });
  });

  test('rejects an ID token whose aud does not match the connection client_id', async () => {
    await seedSecretConnection();
    const idToken = await signIdToken({ sub: 'ext-id', email: 'a@x.com', preferred_username: 'a', aud: 'other-client' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT', id_token: idToken }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const { state } = await createState({ orgId: 'o1', connectionId: 'c2', returnTarget: 'console', codeVerifier: 'verifier' });
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'CODE', state: consumed!, redirectUri: 'http://localhost/cb' });
    expect(r).toEqual({ error: 'id_token_aud_mismatch' });
  });

  test('rejects a state whose org does not match the connection (unknown_connection)', async () => {
    // sso_login_states.org_id is unconstrained, so a state claiming org 'o2'
    // is insertable even though connection c1 belongs to org 'o1'. The
    // connection reload is scoped by id AND org_id, so it must not resolve.
    const { state } = await createState({ orgId: 'o2', connectionId: 'c1', returnTarget: 'console' });
    const consumed = await consumeState(state);
    expect(consumed).not.toBeNull();
    const r = await finishSsoCallback({ code: 'C', state: consumed!, redirectUri: 'http://x' });
    expect(r).toEqual({ error: 'unknown_connection' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('JWT carries the user extra_roles (org_admin), not a hardcoded user role', async () => {
    // Seed an existing member promoted to the builtin org_admin role with a
    // bound IdP identity (2a path), so finishSsoCallback resolves the
    // existing user and MUST sign the user's actual roles into the JWT.
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, email, extra_roles)
       VALUES ('u_promo','o1','promo','x','a@x.com','["org_admin"]'::jsonb)`
    );
    await testPool.query(
      `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
       VALUES ('b1','o1','u_promo','c1','ext-1')`
    );
    fetchMock
      // token exchange
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      // userinfo
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-1', email: 'a@x.com', preferred_username: 'a' }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const { state } = await createState({ orgId: 'o1', connectionId: 'c1', returnTarget: 'console', codeVerifier: 'verifier' });
    const consumed = await consumeState(state);
    expect(consumed).not.toBeNull();
    const r = await finishSsoCallback({ code: 'CODE', state: consumed!, redirectUri: 'http://localhost/cb' });
    expect('token' in r).toBe(true);
    const { payload } = await jwtVerify((r as { token: string }).token, new TextEncoder().encode(process.env.JWT_SECRET!));
    expect(payload.sub).toBe('u_promo');
    expect((payload as { roles?: string[] }).roles).toContain('org_admin');
  });
});

describe('finishCallback — strict-mode gate', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','Acme')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
         authorize_url, token_url, userinfo_url, client_id, scopes,
         identity_id_field, email_field, email_domain_whitelist)
       VALUES ('c1','o1','Acme','generic-oidc','oidc',
               'https://idp/a','https://idp/t','https://idp/u','cid','openid email',
               'sub','email','[]'::jsonb)`
    );
    fetchMock.mockReset();
    ssoLoginContextStore.delete('st1');
    ssoLoginContextStore.delete('st2');
  });

  async function seedStrictConnection(require = true): Promise<void> {
    await testPool.query(
      `UPDATE sso_connections SET require_prebinding = $1 WHERE id = 'c1'`,
      [require]
    );
  }

  async function createStateFor(): Promise<Awaited<ReturnType<typeof createState>>> {
    return createState({ orgId: 'o1', connectionId: 'c1', returnTarget: 'console' });
  }

  test('require_prebinding=false: identity not in users.sso_* still goes through resolveUser (regression)', async () => {
    await seedStrictConnection(false);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200, headers: { 'content-type':'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-fresh', email: 'f@x.com', preferred_username: 'f' }), { status: 200, headers: { 'content-type':'application/json' } }));
    const { state } = await createStateFor();
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'C', state: consumed!, redirectUri: 'http://x' });
    expect('token' in r).toBe(true);
  });

  test('require_prebinding=true: bound to active user issues a token and writes user_idp_identities', async () => {
    await seedStrictConnection(true);
    // Pre-bind a user with (c1, 'ext-bound').
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u-bound','o1','bob','x','c1','ext-bound','[]'::jsonb)`
    );
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-bound', email: 'b@x.com' }), { status: 200 }));
    const { state } = await createStateFor();
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'C', state: consumed!, redirectUri: 'http://x' });
    expect('token' in r).toBe(true);
    const ids = await testPool.query(`SELECT 1 FROM user_idp_identities WHERE user_id='u-bound' AND sso_connection_id='c1' AND external_id='ext-bound'`);
    expect(ids.rowCount).toBe(1);
  });

  test('require_prebinding=true: bound to disabled user returns user_disabled', async () => {
    await seedStrictConnection(true);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, status, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u-d','o1','d','x','disabled','c1','ext-d','[]'::jsonb)`
    );
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-d', email: 'd@x.com' }), { status: 200 }));
    const { state } = await createStateFor();
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'C', state: consumed!, redirectUri: 'http://x' });
    expect(r).toEqual({ error: 'user_disabled' });
  });

  test('require_prebinding=true: unbound identity parks state with kind=pending_bind and returns pendingBind', async () => {
    await seedStrictConnection(true);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-new', email: 'n@x.com', preferred_username: 'n' }), { status: 200 }));
    const { state } = await createStateFor();
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'C', state: consumed!, redirectUri: 'http://x' });
    expect('pendingBind' in r).toBe(true);
    if ('pendingBind' in r) {
      expect(r.pendingBind.providerType).toBe('generic-oidc');
      expect(r.pendingBind.externalId).toBe('ext-new');
    }
    const ctx = ssoLoginContextStore.get(state);
    expect(ctx?.kind).toBe('pending_bind');
    if (ctx?.kind === 'pending_bind') {
      expect(ctx.externalId).toBe('ext-new');
      expect(ctx.orgId).toBe('o1');
    }
    // Audit
    const audit = await testPool.query<{ payload: any }>(
      `SELECT payload FROM audit_events WHERE action='sso_login_failed' AND org_id='o1' ORDER BY ts DESC LIMIT 1`
    );
    expect(audit.rows[0]?.payload).toMatchObject({ reason: 'sso_login_pending_bind' });
  });
});

// ---- self_binding branch (§4.3) ----

describe('finishCallback — self_binding branch', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','Acme')`);
    // c1 is the default-mode connection: migration 044 flipped the DB
    // default to true, but this describe exercises the self_binding
    // branch which is gated on `phase`/store shape, not on the strict
    // flag. Pin c1 to require_prebinding=false explicitly so the
    // non-strict self-binding test below lands in the right code path.
    // The strict self-binding test creates its own c2 with the flag set.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
         authorize_url, token_url, userinfo_url, client_id, scopes,
         identity_id_field, email_field, require_prebinding, email_domain_whitelist)
       VALUES ('c1','o1','Acme','generic-oidc','oidc',
               'https://idp/a','https://idp/t','https://idp/u','cid','openid email',
               'sub','email', false, '[]'::jsonb)`
    );
    fetchMock.mockReset();
    ssoLoginContextStore.delete('st-sb');
  });

  test('non-strict self-binding: writes users.sso_*, inserts identity, transitions store to ready_to_finalize, audits', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, extra_roles)
       VALUES ('u1','o1','u1','x','["org_admin"]'::jsonb)`
    );
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-sb', email: 'sb@x.com' }), { status: 200 }));

    const { state } = await createState({ orgId: 'o1', connectionId: 'c1', returnTarget: 'console' });
    // Park the self_binding ctx at the SAME state key the SSO callback will
    // pass back via `?state=`. finishSsoCallback looks up ssoLoginContextStore
    // with state.state, so the key has to match.
    ssoLoginContextStore.set(state, {
      kind: 'self_binding', orgId: 'o1', connectionId: 'c1', userId: 'u1',
      redirectUri: 'http://localhost/cb', codeVerifier: 'v',
      returnTarget: 'console',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const consumed = await consumeState(state);
    expect(consumed).not.toBeNull();
    const r = await finishSsoCallback({ code: 'CODE', state: consumed!, redirectUri: 'http://localhost/cb' });

    // The exact FinishResult variant the implementation chose (see report).
    expect('token' in r).toBe(true);

    // users.sso_* written for u1.
    const u = await testPool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(
      `SELECT sso_connection_id, sso_external_id FROM users WHERE id='u1'`
    );
    expect(u.rows[0]).toEqual({ sso_connection_id: 'c1', sso_external_id: 'ext-sb' });

    // user_idp_identities inserted.
    const ids = await testPool.query(
      `SELECT 1 FROM user_idp_identities WHERE user_id='u1' AND sso_connection_id='c1' AND external_id='ext-sb'`
    );
    expect(ids.rowCount).toBe(1);

    // Store entry either transitioned to ready_to_finalize OR cleared; accept either
    // because the brief's allowed FinishResult variants differ. We assert the bind
    // succeeded, the store entry is no longer 'self_binding', and — when the
    // implementation chose to transition — boundUserId === 'u1'.
    const ctxAfter = ssoLoginContextStore.get(state);
    if (ctxAfter?.kind === 'ready_to_finalize') {
      expect(ctxAfter.boundUserId).toBe('u1');
    } else {
      expect(ctxAfter).toBeUndefined();
    }

    // Ruling 6 resolution: roles from extra_roles are signed into the JWT.
    const { payload } = await jwtVerify((r as { token: string }).token, new TextEncoder().encode(process.env.JWT_SECRET!));
    expect(payload.sub).toBe('u1');
    expect((payload as { roles?: string[] }).roles).toEqual(['org_admin']);

    // Audit row with source='self_binding'.
    const audit = await testPool.query<{ payload: any }>(
      `SELECT payload FROM audit_events WHERE action='sso_user_self_bound' AND user_id='u1' ORDER BY ts DESC LIMIT 1`
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.payload).toMatchObject({
      ssoConnectionId: 'c1',
      externalId: 'ext-sb',
      source: 'self_binding',
    });
  });

  test('strict self-binding: still writes the binding (self_binding branch precedes strict-mode gate)', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol,
         authorize_url, token_url, userinfo_url, client_id, scopes,
         identity_id_field, email_field, email_domain_whitelist, require_prebinding)
       VALUES ('c2','o1','Strict','generic-oidc','oidc',
               'https://idp2/a','https://idp2/t','https://idp2/u','cid2','openid email',
               'sub','email','[]'::jsonb, true)`
    );
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, extra_roles)
       VALUES ('u2','o1','u2','x','[]'::jsonb)`
    );
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-s', email: 's@x.com' }), { status: 200 }));

    const { state } = await createState({ orgId: 'o1', connectionId: 'c2', returnTarget: 'console' });
    ssoLoginContextStore.set(state, {
      kind: 'self_binding', orgId: 'o1', connectionId: 'c2', userId: 'u2',
      redirectUri: 'http://localhost/cb', codeVerifier: 'v',
      returnTarget: 'console',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'CODE', state: consumed!, redirectUri: 'http://localhost/cb' });

    expect('pendingBind' in r).toBe(false);
    expect('token' in r).toBe(true);

    const u = await testPool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(
      `SELECT sso_connection_id, sso_external_id FROM users WHERE id='u2'`
    );
    expect(u.rows[0]).toEqual({ sso_connection_id: 'c2', sso_external_id: 'ext-s' });
  });

  test('disabled user: returns user_disabled, no binding written, no identity row', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, status, extra_roles)
       VALUES ('u-d','o1','d','x','disabled','[]'::jsonb)`
    );
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'ext-d', email: 'd@x.com' }), { status: 200 }));

    const { state } = await createState({ orgId: 'o1', connectionId: 'c1', returnTarget: 'console' });
    ssoLoginContextStore.set(state, {
      kind: 'self_binding', orgId: 'o1', connectionId: 'c1', userId: 'u-d',
      redirectUri: 'http://localhost/cb', codeVerifier: 'v',
      returnTarget: 'console',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const consumed = await consumeState(state);
    const r = await finishSsoCallback({ code: 'CODE', state: consumed!, redirectUri: 'http://localhost/cb' });

    expect(r).toEqual({ error: 'user_disabled' });

    const u = await testPool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(
      `SELECT sso_connection_id, sso_external_id FROM users WHERE id='u-d'`
    );
    expect(u.rows[0]).toEqual({ sso_connection_id: null, sso_external_id: null });
    const ids = await testPool.query(
      `SELECT 1 FROM user_idp_identities WHERE user_id='u-d'`
    );
    expect(ids.rowCount).toBe(0);
  });
});
