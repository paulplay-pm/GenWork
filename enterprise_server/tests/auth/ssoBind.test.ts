// enterprise_server/tests/auth/ssoBind.test.ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { hashPassword } from '../../src/auth/password';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { ssoBindRoutes } from '../../src/routes/auth/ssoBind';
import { ssoLoginContextStore } from '../../src/sso/ssoLoginContext';

function buildApp(): Hono { const a = new Hono(); a.route('/', ssoBindRoutes); return a; }

const PENDING = {
  kind: 'pending_bind' as const,
  orgId: 'o1', connectionId: 'c1',
  externalId: 'ext-1', email: 'a@x.com', loginName: 'a',
  returnTarget: 'console' as const,
  redirectUri: 'http://x', codeVerifier: 'v',
  expiresAt: new Date(Date.now() + 60_000),
};

describe('routes/auth/ssoBind', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    ssoLoginContextStore.delete('st-pb');
    ssoLoginContextStore.delete('st-other');
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, require_prebinding)
       VALUES ('c1','o1','Acme','generic-oidc','oidc', false)`
    );
  });

  function ctxReady(state = 'st-pb'): void { ssoLoginContextStore.set(state, PENDING); }

  test('POST bind, state not in store → 400 bind_state_invalid', async () => {
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'no-such', username: 'u', password: 'p' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('bind_state_invalid');
  });

  test('POST bind, state.kind !== pending_bind → 400 bind_state_invalid', async () => {
    ssoLoginContextStore.set('st-other', {
      kind: 'self_binding', orgId: 'o1', connectionId: 'c1', userId: 'u1',
      redirectUri: null, codeVerifier: null, returnTarget: 'console', expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-other', username: 'u', password: 'p' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('bind_state_invalid');
  });

  test('POST bind, wrong password → 401 invalid_credentials (does not leak user existence)', async () => {
    ctxReady();
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u-real','o1','alice', $1)`,
      [await hashPassword('correct')]
    );
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-pb', username: 'alice', password: 'WRONG' }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_credentials');
  });

  test('POST bind, disabled user → 403 bind_user_disabled', async () => {
    ctxReady();
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, status) VALUES ('u-d','o1','bob', $1, 'disabled')`,
      [await hashPassword('pw')]
    );
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-pb', username: 'bob', password: 'pw' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('bind_user_disabled');
  });

  test('POST bind, cross-org user → 403 bind_org_mismatch', async () => {
    ctxReady();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2','Other')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u-x','o2','eve', $1)`,
      [await hashPassword('pw')]
    );
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-pb', username: 'eve', password: 'pw' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('bind_org_mismatch');
  });

  test('POST bind, same-org user wins even when another org holds the same username', async () => {
    ctxReady();
    // A colliding username in another org must NOT make a legitimate same-org
    // user fail with bind_org_mismatch (users is unique only on (org_id, username)).
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2','Other')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u-x','o2','alice', $1)`,
      [await hashPassword('other')]
    );
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u-real','o1','alice', $1)`,
      [await hashPassword('correct')]
    );
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-pb', username: 'alice', password: 'correct' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
  });

  test('POST bind, success → writes users.sso_*, user_idp_identities, store becomes ready_to_finalize, audit', async () => {
    ctxReady();
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u-real','o1','alice', $1)`,
      [await hashPassword('correct')]
    );
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-pb', username: 'alice', password: 'correct' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: true; returnTo: string };
    expect(j.ok).toBe(true);
    expect(j.returnTo).toMatch(/\/auth\/sso\/callback\?state=st-pb$/);

    const u = await testPool.query<{ sso_connection_id: string; sso_external_id: string }>(
      `SELECT sso_connection_id, sso_external_id FROM users WHERE id='u-real'`
    );
    expect(u.rows[0]).toEqual({ sso_connection_id: 'c1', sso_external_id: 'ext-1' });
    const ids = await testPool.query(`SELECT 1 FROM user_idp_identities WHERE user_id='u-real' AND sso_connection_id='c1' AND external_id='ext-1'`);
    expect(ids.rowCount).toBe(1);
    const ctx = ssoLoginContextStore.get('st-pb');
    expect(ctx?.kind).toBe('ready_to_finalize');
    if (ctx?.kind === 'ready_to_finalize') expect(ctx.boundUserId).toBe('u-real');
    const audit = await testPool.query<{ payload: any }>(
      `SELECT payload FROM audit_events WHERE action='sso_user_self_bound' AND user_id='u-real'`
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.payload).toMatchObject({ source: 'pending_bind' });
  });

  test('POST bind, race on unique index → 409 sso_binding_duplicate', async () => {
    ctxReady();
    // Pre-bind another user to (c1, ext-1).
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u-other','o1','zoe','x','c1','ext-1','[]'::jsonb)`
    );
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u-real','o1','alice', $1)`,
      [await hashPassword('correct')]
    );
    const res = await buildApp().request('/auth/sso/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'st-pb', username: 'alice', password: 'correct' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('sso_binding_duplicate');
  });

  test('GET /bind-sso?state=xxx, no entry → expired page', async () => {
    const res = await buildApp().request('/bind-sso?state=missing&lang=en');
    expect(res.status).toBe(200);
    const html = await res.text();
    // Page is rendered through the i18n helper; both zh and en must convey
    // "session expired" so a hostile regex that only knows English is
    // covered, and so the test works in either locale.
    expect(html).toMatch(/expired|invalid|session|会话已过期|无效|过期/i);
  });

  test('GET /bind-sso?state=xxx, entry pending_bind → form page with username/password + connection info', async () => {
    ctxReady();
    const res = await buildApp().request('/bind-sso?state=st-pb');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Acme/);  // connection name
    expect(html).toMatch(/ext-1/); // external id
    expect(html).toMatch(/<form/i);
    expect(html).toMatch(/name=["']username["']/);
    expect(html).toMatch(/name=["']password["']/);
    expect(html).toMatch(/name=["']state["']/);
  });

  test('GET /bind-sso HTML-escapes IdP-derived connection name and external id', async () => {
    // Simulate a hostile external id (e.g. from a permissive self-hosted IdP):
    // it must be entity-escaped, never interpolated as live markup.
    ssoLoginContextStore.set('st-xss', {
      kind: 'pending_bind', orgId: 'o1', connectionId: 'c1',
      externalId: '<img src=x onerror=alert(1)>', email: null, loginName: null,
      returnTarget: 'console',
      redirectUri: 'http://x', codeVerifier: 'v',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await buildApp().request('/bind-sso?state=st-xss');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
