import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { scopeApi } from '../../src/auth/scopeResolver';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { roleAdminRoutes } from '../../src/routes/admin/roles';

const app = () => {
  const a = new Hono();
  a.route('/', roleAdminRoutes);
  return a;
};
const hdr = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

interface RoleRow {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  permissions: string[];
  dataScope: string;
  customDeptIds: string[];
  isBuiltin: boolean;
  memberCount: number;
}

const BUILTIN_NAMES = ['super_admin', 'org_admin', 'dept_admin', 'auditor', 'dev', 'member'];
const CUSTOM_NAMES = ['model_admin', 'policy_admin', 'agent_admin'];
const ALL_SCOPES = ['org_wide', 'dept_and_below', 'dept', 'self', 'custom_dept_tree'];

describe('routes/admin/roles v2', () => {
  let t: string;

  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
    await scopeApi.invalidate();
    t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
  });

  async function listRoles(query = ''): Promise<RoleRow[]> {
    const res = await app().request(`/admin/roles${query}`, { headers: hdr(t) });
    expect(res.status).toBe(200);
    return (await res.json()) as RoleRow[];
  }

  test('GET ?type=builtin returns only the 6 built-ins', async () => {
    const rows = await listRoles('?type=builtin');
    expect(rows.map((r) => r.name).sort()).toEqual([...BUILTIN_NAMES].sort());
    expect(rows.every((r) => r.isBuiltin)).toBe(true);
  });

  test('GET ?type=custom returns the demoted customs, not the built-ins', async () => {
    const rows = await listRoles('?type=custom');
    expect(rows.map((r) => r.name).sort()).toEqual([...CUSTOM_NAMES].sort());
    expect(rows.every((r) => !r.isBuiltin)).toBe(true);
  });

  test('GET with a bad ?type= is rejected', async () => {
    const res = await app().request('/admin/roles?type=weird', { headers: hdr(t) });
    expect(res.status).toBe(422);
  });

  test('GET (no type) returns all rows with the v2 fields', async () => {
    const rows = await listRoles();
    expect(rows.map((r) => r.name).sort()).toEqual(
      [...BUILTIN_NAMES, ...CUSTOM_NAMES].sort()
    );
    for (const r of rows) {
      expect(typeof r.displayName).toBe('string');
      expect(r.displayName).toBeTruthy();
      expect(ALL_SCOPES).toContain(r.dataScope);
      expect(Array.isArray(r.customDeptIds)).toBe(true);
      expect(typeof r.isBuiltin).toBe('boolean');
      expect(typeof r.memberCount).toBe('number');
    }
  });

  test('DELETE a built-in role → 409 builtin_role; role still exists', async () => {
    const rows = await listRoles('?type=builtin');
    const member = rows.find((r) => r.name === 'member')!;
    const res = await app().request(`/admin/roles/${member.id}`, { method: 'DELETE', headers: hdr(t) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'builtin_role' });
    const after = await listRoles('?type=builtin');
    expect(after.map((r) => r.name)).toContain('member');
  });

  test('DELETE a custom role that has members → 409 role_in_use; role still exists', async () => {
    const create = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'temp_custom', permissions: [] }),
    });
    expect(create.status).toBe(200);
    const { id } = (await create.json()) as { id: string };
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, extra_roles)
       VALUES ('u1', 'o1', 'u1', 'x', '["temp_custom"]'::jsonb)`
    );
    const res = await app().request(`/admin/roles/${id}`, { method: 'DELETE', headers: hdr(t) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'role_in_use' });
    const after = await listRoles('?type=custom');
    expect(after.map((r) => r.name)).toContain('temp_custom');
  });

  test('DELETE an unassigned custom role → 200; role gone', async () => {
    const create = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'temp_gone', permissions: [] }),
    });
    const { id } = (await create.json()) as { id: string };
    const res = await app().request(`/admin/roles/${id}`, { method: 'DELETE', headers: hdr(t) });
    expect(res.status).toBe(200);
    const after = await listRoles('?type=custom');
    expect(after.map((r) => r.name)).not.toContain('temp_gone');
  });

  test('DELETE an unknown role → 404', async () => {
    const res = await app().request('/admin/roles/missing-id', { method: 'DELETE', headers: hdr(t) });
    expect(res.status).toBe(404);
  });

  test('POST /:id/copy on a custom role creates a custom copy', async () => {
    const rows = await listRoles('?type=custom');
    const src = rows.find((r) => r.name === 'policy_admin')!;
    const res = await app().request(`/admin/roles/${src.id}/copy`, {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ newCode: 'policy_copy' }),
    });
    expect(res.status).toBe(200);
    const { id: newId } = (await res.json()) as { id: string };
    const all = await listRoles();
    const copy = all.find((r) => r.id === newId)!;
    expect(copy.name).toBe('policy_copy');
    expect(copy.permissions).toEqual(src.permissions);
    expect(copy.dataScope).toBe(src.dataScope);
    expect(copy.customDeptIds).toEqual(src.customDeptIds);
    expect(copy.isBuiltin).toBe(false);
    expect(copy.displayName).toBe(`${src.displayName} (copy)`);
    const audit = await testPool.query<{ action: string; target_id: string; payload: unknown }>(
      `SELECT action, target_id, payload FROM audit_events WHERE action='role_copy'`
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]!.target_id).toBe(newId);
    expect(audit.rows[0]!.payload).toMatchObject({ source: src.id, newCode: 'policy_copy' });
  });

  test('POST /:id/copy on a built-in source still creates a custom role', async () => {
    const rows = await listRoles('?type=builtin');
    const src = rows.find((r) => r.name === 'dev')!;
    const res = await app().request(`/admin/roles/${src.id}/copy`, {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ newCode: 'dev_copy' }),
    });
    expect(res.status).toBe(200);
    const { id: newId } = (await res.json()) as { id: string };
    const all = await listRoles('?type=custom');
    const copy = all.find((r) => r.id === newId)!;
    expect(copy.isBuiltin).toBe(false);
    expect(copy.permissions).toEqual(src.permissions);
  });

  test('POST /:id/copy: bad newCode → 422; existing code → 409; unknown source → 404', async () => {
    const rows = await listRoles('?type=custom');
    const src = rows.find((r) => r.name === 'policy_admin')!;
    const bad = await app().request(`/admin/roles/${src.id}/copy`, {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ newCode: 'Bad Code' }),
    });
    expect(bad.status).toBe(422);
    const dup = await app().request(`/admin/roles/${src.id}/copy`, {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ newCode: 'policy_admin' }),
    });
    expect(dup.status).toBe(409);
    const missing = await app().request('/admin/roles/missing-id/copy', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ newCode: 'fresh_code' }),
    });
    expect(missing.status).toBe(404);
  });

  test('POST with dataScope + customDeptIds persists both', async () => {
    const res = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({
        name: 'scoped_role',
        permissions: ['user:view'],
        displayName: 'Scoped',
        dataScope: 'custom_dept_tree',
        customDeptIds: ['d1'],
      }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const row = await testPool.query<{ data_scope: string; custom_dept_ids: string[] }>(
      `SELECT data_scope, custom_dept_ids FROM roles WHERE id=$1`,
      [id]
    );
    expect(row.rows[0]!.data_scope).toBe('custom_dept_tree');
    expect(row.rows[0]!.custom_dept_ids).toEqual(['d1']);
    // and visible through the list endpoint
    const all = await listRoles();
    const got = all.find((r) => r.id === id)!;
    expect(got.displayName).toBe('Scoped');
    expect(got.dataScope).toBe('custom_dept_tree');
    expect(got.customDeptIds).toEqual(['d1']);
  });

  test('POST with a bad dataScope → 422', async () => {
    const res = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'bad_scope', permissions: [], dataScope: 'bogus' }),
    });
    expect(res.status).toBe(422);
  });

  test('PATCH a role dataScope persists; a bad dataScope → 422', async () => {
    const create = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'patchme', permissions: [] }),
    });
    const { id } = (await create.json()) as { id: string };
    const ok = await app().request(`/admin/roles/${id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ dataScope: 'dept' }),
    });
    expect(ok.status).toBe(200);
    const row = await testPool.query<{ data_scope: string }>(`SELECT data_scope FROM roles WHERE id=$1`, [id]);
    expect(row.rows[0]!.data_scope).toBe('dept');
    const bad = await app().request(`/admin/roles/${id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ dataScope: 'bogus' }),
    });
    expect(bad.status).toBe(422);
  });

  test('PATCH a custom role name + displayName persists', async () => {
    const create = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'oldname', displayName: 'Old', permissions: [] }),
    });
    const { id } = (await create.json()) as { id: string };
    const ok = await app().request(`/admin/roles/${id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ name: 'newname', displayName: 'New' }),
    });
    expect(ok.status).toBe(200);
    const all = await listRoles();
    const got = all.find((r) => r.id === id)!;
    expect(got.name).toBe('newname');
    expect(got.displayName).toBe('New');
  });

  test('memberCount reflects users carrying the role', async () => {
    const create = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'counted', permissions: [] }),
    });
    const { id } = (await create.json()) as { id: string };
    const before = (await listRoles()).find((r) => r.id === id)!;
    expect(before.memberCount).toBe(0);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, extra_roles)
       VALUES ('u1', 'o1', 'u1', 'x', '["counted"]'::jsonb),
              ('u2', 'o1', 'u2', 'x', '["counted","member"]'::jsonb)`
    );
    const after = (await listRoles()).find((r) => r.id === id)!;
    expect(after.memberCount).toBe(2);
  });
});
