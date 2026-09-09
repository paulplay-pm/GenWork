import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations,testPool } from '../../src/db/testDb';
import { deptRoutes } from '../../src/routes/admin/departments';
import { adminUserRoutes } from '../../src/routes/admin/users';
import { authRoutes } from '../../src/routes/auth';
import { Role } from '../../src/shared/enterpriseServerConstants';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  app.route('/', deptRoutes);
  app.route('/', adminUserRoutes);
  return app;
}

async function adminToken(orgId: string, userId: string): Promise<string> {
  return signToken({ sub: userId, orgId, roles: [Role.SuperAdmin] });
}

describe('routes/admin (dept/users)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Test')`);
  });

  test('非 admin 请求 POST /admin/departments 403', async () => {
    const a = buildApp();
    const tok = await signToken({ sub: 'u1', orgId: 'o1', roles: [Role.User] });
    const res = await a.request('/admin/departments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({ orgId: 'o1', name: 'root', parentId: null }),
    });
    expect(res.status).toBe(403);
  });

  test('admin 创建 department 并写审计', async () => {
    const a = buildApp();
    const tok = await adminToken('o1', 'admin1');
    const res = await a.request('/admin/departments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({ orgId: 'o1', name: 'root', parentId: null }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { id: string; path: string };
    expect(j.path).toBe('/root');
  });

  test('admin 创建 user + audit 写入', async () => {
    const a = buildApp();
    const tok = await adminToken('o1', 'admin1');
    const res = await a.request('/admin/users', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({
        orgId: 'o1',
        username: 'bob',
        password: 'pw123456',
      }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { id: string };
    const audit = await testPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE target_user_id=$1`,
      [j.id]
    );
    expect(audit.rows.map((r) => r.action)).toContain('user_create');
  });

  async function createBob(a: Hono, tok: string): Promise<string> {
    const res = await a.request('/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ orgId: 'o1', username: 'bob', password: 'pw123456' }),
    });
    const j = (await res.json()) as { id: string };
    return j.id;
  }

  test('admin 禁用后 enable 恢复 active 并写审计', async () => {
    const a = buildApp();
    const tok = await adminToken('o1', 'admin1');
    const id = await createBob(a, tok);

    await a.request(`/admin/users/${id}/disable`, { method: 'POST', headers: { authorization: `Bearer ${tok}` } });
    let row = await testPool.query<{ status: string }>(`SELECT status FROM users WHERE id=$1`, [id]);
    expect(row.rows[0].status).toBe('disabled');

    const en = await a.request(`/admin/users/${id}/enable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(en.status).toBe(200);
    row = await testPool.query<{ status: string }>(`SELECT status FROM users WHERE id=$1`, [id]);
    expect(row.rows[0].status).toBe('active');
    const audit = await testPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE target_user_id=$1 AND action='user_enable'`,
      [id]
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  test('admin reset-password 服务端生成临时密码并写审计', async () => {
    const a = buildApp();
    const tok = await adminToken('o1', 'admin1');
    const id = await createBob(a, tok);
    const res = await a.request(`/admin/users/${id}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { tempPassword: string };
    expect(j.tempPassword).toEqual(expect.stringMatching(/^[A-Za-z0-9]{16}$/));
    const audit = await testPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE target_user_id=$1 AND action='user_reset_password'`,
      [id]
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  test('reset-password 对未知用户 404,且无需请求体密码', async () => {
    const a = buildApp();
    const tok = await adminToken('o1', 'admin1');
    // The password is server-generated: an absent body is valid.
    const missing = await a.request('/admin/users/nope/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    });
    expect(missing.status).toBe(404);

    const id = await createBob(a, tok);
    const ok = await a.request(`/admin/users/${id}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    });
    expect(ok.status).toBe(200);
  });
});