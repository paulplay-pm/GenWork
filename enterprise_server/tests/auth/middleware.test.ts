import '../helpers/setupEnv';
import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';
import { resetSchema, runMigrations } from '../../src/db/testDb';
import { requireCapability, requireSuperAdmin } from '../../src/auth/middleware';
import { signToken } from '../../src/auth/jwt';

function buildApp(role: string, isSuperAdmin = false): Hono {
  const app = new Hono();
  void isSuperAdmin;
  app.use('*', requireCapability(role));
  app.get('/check', (c) => c.json({ ok: true }));
  return app;
}

describe('auth/middleware (capability)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('super_admin 接受任何 capability', async () => {
    const tok = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    const a = buildApp('model_admin', true);
    const res = await a.request('/check', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });

  test('含 capability role 通过', async () => {
    const tok = await signToken({ sub: 'u1', orgId: 'o1', roles: ['org_admin'] });
    const a = buildApp('org_admin');
    const res = await a.request('/check', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });

  test('role 不匹配 → 403', async () => {
    const tok = await signToken({ sub: 'u1', orgId: 'o1', roles: ['user'] });
    const a = buildApp('org_admin');
    const res = await a.request('/check', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(403);
  });

  test('缺 token → 401', async () => {
    const a = buildApp('org_admin');
    const res = await a.request('/check');
    expect(res.status).toBe(401);
  });

  test('requireSuperAdmin 拒绝 non-super', async () => {
    const tok = await signToken({ sub: 'u1', orgId: 'o1', roles: ['org_admin'] });
    const app = new Hono();
    app.use('*', requireSuperAdmin());
    app.get('/check', (c) => c.json({ ok: true }));
    const res = await app.request('/check', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(403);
  });
});