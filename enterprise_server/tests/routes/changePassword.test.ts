import '../helpers/setupEnv';
import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';
import { resetSchema, testPool, runMigrations } from '../../src/db/testDb';
import { authRoutes } from '../../src/routes/auth';
import { changePasswordRoutes } from '../../src/routes/changePassword';
import { authService } from '../../src/auth/authService';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  app.route('/', changePasswordRoutes);
  return app;
}

describe('routes/changePassword', () => {
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

  test('401 on wrong current password', async () => {
    const a = buildApp();
    const login = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'T', username: 'alice', password: 'pw12345678' }),
    });
    const { token } = (await login.json()) as { token: string };
    const r = await a.request('/auth/change-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ currentPassword: 'WRONG', newPassword: 'newPass123' }),
    });
    expect(r.status).toBe(401);
  });

  test('200 on correct current password + audit row written', async () => {
    const a = buildApp();
    const login = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'T', username: 'alice', password: 'pw12345678' }),
    });
    const { token } = (await login.json()) as { token: string };
    const claims = await (await import('../../src/auth/jwt')).verifyToken(token);
    const r = await a.request('/auth/change-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ currentPassword: 'pw12345678', newPassword: 'newPass123' }),
    });
    expect(r.status).toBe(200);
    const audit = await testPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE user_id=$1`,
      [claims.sub]
    );
    expect(audit.rows.map((x) => x.action)).toContain('password_change');
  });

  test('422 when new password < 8 chars', async () => {
    const a = buildApp();
    const login = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'T', username: 'alice', password: 'pw12345678' }),
    });
    const { token } = (await login.json()) as { token: string };
    const r = await a.request('/auth/change-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ currentPassword: 'pw12345678', newPassword: 'short' }),
    });
    expect(r.status).toBe(422);
  });
});