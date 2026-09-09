import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { roleAdminRoutes } from '../../src/routes/admin/roles';

const app = () => {
  const a = new Hono();
  a.route('/', roleAdminRoutes);
  return a;
};
const hdr = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

describe('routes/admin/roles', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  });

  test('403 for a token whose role lacks role points', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['model_admin'] });
    const res = await app().request('/admin/roles', { headers: hdr(t) });
    expect(res.status).toBe(403);
  });

  test('403 for PATCH /admin/roles/:id when role lacks role points', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['model_admin'] });
    const res = await app().request('/admin/roles/some-id', {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  test('403 for DELETE /admin/roles/:id when role lacks role points', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['model_admin'] });
    const res = await app().request('/admin/roles/some-id', {
      method: 'DELETE',
      headers: hdr(t),
    });
    expect(res.status).toBe(403);
  });

  test('org_admin lists roles', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['org_admin'] });
    const res = await app().request('/admin/roles', { headers: hdr(t) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string }[];
    expect(body.map((r) => r.name)).toContain('org_admin');
  });

  test('super_admin can create a role with valid points', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'viewer', description: 'ro', permissions: ['audit:view'] }),
    });
    expect(res.status).toBe(200);
    const audit = await testPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action='role_create'`
    );
    expect(audit.rows.length).toBe(1);
  });

  test('rejects unknown permission point (422)', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'bad', permissions: ['nope.nope'] }),
    });
    expect(res.status).toBe(422);
  });

  test('delete a role writes role_delete audit', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const create = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'tmp', permissions: [] }),
    });
    const { id } = (await create.json()) as { id: string };
    const del = await app().request(`/admin/roles/${id}`, { method: 'DELETE', headers: hdr(t) });
    expect(del.status).toBe(200);
    const audit = await testPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action='role_delete'`
    );
    expect(audit.rows.length).toBe(1);
  });

  test('duplicate role name → 409', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const first = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'dup', permissions: [] }),
    });
    expect(first.status).toBe(200);
    const second = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'dup', permissions: [] }),
    });
    expect(second.status).toBe(409);
  });

  test('PATCH with an invalid permission point → 422', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/roles/some-id', {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ permissions: ['nope.nope'] }),
    });
    expect(res.status).toBe(422);
  });

  test('PATCH a role writes role_update audit', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const create = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'tmp', permissions: [] }),
    });
    const { id } = (await create.json()) as { id: string };
    const patch = await app().request(`/admin/roles/${id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ description: 'updated' }),
    });
    expect(patch.status).toBe(200);
    const audit = await testPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action='role_update'`
    );
    expect(audit.rows.length).toBe(1);
  });
});
