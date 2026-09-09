// enterprise_server/tests/admin/ssoBindings.test.ts
// Admin read + unbind for user-driven SSO self-bindings (Task 8). Admins
// can SEE any user's binding and UNBIND it (audit-tracked), but cannot
// WRITE a binding — that's reserved for the user self-flow
// (POST /me/sso-binding/start + the two-stage /auth/sso/bind).
//
// Permission gate order: admin/* requires PP.SsoView (outer); DELETE
// additionally requires PP.SsoEdit. A JWT with roles=['org_admin']
// passes both; roles=['user'] is rejected with 403 at the outer gate.
//
// Note: the legacy Role enum (Role.SuperAdmin / Role.Admin / Role.User)
// does not include 'org_admin'. 'org_admin' is a free-form role string
// resolved via roleResolver against the live `roles` table — see
// src/shared/permissionPoints.ts BUILTIN_ROLE_POINTS and migration 037.
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { adminSsoBindingRoutes } from '../../src/routes/admin/ssoBindings';
import { Role } from '../../src/shared/enterpriseServerConstants';

function buildApp(): Hono {
  const a = new Hono();
  a.use('/*', async (c, next) => {
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
  a.route('/', adminSsoBindingRoutes);
  return a;
}

async function adminToken(userId: string, orgId: string): Promise<string> {
  return signToken({ sub: userId, orgId, roles: ['org_admin'] });
}

describe('routes/admin/ssoBindings', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T'), ('o2','Other')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, enabled, require_prebinding)
       VALUES ('c1','o1','Feishu','feishu','oidc', true, false),
              ('c2','o2','Other','generic-oidc','oidc', true, false)`
    );
  });

  test('GET /admin/users/:id/sso-binding, unbound → 200 null', async () => {
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles) VALUES ('u1','o1','u1','x','[]'::jsonb)`);
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/users/u1/sso-binding', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test('GET /admin/users/:id/sso-binding, bound → 200 {connectionId, connectionName, providerType, externalId}', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','u1','x','c1','union-1','[]'::jsonb)`
    );
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/users/u1/sso-binding', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const j = await res.json() as { connectionId: string; connectionName: string; providerType: string; externalId: string };
    expect(j).toEqual({ connectionId: 'c1', connectionName: 'Feishu', providerType: 'feishu', externalId: 'union-1' });
  });

  test('GET /admin/users/:id/sso-binding, cross-org user → 404', async () => {
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles) VALUES ('u-x','o2','u2','x','[]'::jsonb)`);
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/users/u-x/sso-binding', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(404);
  });

  test('GET, missing permission → 403', async () => {
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles) VALUES ('u1','o1','u1','x','[]'::jsonb)`);
    const tok = await signToken({ sub: 'p1', orgId: 'o1', roles: [Role.User] });
    const res = await buildApp().request('/admin/users/u1/sso-binding', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(403);
  });

  test('GET /admin/sso-connections/:id/bindings → list of bound users', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','alice','x','c1','ext-1','[]'::jsonb),
              ('u2','o1','bob','x','c1','ext-2','[]'::jsonb)`
    );
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/sso-connections/c1/bindings', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const j = await res.json() as Array<{ username: string; externalId: string }>;
    expect(j).toHaveLength(2);
    expect(j.map(x => x.username).sort()).toEqual(['alice', 'bob']);
  });

  test('DELETE /admin/users/:id/sso-binding, bound → 200, users.sso_* cleared, user_idp_identities preserved, audit', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','u1','x','c1','ext-1','[]'::jsonb)`
    );
    await testPool.query(
      `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
       VALUES ('id-1','o1','u1','c1','ext-1')`
    );
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/users/u1/sso-binding', { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const u = await testPool.query<{ sso_connection_id: string | null; sso_external_id: string | null }>(`SELECT sso_connection_id, sso_external_id FROM users WHERE id='u1'`);
    expect(u.rows[0]).toEqual({ sso_connection_id: null, sso_external_id: null });
    const ids = await testPool.query(`SELECT 1 FROM user_idp_identities WHERE user_id='u1' AND sso_connection_id='c1' AND external_id='ext-1'`);
    expect(ids.rowCount).toBe(1);
    const audit = await testPool.query(`SELECT 1 FROM audit_events WHERE action='sso_user_admin_unbound'`);
    expect(audit.rowCount).toBe(1);
  });

  test('DELETE, cross-org user → 404', async () => {
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles) VALUES ('u-x','o2','u2','x','[]'::jsonb)`);
    const tok = await adminToken('admin1', 'o1');
    const res = await buildApp().request('/admin/users/u-x/sso-binding', { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(404);
  });

  test('DELETE, missing permission → 403', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id, extra_roles)
       VALUES ('u1','o1','u1','x','c1','ext-1','[]'::jsonb)`
    );
    const tok = await signToken({ sub: 'p1', orgId: 'o1', roles: [Role.User] });
    const res = await buildApp().request('/admin/users/u1/sso-binding', { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(403);
  });
});