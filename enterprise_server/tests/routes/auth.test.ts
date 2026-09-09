import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { authService } from '../../src/auth/authService';
import { verifyToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations,testPool } from '../../src/db/testDb';
import { authRoutes } from '../../src/routes/auth';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  return app;
}

describe('routes/auth', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Test')`);
    await authService.createUser({ orgId: 'o1', username: 'a', password: 'pw12345' });
  });

  test('POST /auth/login 成功返回 token', async () => {
    const a = buildApp();
    const res = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Test', username: 'a', password: 'pw12345' }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { token: string };
    expect(typeof j.token).toBe('string');
    expect(j.token.length).toBeGreaterThan(20);
  });

  test('POST /auth/login 设置 HttpOnly genwork_session cookie（Phase 2 浏览器登录门）', async () => {
    const a = buildApp();
    const res = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Test', username: 'a', password: 'pw12345' }),
    });
    const j = (await res.json()) as { token: string };
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('genwork_session=');
    expect(setCookie).toContain(j.token);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie.toLowerCase()).toContain('path=/');
    // The local dev server is plain HTTP, so the cookie must NOT be Secure
    // (a Secure cookie would be dropped by the browser over http://localhost).
    expect(setCookie.toLowerCase()).not.toContain('secure;');
  });

  test('POST /auth/login 密码错误时不设置会话 cookie', async () => {
    const a = buildApp();
    const res = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Test', username: 'a', password: 'WRONG' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('POST /auth/logout 清除 genwork_session cookie', async () => {
    const a = buildApp();
    const res = await a.request('/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('genwork_session=');
    // Cleared: empty value + zero max-age (equivalent to expiration).
    expect(/genwork_session=;/.test(setCookie)).toBe(true);
    expect(/max-age=0/i.test(setCookie)).toBe(true);
  });

  test('POST /auth/login 密码错误返回 401', async () => {
    const a = buildApp();
    const res = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Test', username: 'a', password: 'WRONG' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /auth/login 未知组织返回 401', async () => {
    const a = buildApp();
    const res = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Nonexistent', username: 'a', password: 'pw12345' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /auth/login 成功时写入 login_events（result=success）', async () => {
    const a = buildApp();
    const res = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Test', username: 'a', password: 'pw12345' }),
    });
    expect(res.status).toBe(200);
    const urow = await testPool.query<{ id: string }>(
      `SELECT id FROM users WHERE org_id = 'o1' AND username = 'a'`
    );
    const userId = urow.rows[0]!.id;
    const ev = await testPool.query<{ result: string; user_id: string | null }>(
      `SELECT result, user_id FROM login_events WHERE org_id = 'o1'`
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.result).toBe('success');
    expect(ev.rows[0]!.user_id).toBe(userId);
  });

  test('POST /auth/login 密码错误时写入 login_events（result=failed）', async () => {
    const a = buildApp();
    const res = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Test', username: 'a', password: 'WRONG' }),
    });
    expect(res.status).toBe(401);
    const urow = await testPool.query<{ id: string }>(
      `SELECT id FROM users WHERE org_id = 'o1' AND username = 'a'`
    );
    const userId = urow.rows[0]!.id;
    const ev = await testPool.query<{ result: string; user_id: string | null }>(
      `SELECT result, user_id FROM login_events WHERE org_id = 'o1'`
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.result).toBe('failed');
    expect(ev.rows[0]!.user_id).toBe(userId);
  });

  test('POST /auth/login 未知组织时不写入 login_events', async () => {
    const a = buildApp();
    const res = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Nonexistent', username: 'a', password: 'pw12345' }),
    });
    expect(res.status).toBe(401);
    const ev = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM login_events`
    );
    expect(ev.rows[0]!.n).toBe(0);
  });

  test('POST /auth/refresh 无 Bearer 返回 401', async () => {
    const a = buildApp();
    const res = await a.request('/auth/refresh', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test('POST /auth/refresh 拾取登录后授予的新角色', async () => {
    const a = buildApp();
    // Login as 'a' (default roles: ['user']).
    const login = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Test', username: 'a', password: 'pw12345' }),
    });
    const { token: t0 } = (await login.json()) as { token: string };
    const c0 = await verifyToken(t0);
    expect(c0.roles).toEqual(['user']);

    // An admin grants org_admin after login (as PATCH /admin/users/:id would).
    const urow = await testPool.query<{ id: string }>(
      `SELECT id FROM users WHERE org_id = 'o1' AND username = 'a'`
    );
    const userId = urow.rows[0].id;
    await testPool.query(
      `UPDATE users SET extra_roles = $1 WHERE id = $2`,
      [JSON.stringify(['user', 'org_admin']), userId]
    );

    // Refresh with the (stale) token. The new token must carry org_admin so
    // /api/agent-marketplace can see org_admin-scoped agents on the desktop.
    const refresh = await a.request('/auth/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${t0}` },
    });
    expect(refresh.status).toBe(200);
    const { token: t1 } = (await refresh.json()) as { token: string };
    const c1 = await verifyToken(t1);
    expect(c1.roles).toEqual(['user', 'org_admin']);
  });
});