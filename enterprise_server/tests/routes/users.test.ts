import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { roleResolver } from '../../src/auth/roleResolver';
import { scopeApi } from '../../src/auth/scopeResolver';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { orgService } from '../../src/org/orgService';
import { adminUserRoutes } from '../../src/routes/admin/users';

const app = () => {
  const a = new Hono();
  a.route('/', adminUserRoutes);
  return a;
};
const hdr = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

async function seedDepts(): Promise<{ eng: string; be: string; sales: string }> {
  const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
  const be = await orgService.createDept({ orgId: 'o1', name: 'BE', code: 'BE', parentId: eng.id });
  const sales = await orgService.createDept({ orgId: 'o1', name: 'Sales', code: 'SALES', parentId: null });
  return { eng: eng.id, be: be.id, sales: sales.id };
}

/** A user with the built-in dept_admin role (data scope dept_and_below)
 *  whose primary membership is `deptId`. */
async function deptAdminToken(deptId: string, username = 'boss'): Promise<string> {
  const { id } = await orgService.createUser({
    orgId: 'o1',
    username,
    password: 'pw-12345678',
    primaryDeptId: deptId,
  });
  return signToken({ sub: id, orgId: 'o1', roles: ['dept_admin'] });
}

async function auditRows(action: string): Promise<{ target_id: string | null; payload: unknown }[]> {
  const r = await testPool.query<{ target_id: string | null; payload: unknown }>(
    `SELECT target_id, payload FROM audit_events WHERE action=$1`,
    [action],
  );
  return r.rows;
}

async function junctionMap(userId: string): Promise<Map<string, boolean>> {
  const r = await testPool.query<{ dept_id: string; is_primary: boolean }>(
    `SELECT dept_id, is_primary FROM user_departments WHERE user_id=$1`,
    [userId],
  );
  return new Map(r.rows.map((x) => [x.dept_id, x.is_primary]));
}

