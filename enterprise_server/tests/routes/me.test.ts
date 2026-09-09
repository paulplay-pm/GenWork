import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { authService } from '../../src/auth/authService';
import { resetSchema, runMigrations,testPool } from '../../src/db/testDb';
import { authRoutes } from '../../src/routes/auth';
import { meRoutes } from '../../src/routes/me';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  app.route('/', meRoutes);
  return app;
}

async function tokenFor(username: string, password = 'pw12345678'): Promise<{ token: string }> {
  const a = buildApp();
  const login = await a.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgName: 'T', username, password }),
  });
  expect(login.status).toBe(200);
  return (await login.json()) as { token: string };
}

interface MeResponse {
  id: string;
  username: string;
  display_name: string | null;
  effective_roles: string[];
  org_id: string;
  permissions: string[];
  effectiveDataScope: 'all' | 'self' | 'dept';
  concurrentDeptPaths: string[];
  membersCanSubmitConnectors: boolean;
}

describe('routes/me', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
    await authService.createUser({
      orgId: 'o1',
      username: 'alice',
      password: 'pw12345678',
    });
  });

  test('GET /me returns the current user with null display_name by default', async () => {
    const a = buildApp();
    const { token } = await tokenFor('alice');
    const r = await a.request('/me', { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as MeResponse;
    expect(body.username).toBe('alice');
    expect(body.display_name).toBeNull();
    expect(body.org_id).toBe('o1');
  });

  test('PATCH /me updates display_name and returns the updated profile', async () => {
    const a = buildApp();
    const { token } = await tokenFor('alice');
    const r = await a.request('/me', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ displayName: 'Alice W' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as MeResponse;
    expect(body.display_name).toBe('Alice W');

    // Confirm persistence by re-reading via GET.
    const again = await a.request('/me', { headers: { authorization: `Bearer ${token}` } });
    const againBody = (await again.json()) as MeResponse;
    expect(againBody.display_name).toBe('Alice W');

    // An audit row is written for the profile update.
    const audit = await testPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE user_id=(SELECT id FROM users WHERE username='alice')`
    );
    expect(audit.rows.map((x) => x.action)).toContain('profile_update');
  });

  test('GET /me exposes fine points, effective data scope, and concurrent dept paths', async () => {
    const a = buildApp();
    const { token } = await tokenFor('alice');
    await testPool.query(
      `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES ('d1', 'o1', 'Root', NULL, '/Root')`,
    );
    await testPool.query(
      `INSERT INTO user_departments(user_id, dept_id, is_primary)
       VALUES ((SELECT id FROM users WHERE username = 'alice'), 'd1', false)`,
    );
    const r = await a.request('/me', { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as MeResponse;
    // alice has no extra roles: no fine points, self scope, one non-primary dept path.
    expect(body.permissions).toEqual([]);
    expect(body.effectiveDataScope).toBe('self');
    expect(body.concurrentDeptPaths).toEqual(['/Root']);
  });

  test('GET /me exposes the org members_can_submit_connectors toggle', async () => {
    const a = buildApp();
    const { token } = await tokenFor('alice');

    // Default: the column is TRUE (members may submit) until an admin turns it off.
    let r = await a.request('/me', { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    let body = (await r.json()) as MeResponse;
    expect(body.membersCanSubmitConnectors).toBe(true);

    // After the toggle is off, /me reflects it (the desktop gates its
    // 「申请连接器」entry on this flag — a plain member cannot read the
    // admin settings endpoint).
    await testPool.query(`UPDATE orgs SET members_can_submit_connectors = FALSE WHERE id = 'o1'`);
    r = await a.request('/me', { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    body = (await r.json()) as MeResponse;
    expect(body.membersCanSubmitConnectors).toBe(false);
  });

  test('PATCH /me with empty displayName is a 422', async () => {
    const a = buildApp();
    const { token } = await tokenFor('alice');
    const r = await a.request('/me', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ displayName: '' }),
    });
    expect(r.status).toBe(422);
  });

  test('PATCH /me without auth is a 401', async () => {
    const a = buildApp();
    const r = await a.request('/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'X' }),
    });
    expect(r.status).toBe(401);
  });

  test('PATCH /me with no fields is a no-op 200', async () => {
    const a = buildApp();
    const { token } = await tokenFor('alice');
    const r = await a.request('/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as MeResponse;
    expect(body.display_name).toBeNull();
  });
});
