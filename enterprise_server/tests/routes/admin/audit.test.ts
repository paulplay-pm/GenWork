import '../../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../src/db/pool', async () => {
  const td = await import('../../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { authService } from '../../../src/auth/authService';
import { signToken } from '../../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../../src/db/testDb';
import { adminAuditRoutes } from '../../../src/routes/admin/audit';
import { authRoutes } from '../../../src/routes/auth';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  app.route('/', adminAuditRoutes);
  return app;
}

describe('routes/admin/audit', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Test')`);
    await authService.createUser({ orgId: 'o1', username: 'a', password: 'pw12345' });
  });

  test('GET /admin/audit?include=login merges login_events and dedups the audit_events login row', async () => {
    const a = buildApp();
    // Successful login → one audit_events row (action='login') plus one
    // login_events row (result='success').
    const ok = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Test', username: 'a', password: 'pw12345' }),
    });
    expect(ok.status).toBe(200);
    // Failed login (wrong password) → only a login_events row (result='failed').
    const bad = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Test', username: 'a', password: 'WRONG' }),
    });
    expect(bad.status).toBe(401);

    const t = await signToken({ sub: 'admin', orgId: 'o1', roles: ['super_admin'] });
    const res = await a.request('/admin/audit?include=login', {
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.status).toBe(200);
    const events = (await res.json()) as {
      action: string;
      target_type: string | null;
      user_id: string | null;
      payload: { result: string } | null;
      ts: string;
    }[];

    // The successful login appears exactly once — from login_events, not
    // duplicated from the plain audit_events login row (the merge drops it).
    const successRows = events.filter((e) => e.payload?.result === 'success');
    expect(successRows).toHaveLength(1);
    // The failed login appears once with the richer login_events payload.
    const failedRows = events.filter((e) => e.payload?.result === 'failed');
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]!.action).toBe('login');
    expect(failedRows[0]!.target_type).toBe('login');
    // Two logins in → two merged rows (3 would mean the dedup failed).
    expect(events).toHaveLength(2);
    // Sorted by ts DESC.
    const ts = events.map((e) => new Date(e.ts).getTime());
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i - 1]!).toBeGreaterThanOrEqual(ts[i]!);
    }
  });
});
