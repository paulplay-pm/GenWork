import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { requirePermission } from '../../src/auth/middleware';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { roleService } from '../../src/org/roleService';
import { PermissionPoint } from '../../src/shared/permissionPoints';

const tok = (sub: string, orgId: string, roles: string[]) =>
  signToken({ sub, orgId, roles });

describe('requirePermission', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  });

  test('401 without a token', async () => {
    const app = new Hono();
    app.use('*', requirePermission(PermissionPoint.AuditView));
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x');
    expect(res.status).toBe(401);
  });

  test('super_admin bypasses the point check', async () => {
    const app = new Hono();
    app.use('*', requirePermission(PermissionPoint.AuditView));
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x', {
      headers: { authorization: `Bearer ${await tok('u', 'o1', ['super_admin'])}` },
    });
    expect(res.status).toBe(200);
  });

  test('403 when no role grants the point', async () => {
    const app = new Hono();
    app.use('*', requirePermission(PermissionPoint.AuditView));
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x', {
      headers: { authorization: `Bearer ${await tok('u', 'o1', ['model_admin'])}` },
    });
    expect(res.status).toBe(403);
  });

  test('200 when a role grants the point', async () => {
    const app = new Hono();
    app.use('*', requirePermission(PermissionPoint.AuditView));
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x', {
      headers: { authorization: `Bearer ${await tok('u', 'o1', ['auditor'])}` },
    });
    expect(res.status).toBe(200);
  });

  test('live: a custom role granted the point is allowed', async () => {
    const { id } = await roleService.create({ name: 'viewer', permissions: ['audit:view'] });
    void id;
    const app = new Hono();
    app.use('*', requirePermission(PermissionPoint.AuditView));
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x', {
      headers: { authorization: `Bearer ${await tok('u', 'o1', ['viewer'])}` },
    });
    expect(res.status).toBe(200);
  });
});
