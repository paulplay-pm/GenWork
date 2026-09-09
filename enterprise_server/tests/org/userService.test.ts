import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { loginRecord } from '../../src/org/loginRecord';
import { orgService, UserError } from '../../src/org/orgService';

async function seedDepts(): Promise<{ eng: string; be: string; sales: string }> {
  const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
  const be = await orgService.createDept({ orgId: 'o1', name: 'BE', code: 'BE', parentId: eng.id });
  const sales = await orgService.createDept({ orgId: 'o1', name: 'Sales', code: 'SALES', parentId: null });
  return { eng: eng.id, be: be.id, sales: sales.id };
}

/** Map of deptId → is_primary for a user's junction rows. */
async function junctionMap(userId: string): Promise<Map<string, boolean>> {
  const r = await testPool.query<{ dept_id: string; is_primary: boolean }>(
    `SELECT dept_id, is_primary FROM user_departments WHERE user_id=$1`,
    [userId],
  );
  return new Map(r.rows.map((x) => [x.dept_id, x.is_primary]));
}

describe('org/orgService users v2', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Acme')`);
  });

  test('createUser echoes the supplied password as tempPassword and writes a primary junction', async () => {
    const { eng } = await seedDepts();
    const out = await orgService.createUser({
      orgId: 'o1',
      username: 'alice',
      password: 'pw-12345678',
      displayName: 'Alice',
      email: 'alice@acme.test',
      position: 'Staff',
      primaryDeptId: eng,
    });
    expect(out.tempPassword).toBe('pw-12345678');
    const row = await testPool.query<{
      status: string;
      extra_roles: string[];
      department_id: string | null;
      display_name: string | null;
      email: string | null;
      position: string | null;
      joined_at: Date | null;
    }>(
      `SELECT status, extra_roles, department_id, display_name, email, position, joined_at
       FROM users WHERE id=$1`,
      [out.id],
    );
    expect(row.rows[0]).toEqual({
      status: 'active',
      extra_roles: ['member'], // default when roles is omitted
      department_id: eng,
      display_name: 'Alice',
      email: 'alice@acme.test',
      position: 'Staff',
      joined_at: null,
    });
    expect(await junctionMap(out.id)).toEqual(new Map([[eng, true]]));
  });

  test('createUser writes concurrent depts as non-primary junction rows', async () => {
    const { eng, be } = await seedDepts();
    const out = await orgService.createUser({
      orgId: 'o1',
      username: 'bob',
      password: 'pw-12345678',
      primaryDeptId: eng,
      concurrentDeptIds: [be],
    });
    const jm = await junctionMap(out.id);
    expect(jm.size).toBe(2);
    expect(jm.get(eng)).toBe(true);
    expect(jm.get(be)).toBe(false);
  });

  test('createUser rejects a duplicate email in the same org (other org is fine)', async () => {
    await orgService.createUser({
      orgId: 'o1',
      username: 'a',
      password: 'pw-12345678',
      email: 'dup@acme.test',
    });
    await expect(
      orgService.createUser({
        orgId: 'o1',
        username: 'b',
        password: 'pw-12345678',
        email: 'dup@acme.test',
      }),
    ).rejects.toThrow(UserError);
    // Uniqueness is per-org: the same email in another org is allowed.
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Beta')`);
    const other = await orgService.createUser({
      orgId: 'o2',
      username: 'c',
      password: 'pw-12345678',
      email: 'dup@acme.test',
    });
    expect(other.id).toBeTruthy();
  });

  test('createUser rejects an unknown or cross-org primary dept', async () => {
    await expect(
      orgService.createUser({
        orgId: 'o1',
        username: 'x',
        password: 'pw-12345678',
        primaryDeptId: 'does-not-exist',
      }),
    ).rejects.toThrow(UserError);
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Beta')`);
    const other = await orgService.createDept({ orgId: 'o2', name: 'X', code: 'X', parentId: null });
    await expect(
      orgService.createUser({
        orgId: 'o1',
        username: 'y',
        password: 'pw-12345678',
        primaryDeptId: other.id,
      }),
    ).rejects.toThrow(UserError);
  });

  test('setUserDepts replaces memberships and keeps users.department_id in sync', async () => {
    const { eng, be, sales } = await seedDepts();
    const out = await orgService.createUser({
      orgId: 'o1',
      username: 'm',
      password: 'pw-12345678',
      primaryDeptId: eng,
      concurrentDeptIds: [be],
    });
    expect(await junctionMap(out.id)).toEqual(new Map([[eng, true], [be, false]]));

    // New primary + empty concurrents: old rows gone, sales is primary.
    await orgService.setUserDepts(out.id, sales, []);
    expect(await junctionMap(out.id)).toEqual(new Map([[sales, true]]));
    let deptId = (
      await testPool.query<{ department_id: string | null }>(
        `SELECT department_id FROM users WHERE id=$1`,
        [out.id],
      )
    ).rows[0].department_id;
    expect(deptId).toBe(sales);

    // A primary plus a new concurrent coexist.
    await orgService.setUserDepts(out.id, be, [sales]);
    const jm = await junctionMap(out.id);
    expect(jm.get(be)).toBe(true);
    expect(jm.get(sales)).toBe(false);
    expect(jm.size).toBe(2);
    deptId = (
      await testPool.query<{ department_id: string | null }>(
        `SELECT department_id FROM users WHERE id=$1`,
        [out.id],
      )
    ).rows[0].department_id;
    expect(deptId).toBe(be);

    // primary=null wipes all memberships.
    await orgService.setUserDepts(out.id, null, []);
    expect((await junctionMap(out.id)).size).toBe(0);
    deptId = (
      await testPool.query<{ department_id: string | null }>(
        `SELECT department_id FROM users WHERE id=$1`,
        [out.id],
      )
    ).rows[0].department_id;
    expect(deptId).toBeNull();
  });

  test('setUserDepts rejects a dept from another org', async () => {
    const { eng } = await seedDepts();
    const out = await orgService.createUser({
      orgId: 'o1',
      username: 'm',
      password: 'pw-12345678',
      primaryDeptId: eng,
    });
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Beta')`);
    const other = await orgService.createDept({ orgId: 'o2', name: 'X', code: 'X', parentId: null });
    await expect(orgService.setUserDepts(out.id, other.id, [])).rejects.toThrow(UserError);
    // Original membership is untouched.
    expect(await junctionMap(out.id)).toEqual(new Map([[eng, true]]));
  });

  test('listUsers honors a dept scope (primary OR concurrent membership) and the 1-arg call', async () => {
    const { eng, be, sales } = await seedDepts();
    await orgService.createUser({ orgId: 'o1', username: 'in-eng', password: 'pw-12345678', primaryDeptId: eng });
    await orgService.createUser({ orgId: 'o1', username: 'in-be', password: 'pw-12345678', primaryDeptId: be });
    await orgService.createUser({ orgId: 'o1', username: 'in-sales', password: 'pw-12345678', primaryDeptId: sales });
    await orgService.createUser({ orgId: 'o1', username: 'homeless', password: 'pw-12345678' });
    // Primary is Sales, concurrent is Eng → still visible under an Eng scope.
    await orgService.createUser({
      orgId: 'o1',
      username: 'conc',
      password: 'pw-12345678',
      primaryDeptId: sales,
      concurrentDeptIds: [eng],
    });

    const scoped = await orgService.listUsers('o1', { kind: 'dept', deptIds: [eng, be] });
    expect(scoped.map((u) => u.username).sort()).toEqual(['conc', 'in-be', 'in-eng']);

    const all = await orgService.listUsers('o1', { kind: 'all' });
    expect(all).toHaveLength(5);

    // Legacy 1-arg call: every org user, unchanged.
    const legacy = await orgService.listUsers('o1');
    expect(legacy).toHaveLength(5);
    expect(legacy.map((u) => u.username)).toContain('homeless');

    // Rich row shape.
    const engRow = all.find((u) => u.username === 'in-eng')!;
    expect(engRow.department_id).toBe(eng);
    expect(engRow.primary_dept_name).toBe('Eng');
    expect(engRow.status).toBe('active');
    expect(engRow.extra_roles).toEqual(['member']);
  });

  test('listUsers q / deptId / roleId / status filters', async () => {
    const { eng, sales } = await seedDepts();
    const a = await orgService.createUser({
      orgId: 'o1',
      username: 'alpha',
      password: 'pw-12345678',
      email: 'alpha@acme.test',
      primaryDeptId: eng,
    });
    await orgService.createUser({
      orgId: 'o1',
      username: 'beta',
      password: 'pw-12345678',
      email: 'beta@acme.test',
      primaryDeptId: sales,
    });

    const byQ = await orgService.listUsers('o1', { kind: 'all' }, 'alp');
    expect(byQ.map((u) => u.username)).toEqual(['alpha']);

    const byDept = await orgService.listUsers('o1', { kind: 'all' }, undefined, { deptId: eng });
    expect(byDept.map((u) => u.username)).toEqual(['alpha']);

    const byRole = await orgService.listUsers('o1', { kind: 'all' }, undefined, { roleId: 'member' });
    expect(byRole).toHaveLength(2);

    await orgService.setUserStatus(a.id, 'disabled');
    const byStatus = await orgService.listUsers('o1', { kind: 'all' }, undefined, { status: 'active' });
    expect(byStatus.map((u) => u.username)).toEqual(['beta']);
  });

  test('getUserFull returns profile, memberships and recent logins; null for unknown', async () => {
    const { eng, be } = await seedDepts();
    const out = await orgService.createUser({
      orgId: 'o1',
      username: 'full',
      password: 'pw-12345678',
      primaryDeptId: eng,
      concurrentDeptIds: [be],
      email: 'full@acme.test',
    });
    await loginRecord.recordLogin('o1', out.id, '1.1.1.1', 'ios', 'success');
    await loginRecord.recordLogin('o1', out.id, '2.2.2.2', 'android', 'failed');

    const full = await orgService.getUserFull(out.id);
    expect(full).not.toBeNull();
    expect(full!.username).toBe('full');
    expect(full!.email).toBe('full@acme.test');
    const dmap = new Map(full!.departments.map((d) => [d.id, d.is_primary]));
    expect(dmap.get(eng)).toBe(true);
    expect(dmap.get(be)).toBe(false);
    expect(full!.deptIds).toContain(eng);
    expect(full!.deptIds).toContain(be);
    expect(full!.recent_logins).toHaveLength(2);
    expect(full!.recent_logins.map((l) => l.result).sort()).toEqual(['failed', 'success']);
    expect(await orgService.getUserFull('nope')).toBeNull();
  });

  test('loginRecord.recordLogin success writes an event and last_login fields', async () => {
    const out = await orgService.createUser({ orgId: 'o1', username: 'l1', password: 'pw-12345678' });
    await loginRecord.recordLogin('o1', out.id, '10.0.0.1', 'mac', 'success');
    const ev = await testPool.query<{
      org_id: string;
      user_id: string;
      ip: string | null;
      device: string | null;
      result: string;
    }>(`SELECT org_id, user_id, ip, device, result FROM login_events`);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toEqual({
      org_id: 'o1',
      user_id: out.id,
      ip: '10.0.0.1',
      device: 'mac',
      result: 'success',
    });
    const u = (
      await testPool.query<{
        last_login_at: Date | null;
        last_login_ip: string | null;
        last_login_device: string | null;
      }>(`SELECT last_login_at, last_login_ip, last_login_device FROM users WHERE id=$1`, [out.id])
    ).rows[0];
    expect(u.last_login_at).toBeInstanceOf(Date);
    expect(u.last_login_ip).toBe('10.0.0.1');
    expect(u.last_login_device).toBe('mac');
  });

  test('loginRecord.recordLogin failed result leaves last_login fields untouched', async () => {
    const out = await orgService.createUser({ orgId: 'o1', username: 'l2', password: 'pw-12345678' });
    await loginRecord.recordLogin('o1', out.id, '10.0.0.9', 'win', 'failed');
    const ev = await testPool.query(`SELECT 1 FROM login_events WHERE user_id=$1`, [out.id]);
    expect(ev.rowCount).toBe(1);
    const u = (
      await testPool.query<{
        last_login_at: Date | null;
        last_login_ip: string | null;
        last_login_device: string | null;
      }>(`SELECT last_login_at, last_login_ip, last_login_device FROM users WHERE id=$1`, [out.id])
    ).rows[0];
    expect(u.last_login_at).toBeNull();
    expect(u.last_login_ip).toBeNull();
    expect(u.last_login_device).toBeNull();
  });
});