describe('routes/admin/users', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
    await scopeApi.invalidate();
  });

  test('403 when the role lacks user:view', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['member'] });
    const res = await app().request('/admin/users?orgId=o1', { headers: hdr(t) });
    expect(res.status).toBe(403);
  });

  test('GET without orgId → 400; an orgId from another org → 400', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['org_admin'] });
    expect((await app().request('/admin/users', { headers: hdr(t) })).status).toBe(400);
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    expect((await app().request('/admin/users?orgId=o2', { headers: hdr(t) })).status).toBe(400);
  });

  test('org_admin (scope all) sees every org user', async () => {
    const { eng, be, sales } = await seedDepts();
    await orgService.createUser({ orgId: 'o1', username: 'm1', password: 'pw-12345678', primaryDeptId: eng });
    await orgService.createUser({ orgId: 'o1', username: 'm2', password: 'pw-12345678', primaryDeptId: be });
    await orgService.createUser({ orgId: 'o1', username: 'm3', password: 'pw-12345678', primaryDeptId: sales });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['org_admin'] });
    const res = await app().request('/admin/users?orgId=o1', { headers: hdr(t) });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { username: string }[];
    expect(rows.map((r) => r.username).sort()).toEqual(['m1', 'm2', 'm3']);
  });

  test('dept-scoped caller sees only their subtree users', async () => {
    const { eng, be, sales } = await seedDepts();
    await orgService.createUser({ orgId: 'o1', username: 'm1', password: 'pw-12345678', primaryDeptId: eng });
    await orgService.createUser({ orgId: 'o1', username: 'm2', password: 'pw-12345678', primaryDeptId: be });
    await orgService.createUser({ orgId: 'o1', username: 'm3', password: 'pw-12345678', primaryDeptId: sales });
    const t = await deptAdminToken(eng); // dept_and_below over {Eng, BE}
    const res = await app().request('/admin/users?orgId=o1', { headers: hdr(t) });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { username: string }[];
    // boss (the caller, in Eng) + Eng/BE members; m3 (Sales) is out of scope.
    expect(rows.map((r) => r.username).sort()).toEqual(['boss', 'm1', 'm2']);
  });

  test('GET :id out-of-scope → 403 + admin_access_denied (target_type user)', async () => {
    const { eng, sales } = await seedDepts();
    const salesUser = await orgService.createUser({
      orgId: 'o1',
      username: 'salesy',
      password: 'pw-12345678',
      primaryDeptId: sales,
    });
    const t = await deptAdminToken(eng);
    const res = await app().request(`/admin/users/${salesUser.id}`, { headers: hdr(t) });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: 'forbidden' });
    const denied = await testPool.query<{ target_id: string | null }>(
      `SELECT target_id FROM audit_events WHERE action='admin_access_denied' AND target_type='user'`,
    );
    expect(denied.rows.map((r) => r.target_id)).toEqual([salesUser.id]);
  });

  test('GET :id in-scope → 200 with departments and recent logins', async () => {
    const { eng, be } = await seedDepts();
    const m = await orgService.createUser({
      orgId: 'o1',
      username: 'm1',
      password: 'pw-12345678',
      primaryDeptId: eng,
      concurrentDeptIds: [be],
    });
    const t = await deptAdminToken(eng);
    const res = await app().request(`/admin/users/${m.id}`, { headers: hdr(t) });
    expect(res.status).toBe(200);
    const full = (await res.json()) as {
      username: string;
      departments: { id: string; is_primary: boolean }[];
      recent_logins: unknown[];
    };
    expect(full.username).toBe('m1');
    expect(full.departments).toHaveLength(2);
    expect(full.recent_logins).toEqual([]);
  });

  test('GET :id cross-org → 404', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    const other = await orgService.createUser({ orgId: 'o2', username: 'intruder', password: 'pw-12345678' });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/users/${other.id}`, { headers: hdr(t) });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'not_found' });
  });

  test('POST create → 200 {id,tempPassword} + user_create audit + junction written', async () => {
    const { eng } = await seedDepts();
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/users', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({
        orgId: 'o1',
        username: 'newbie',
        primaryDeptId: eng,
        email: 'newbie@t.test',
      }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { id: string; tempPassword: string };
    // Server-generated: the caller posts no password; the temp password is
    // a 16-char random string returned so the SPA can show it once.
    expect(j.tempPassword).toEqual(expect.stringMatching(/^[A-Za-z0-9]{16}$/));
    const rows = await auditRows('user_create');
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(j.id);
    const jm = await junctionMap(j.id);
    expect(jm.get(eng)).toBe(true);
    const deptId = (
      await testPool.query<{ department_id: string | null }>(
        `SELECT department_id FROM users WHERE id=$1`,
        [j.id],
      )
    ).rows[0].department_id;
    expect(deptId).toBe(eng);
  });

  test('POST with an out-of-scope primaryDeptId → 403 + audit, nothing created', async () => {
    const { eng, sales } = await seedDepts();
    // The built-in dept_admin role lacks user:create, so grant a custom
    // dept-scoped role (data_scope dept_and_below) the user points.
    await testPool.query(
      `INSERT INTO roles(id, name, data_scope, permissions)
       VALUES ('r1', 'user_creator', 'dept_and_below', '["user:view","user:create"]'::jsonb)`,
    );
    roleResolver.invalidate();
    const { id } = await orgService.createUser({
      orgId: 'o1',
      username: 'creator',
      password: 'pw-12345678',
      primaryDeptId: eng,
    });
    const t = await signToken({ sub: id, orgId: 'o1', roles: ['user_creator'] });
    const res = await app().request('/admin/users', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({
        orgId: 'o1',
        username: 'newbie',
        primaryDeptId: sales,
      }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: 'forbidden' });
    const created = await testPool.query(`SELECT id FROM users WHERE username='newbie'`);
    expect(created.rowCount).toBe(0);
    const denied = await testPool.query<{ target_type: string | null }>(
      `SELECT target_type FROM audit_events WHERE action='admin_access_denied' AND target_type='user'`,
    );
    expect(denied.rows).toHaveLength(1);
  });

  test('POST duplicate email → 409 email_duplicate', async () => {
    await orgService.createUser({
      orgId: 'o1',
      username: 'a',
      password: 'pw-12345678',
      email: 'same@t.test',
    });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/users', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ orgId: 'o1', username: 'b', email: 'same@t.test' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: 'email_duplicate' });
  });

  test('POST with an invalid body → 422', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/users', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ orgId: 'o1', username: 'x', email: 'not-an-email' }),
    });
    expect(res.status).toBe(422);
  });

  test('PATCH dept (in scope) → junction replaced + user_patch audit', async () => {
    const { eng, sales } = await seedDepts();
    const m = await orgService.createUser({ orgId: 'o1', username: 'm1', password: 'pw-12345678', primaryDeptId: eng });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/users/${m.id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ primaryDeptId: sales, concurrentDeptIds: [] }),
    });
    expect(res.status).toBe(200);
    const jm = await junctionMap(m.id);
    expect(jm.size).toBe(1);
    expect(jm.get(sales)).toBe(true);
    const deptId = (
      await testPool.query<{ department_id: string | null }>(
        `SELECT department_id FROM users WHERE id=$1`,
        [m.id],
      )
    ).rows[0].department_id;
    expect(deptId).toBe(sales);
    const rows = await auditRows('user_patch');
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(m.id);
  });

  test('PATCH out-of-scope dept → 403, membership untouched', async () => {
    const { eng, sales } = await seedDepts();
    const m = await orgService.createUser({ orgId: 'o1', username: 'm1', password: 'pw-12345678', primaryDeptId: eng });
    const t = await deptAdminToken(eng);
    const res = await app().request(`/admin/users/${m.id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ primaryDeptId: sales }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: 'forbidden' });
    expect(await junctionMap(m.id)).toEqual(new Map([[eng, true]]));
  });

  test('PATCH cross-org → 404', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    const other = await orgService.createUser({ orgId: 'o2', username: 'intruder', password: 'pw-12345678' });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/users/${other.id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ displayName: 'Hacked' }),
    });
    expect(res.status).toBe(404);
  });

  test('PATCH duplicate email → 409, but re-patching the owner keeps 200', async () => {
    const a = await orgService.createUser({
      orgId: 'o1',
      username: 'a',
      password: 'pw-12345678',
      email: 'same@t.test',
    });
    const b = await orgService.createUser({ orgId: 'o1', username: 'b', password: 'pw-12345678' });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const self = await app().request(`/admin/users/${a.id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ email: 'same@t.test' }),
    });
    expect(self.status).toBe(200);
    const conflict = await app().request(`/admin/users/${b.id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ email: 'same@t.test' }),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()) as { error: string }).toEqual({ error: 'email_duplicate' });
  });

  test('disable/enable cross-org → 404, status untouched', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    const other = await orgService.createUser({ orgId: 'o2', username: 'intruder', password: 'pw-12345678' });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/users/${other.id}/disable`, {
      method: 'POST',
      headers: hdr(t),
    });
    expect(res.status).toBe(404);
    const status = (
      await testPool.query<{ status: string }>(`SELECT status FROM users WHERE id=$1`, [other.id])
    ).rows[0].status;
    expect(status).toBe('active');
  });

  test('reset-password is server-generated: 200 {tempPassword} + user_reset_password audit', async () => {
    const m = await orgService.createUser({ orgId: 'o1', username: 'm1', password: 'pw-12345678' });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/users/${m.id}/reset-password`, {
      method: 'POST',
      headers: hdr(t),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { tempPassword: string };
    expect(j.tempPassword).toEqual(expect.stringMatching(/^[A-Za-z0-9]{16}$/));
    const rows = await auditRows('user_reset_password');
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(m.id);
  });

  test('reset-password on an unknown user → 404 (no client password needed)', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/users/nope/reset-password', {
      method: 'POST',
      headers: hdr(t),
    });
    expect(res.status).toBe(404);
  });

  test('dept-scoped caller PATCH out-of-scope user → 403 + audit, user unchanged', async () => {
    const { eng, sales } = await seedDepts();
    const salesUser = await orgService.createUser({
      orgId: 'o1',
      username: 'salesy',
      password: 'pw-12345678',
      primaryDeptId: sales,
    });
    const t = await deptAdminToken(eng);
    const res = await app().request(`/admin/users/${salesUser.id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ displayName: 'Hacked', status: 'disabled' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: 'forbidden' });
    const u = (
      await testPool.query<{ display_name: string | null; status: string }>(
        `SELECT display_name, status FROM users WHERE id=$1`,
        [salesUser.id],
      )
    ).rows[0];
    expect(u.display_name).toBeNull();
    expect(u.status).toBe('active');
    const denied = await testPool.query<{ target_id: string | null }>(
      `SELECT target_id FROM audit_events WHERE action='admin_access_denied' AND target_type='user'`,
    );
    expect(denied.rows.map((r) => r.target_id)).toEqual([salesUser.id]);
  });

  test('dept-scoped caller disable out-of-scope user → 403, status unchanged', async () => {
    const { eng, sales } = await seedDepts();
    const salesUser = await orgService.createUser({
      orgId: 'o1',
      username: 'salesy',
      password: 'pw-12345678',
      primaryDeptId: sales,
    });
    const t = await deptAdminToken(eng);
    const res = await app().request(`/admin/users/${salesUser.id}/disable`, {
      method: 'POST',
      headers: hdr(t),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: 'forbidden' });
    const status = (
      await testPool.query<{ status: string }>(`SELECT status FROM users WHERE id=$1`, [salesUser.id])
    ).rows[0].status;
    expect(status).toBe('active');
  });

  test('dept-scoped caller reset-password out-of-scope user → 403, hash unchanged', async () => {
    const { eng, sales } = await seedDepts();
    const salesUser = await orgService.createUser({
      orgId: 'o1',
      username: 'salesy',
      password: 'pw-12345678',
      primaryDeptId: sales,
    });
    const before = (
      await testPool.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id=$1`,
        [salesUser.id],
      )
    ).rows[0].password_hash;
    const t = await deptAdminToken(eng);
    const res = await app().request(`/admin/users/${salesUser.id}/reset-password`, {
      method: 'POST',
      headers: hdr(t),
    });
    expect(res.status).toBe(403);
    const after = (
      await testPool.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id=$1`,
        [salesUser.id],
      )
    ).rows[0].password_hash;
    expect(after).toBe(before);
  });

  test('scope-all caller still mutates the same user: PATCH / disable / enable / reset 200', async () => {
    const { sales } = await seedDepts();
    const salesUser = await orgService.createUser({
      orgId: 'o1',
      username: 'salesy',
      password: 'pw-12345678',
      primaryDeptId: sales,
    });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const patch = await app().request(`/admin/users/${salesUser.id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ displayName: 'Sales Lead' }),
    });
    expect(patch.status).toBe(200);
    const dn = (
      await testPool.query<{ display_name: string | null }>(
        `SELECT display_name FROM users WHERE id=$1`,
        [salesUser.id],
      )
    ).rows[0].display_name;
    expect(dn).toBe('Sales Lead');
    const dis = await app().request(`/admin/users/${salesUser.id}/disable`, {
      method: 'POST',
      headers: hdr(t),
    });
    expect(dis.status).toBe(200);
    const en = await app().request(`/admin/users/${salesUser.id}/enable`, {
      method: 'POST',
      headers: hdr(t),
    });
    expect(en.status).toBe(200);
    const reset = await app().request(`/admin/users/${salesUser.id}/reset-password`, {
      method: 'POST',
      headers: hdr(t),
    });
    expect(reset.status).toBe(200);
    const j = (await reset.json()) as { tempPassword: string };
    expect(j.tempPassword).toEqual(expect.stringMatching(/^[A-Za-z0-9]{16}$/));
  });

  test('dept-scoped caller PATCH an in-scope user → 200 (no over-block)', async () => {
    const { eng } = await seedDepts();
    const boss = await deptAdminToken(eng); // membership in Eng, inside own scope
    const bossId = (
      await testPool.query<{ id: string }>(`SELECT id FROM users WHERE username='boss'`)
    ).rows[0].id;
    const res = await app().request(`/admin/users/${bossId}`, {
      method: 'PATCH',
      headers: hdr(boss),
      body: JSON.stringify({ displayName: 'Boss of Eng' }),
    });
    expect(res.status).toBe(200);
    const dn = (
      await testPool.query<{ display_name: string | null }>(
        `SELECT display_name FROM users WHERE id=$1`,
        [bossId],
      )
    ).rows[0].display_name;
    expect(dn).toBe('Boss of Eng');
  });

  test('dept-scoped caller PATCH a user reached via CONCURRENT membership → 200 (no over-block)', async () => {
    const { eng, sales } = await seedDepts();
    // Primary is Sales; only the concurrent Eng row is inside the caller's
    // scope. A guard reading only `department_id` would 403 this target.
    const conc = await orgService.createUser({
      orgId: 'o1',
      username: 'conc',
      password: 'pw-12345678',
      primaryDeptId: sales,
      concurrentDeptIds: [eng],
    });
    const t = await deptAdminToken(eng);
    const res = await app().request(`/admin/users/${conc.id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ displayName: 'Concurrent Eng Member' }),
    });
    expect(res.status).toBe(200);
    const dn = (
      await testPool.query<{ display_name: string | null }>(
        `SELECT display_name FROM users WHERE id=$1`,
        [conc.id],
      )
    ).rows[0].display_name;
    expect(dn).toBe('Concurrent Eng Member');
  });
});
