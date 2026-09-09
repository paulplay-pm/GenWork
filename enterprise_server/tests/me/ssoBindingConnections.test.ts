// enterprise_server/tests/me/ssoBindingConnections.test.ts
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

describe('GET /me/sso-binding/connections', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','Org1'), ('o2','Org2')`);
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, status) VALUES ('u1','o1','alice','x','active'), ('u2','o2','bob','x','active')`);
    // Two enabled connections in o1, one in o2, one disabled in o1
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, enabled, sort_order, require_prebinding, logo_url)
       VALUES
         ('c1','o1','feishu','feishu','oidc','https://idp/a', true, 0, false, null),
         ('c2','o1','dingtalk','dingtalk','oidc','https://idp/b', true, 1, false, null),
         ('c3','o2','OtherOrg','generic-oidc','oidc','https://idp/c', true, 0, false, null),
         ('c4','o1','Disabled','generic-oidc','oidc','https://idp/d', false, 2, false, null)`
    );
    // u1 is bound to c1
    await testPool.query(
      `UPDATE users SET sso_connection_id = 'c1', sso_external_id = 'kk@example.com' WHERE id = 'u1'`
    );
  });

  test('401 without bearer token', async () => {
    const res = await buildApp().request('/me/sso-binding/connections');
    expect(res.status).toBe(401);
  });

  test('200 + only enabled connections in caller org, sorted by sort_order', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/connections', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: Array<{ id: string; name: string; bound: boolean; externalId: string | null; sortOrder: number }> };
    expect(body.connections.map(c => c.id)).toEqual(['c1', 'c2']);  // c3 other-org excluded, c4 disabled excluded
    expect(body.connections.map(c => c.sortOrder)).toEqual([0, 1]);
  });

  test('bound row carries bound=true and externalId', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/connections', { headers: { authorization: `Bearer ${tok}` } });
    const body = (await res.json()) as { connections: Array<{ id: string; bound: boolean; externalId: string | null }> };
    const c1 = body.connections.find(c => c.id === 'c1')!;
    expect(c1.bound).toBe(true);
    expect(c1.externalId).toBe('kk@example.com');
  });

  test('unbound row carries bound=false and externalId=null', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/connections', { headers: { authorization: `Bearer ${tok}` } });
    const body = (await res.json()) as { connections: Array<{ id: string; bound: boolean; externalId: string | null }> };
    const c2 = body.connections.find(c => c.id === 'c2')!;
    expect(c2.bound).toBe(false);
    expect(c2.externalId).toBeNull();
  });

  test('does not leak connections from other orgs', async () => {
    const tok = await tokenFor('u2', 'o2');
    const res = await buildApp().request('/me/sso-binding/connections', { headers: { authorization: `Bearer ${tok}` } });
    const body = (await res.json()) as { connections: Array<{ id: string }> };
    expect(body.connections.map(c => c.id)).toEqual(['c3']);
  });

  test('logoUrl is null when neither logo_url nor a built-in default exists', async () => {
    // generic-oidc has no built-in default per resolveProviderLogoUrl.
    // u1 is in o1, but none of u1's connections are generic-oidc. Insert one
    // and re-test.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, enabled, sort_order, require_prebinding, logo_url)
       VALUES ('c5','o1','Generic','generic-oidc','oidc','https://idp/e', true, 3, false, null)`
    );
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/connections', { headers: { authorization: `Bearer ${tok}` } });
    const body = (await res.json()) as { connections: Array<{ id: string; logoUrl: string | null }> };
    const c5 = body.connections.find(c => c.id === 'c5')!;
    expect(c5.logoUrl).toBeNull();
  });

  test('logoUrl is absolute URL for known provider types (feishu built-in fallback)', async () => {
    // Even with logo_url=null, feishu has a built-in default per resolveProviderLogoUrl.
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/connections', { headers: { authorization: `Bearer ${tok}` } });
    const body = (await res.json()) as { connections: Array<{ id: string; logoUrl: string | null }> };
    const c1 = body.connections.find(c => c.id === 'c1')!;
    expect(c1.logoUrl).toMatch(/^https?:\/\//);  // absolute URL, not relative
  });

  test('logoUrl is the user-pinned logo_url when set (overrides built-in)', async () => {
    await testPool.query(`UPDATE sso_connections SET logo_url = 'https://cdn.example.com/custom.png' WHERE id = 'c1'`);
    const tok = await tokenFor('u1', 'o1');
    const res = await buildApp().request('/me/sso-binding/connections', { headers: { authorization: `Bearer ${tok}` } });
    const body = (await res.json()) as { connections: Array<{ id: string; logoUrl: string | null }> };
    const c1 = body.connections.find(c => c.id === 'c1')!;
    expect(c1.logoUrl).toBe('https://cdn.example.com/custom.png');
  });
});
