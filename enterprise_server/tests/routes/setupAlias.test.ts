import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { resetSchema, runMigrations,testPool } from '../../src/db/testDb';
import { setupAliasRoutes } from '../../src/routes/setupAlias';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/setup', setupAliasRoutes);
  return app;
}

function jsonOf<T>(r: Response): Promise<T> {
  return r.json() as Promise<T>;
}

describe('routes/setupAlias', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('status returns superAdminExists=false when no user', async () => {
    const a = buildApp();
    const r = await a.request('/api/setup/status');
    expect(r.status).toBe(200);
    const body = await jsonOf<{ superAdminExists: boolean; setupCompletedAt: string | null }>(r);
    expect(body.superAdminExists).toBe(false);
    expect(body.setupCompletedAt).toBeNull();
  });

  test('start creates pending invitation and returns orgId', async () => {
    const a = buildApp();
    const r = await a.request('/api/setup/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Acme Corp' }),
    });
    expect(r.status).toBe(200);
    const body = await jsonOf<{ orgId: string; orgName: string; code: string; expiresAt: string }>(r);
    expect(body.orgId).toMatch(/^org-[0-9a-f]{8}$/);
    expect(body.orgName).toBe('Acme Corp');
    expect(body.code).toMatch(/^GENWORK-SETUP-/);
    expect(typeof body.expiresAt).toBe('string');
  });

  test('start rejects duplicate org name with 409', async () => {
    const a = buildApp();
    const first = await a.request('/api/setup/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Acme Corp' }),
    });
    expect(first.status).toBe(200);
    const second = await a.request('/api/setup/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Acme Corp' }),
    });
    expect(second.status).toBe(409);
    const body = await jsonOf<{ error: string }>(second);
    expect(body.error).toBe('duplicate_org_name');
  });

  test('redeem rejects expired invitation with 410', async () => {
    const a = buildApp();
    const startRes = await a.request('/api/setup/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Acme Corp' }),
    });
    const start = await jsonOf<{ orgId: string; code: string }>(startRes);
    await testPool.query(
      `UPDATE init_invitations SET expires_at = now() - interval '1 hour'`
    );
    const r = await a.request('/api/setup/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: start.orgId,
        code: start.code,
        username: 'r',
        password: 'pw12345678',
      }),
    });
    expect(r.status).toBe(410);
  });

  test('redeem success path returns userId + token + orgName', async () => {
    const a = buildApp();
    const startRes = await a.request('/api/setup/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Acme Corp' }),
    });
    const start = await jsonOf<{ orgId: string; code: string }>(startRes);
    const r = await a.request('/api/setup/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: start.orgId,
        code: start.code,
        username: 'root',
        password: 'pw12345678',
      }),
    });
    expect(r.status).toBe(200);
    const body = await jsonOf<{ userId: string; token: string; orgId: string; orgName: string }>(r);
    expect(typeof body.userId).toBe('string');
    expect(typeof body.token).toBe('string');
    expect(body.orgId).toBe(start.orgId);
    expect(body.orgName).toBe('Acme Corp');
  });

  test('hard-closes /api/setup/* (except /status) after first successful redeem', async () => {
    const a = buildApp();
    const startRes = await a.request('/api/setup/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Acme Corp' }),
    });
    const start = await jsonOf<{ orgId: string; code: string }>(startRes);
    const redeem = await a.request('/api/setup/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: start.orgId,
        code: start.code,
        username: 'root',
        password: 'pw12345678',
      }),
    });
    expect(redeem.status).toBe(200);

    // /start now 410s
    const start2 = await a.request('/api/setup/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'Other Corp' }),
    });
    expect(start2.status).toBe(410);
    const start2body = await jsonOf<{ error: string }>(start2);
    expect(start2body.error).toBe('setup_closed');

    // /redeem also 410s
    const redeem2 = await a.request('/api/setup/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(redeem2.status).toBe(410);

    // /status still 200s and reports superAdminExists + setupCompletedAt
    const status = await a.request('/api/setup/status');
    expect(status.status).toBe(200);
    const sbody = await jsonOf<{ superAdminExists: boolean; setupCompletedAt: string | null }>(status);
    expect(sbody.superAdminExists).toBe(true);
    expect(typeof sbody.setupCompletedAt).toBe('string');
  });
});
