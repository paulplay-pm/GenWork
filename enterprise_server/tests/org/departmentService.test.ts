import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { DeptError, DeptGuardError, orgService } from '../../src/org/orgService';

/** Create a user directly in a department (createUser writes the primary
 * `user_departments` junction). */
async function addMember(orgId: string, deptId: string, username: string): Promise<string> {
  const { id } = await orgService.createUser({
    orgId,
    username,
    password: 'pw-12345678',
    departmentId: deptId,
  });
  return id;
}

describe('org/orgService departments v2', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Acme')`);
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Beta')`);
  });

  test('createDept stores code/leader/sort/description and builds path', async () => {
    const leader = await orgService.createUser({
      orgId: 'o1',
      username: 'lead',
      password: 'pw-12345678',
    });
    const { id, path } = await orgService.createDept({
      orgId: 'o1',
      name: 'Eng',
      code: 'ENG',
      parentId: null,
      leaderId: leader.id,
      sort: 1,
      description: 'eng desc',
    });
    expect(path).toBe('/Eng');
    const row = await testPool.query<{
      code: string | null;
      sort: number;
      description: string | null;
      leader_id: string | null;
    }>(`SELECT code, sort, description, leader_id FROM departments WHERE id=$1`, [id]);
    expect(row.rows[0]).toEqual({
      code: 'ENG',
      sort: 1,
      description: 'eng desc',
      leader_id: leader.id,
    });
  });

  test('createDept builds nested path from parent', async () => {
    const root = await orgService.createDept({ orgId: 'o1', name: 'Root', code: 'ROOT', parentId: null });
    const child = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: root.id });
    expect(child.path).toBe('/Root/Eng');
  });

  test('createDept rejects a duplicate code in the same org (unique per org)', async () => {
    await orgService.createDept({ orgId: 'o1', name: 'A', code: 'X', parentId: null });
    await expect(
      orgService.createDept({ orgId: 'o1', name: 'B', code: 'X', parentId: null }),
    ).rejects.toThrow(DeptError);
    // Same code in a different org is allowed (uniqueness is per-org).
    const other = await orgService.createDept({ orgId: 'o2', name: 'B', code: 'X', parentId: null });
    expect(other.path).toBe('/B');
  });

  test('createDept rejects an unknown parent', async () => {
    await expect(
      orgService.createDept({ orgId: 'o1', name: 'A', code: 'A', parentId: 'does-not-exist' }),
    ).rejects.toThrow(DeptError);
  });

  test('moveDept rewrites subtree paths without double prefix', async () => {
    const root = await orgService.createDept({ orgId: 'o1', name: 'Root', code: 'ROOT', parentId: null });
    const a = await orgService.createDept({ orgId: 'o1', name: 'A', code: 'A', parentId: root.id });
    const ab = await orgService.createDept({ orgId: 'o1', name: 'AB', code: 'AB', parentId: a.id });
    await orgService.moveDept(a.id, null); // move A to top level
    const pathA = (
      await testPool.query<{ path: string }>(`SELECT path FROM departments WHERE id=$1`, [a.id])
    ).rows[0].path;
    const pathAB = (
      await testPool.query<{ path: string }>(`SELECT path FROM departments WHERE id=$1`, [ab.id])
    ).rows[0].path;
    expect(pathA).toBe('/A');
    expect(pathAB).toBe('/A/AB');
    // The old root is untouched.
    const pathRoot = (
      await testPool.query<{ path: string }>(`SELECT path FROM departments WHERE id=$1`, [root.id])
    ).rows[0].path;
    expect(pathRoot).toBe('/Root');
  });

  test('moveDept into another subtree re-prefixes the whole subtree', async () => {
    const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    const be = await orgService.createDept({ orgId: 'o1', name: 'BE', code: 'BE', parentId: eng.id });
    const beSub = await orgService.createDept({ orgId: 'o1', name: 'BE2', code: 'BE2', parentId: be.id });
    const sales = await orgService.createDept({ orgId: 'o1', name: 'Sales', code: 'SALES', parentId: null });
    await orgService.moveDept(be.id, sales.id);
    const paths = new Map(
      (
        await testPool.query<{ id: string; path: string }>(
          `SELECT id, path FROM departments WHERE org_id='o1'`
        )
      ).rows.map((r) => [r.id, r.path]),
    );
    expect(paths.get(be.id)).toBe('/Sales/BE');
    expect(paths.get(beSub.id)).toBe('/Sales/BE/BE2'); // no '/Sales/BE/BE/BE2' double prefix
    expect(paths.get(eng.id)).toBe('/Eng');
  });

  test('moveDept rejects moving a dept under its own descendant (cycle)', async () => {
    const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    const ab = await orgService.createDept({ orgId: 'o1', name: 'AB', code: 'AB', parentId: eng.id });
    const abc = await orgService.createDept({ orgId: 'o1', name: 'ABC', code: 'ABC', parentId: ab.id });
    await expect(orgService.moveDept(eng.id, abc.id)).rejects.toThrow(DeptError);
    // And the cycle is not persisted.
    const path = (
      await testPool.query<{ path: string }>(`SELECT path FROM departments WHERE id=$1`, [eng.id])
    ).rows[0].path;
    expect(path).toBe('/Eng');
  });

  test('moveDept rejects a parent from another org', async () => {
    const a = await orgService.createDept({ orgId: 'o1', name: 'A', code: 'A', parentId: null });
    const b = await orgService.createDept({ orgId: 'o2', name: 'B', code: 'B', parentId: null });
    await expect(orgService.moveDept(a.id, b.id)).rejects.toThrow(DeptError);
  });

  test('deleteDept throws has_members when it has direct members', async () => {
    const { id } = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    await addMember('o1', id, 'u1');
    let thrown: unknown;
    try {
      await orgService.deleteDept(id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DeptGuardError);
    expect((thrown as DeptGuardError).code).toBe('has_members');
    const row = await testPool.query(`SELECT id FROM departments WHERE id=$1`, [id]);
    expect(row.rowCount).toBe(1);
  });

  test('deleteDept throws has_children when it has child depts', async () => {
    const a = await orgService.createDept({ orgId: 'o1', name: 'A', code: 'A', parentId: null });
    await orgService.createDept({ orgId: 'o1', name: 'B', code: 'B', parentId: a.id });
    await expect(orgService.deleteDept(a.id)).rejects.toThrow(DeptGuardError);
  });

  test('deleteDept succeeds once members and children are gone', async () => {
    const a = await orgService.createDept({ orgId: 'o1', name: 'A', code: 'A', parentId: null });
    const b = await orgService.createDept({ orgId: 'o1', name: 'B', code: 'B', parentId: a.id });
    const u1 = await addMember('o1', b.id, 'u1');
    await orgService.moveDept(b.id, null);
    await testPool.query(`DELETE FROM user_departments WHERE user_id=$1`, [u1]);
    await testPool.query(`UPDATE users SET department_id=NULL WHERE id=$1`, [u1]);
    const before = await orgService.deleteDept(a.id);
    expect(before?.name).toBe('A');
    const row = await testPool.query(`SELECT id FROM departments WHERE id=$1`, [a.id]);
    expect(row.rowCount).toBe(0);
  });

  test('listDeptTree builds the tree with direct vs subtree member rollup', async () => {
    const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    const be = await orgService.createDept({ orgId: 'o1', name: 'BE', code: 'BE', parentId: eng.id });
    const sales = await orgService.createDept({ orgId: 'o1', name: 'Sales', code: 'SALES', parentId: null });
    await addMember('o1', eng.id, 'm1');
    await addMember('o1', eng.id, 'm2');
    await addMember('o1', be.id, 'm3');

    const tree = await orgService.listDeptTree('o1', { kind: 'all' });
    expect(tree.map((n) => n.name)).toEqual(['Eng', 'Sales']);
    const engNode = tree.find((n) => n.id === eng.id)!;
    const beNode = engNode.children.find((n) => n.id === be.id)!;
    expect(engNode.directMembers).toBe(2);
    expect(engNode.subtreeMembers).toBe(3);
    expect(beNode.directMembers).toBe(1);
    expect(beNode.subtreeMembers).toBe(1);
    const salesNode = tree.find((n) => n.id === sales.id)!;
    expect(salesNode.directMembers).toBe(0);
    expect(salesNode.subtreeMembers).toBe(0);
    expect(engNode.children).toHaveLength(1);
    expect(beNode.children).toHaveLength(0);
    expect(engNode).toMatchObject({
      code: 'ENG',
      parent_id: null,
      path: '/Eng',
      sort: 100,
      description: null,
      leader_id: null,
    });
  });

  test('listDeptTree filters to a dept scope, keeping visible depts connected', async () => {
    const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    const be = await orgService.createDept({ orgId: 'o1', name: 'BE', code: 'BE', parentId: eng.id });
    await orgService.createDept({ orgId: 'o1', name: 'Sales', code: 'SALES', parentId: null });

    // Scoped to Eng: subtree visible, Sales excluded.
    const sub = await orgService.listDeptTree('o1', { kind: 'dept', deptIds: [eng.id, be.id] });
    expect(sub.map((n) => n.name)).toEqual(['Eng']);
    expect(sub[0]!.children.map((n) => n.id)).toEqual([be.id]);

    // Scoped to a child only: it surfaces as a root (its parent is hidden).
    const childOnly = await orgService.listDeptTree('o1', { kind: 'dept', deptIds: [be.id] });
    expect(childOnly.map((n) => n.name)).toEqual(['BE']);
    expect(childOnly[0]!.parent_id).toBe(eng.id);

    // Self scope: no org structure at all.
    const self = await orgService.listDeptTree('o1', { kind: 'self' });
    expect(self).toEqual([]);
  });

  test('getDeptDetail returns base info, stats, breadcrumbs and members', async () => {
    const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    const be = await orgService.createDept({ orgId: 'o1', name: 'BE', code: 'BE', parentId: eng.id });
    const m1 = await addMember('o1', be.id, 'm1');
    await addMember('o1', eng.id, 'm2');
    await testPool.query(
      `UPDATE users SET email=$1, position=$2 WHERE id=$3`,
      ['m1@acme.test', 'Staff Eng', m1],
    );

    const detail = await orgService.getDeptDetail('o1', be.id, { kind: 'all' });
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(be.id);
    expect(detail!.code).toBe('BE');
    expect(detail!.stats).toEqual({ direct: 1, subtree: 1, childrenCount: 0 });
    expect(detail!.breadcrumbs).toEqual([
      { id: eng.id, name: 'Eng' },
      { id: be.id, name: 'BE' },
    ]);
    const m1row = detail!.members.find((m) => m.id === m1)!;
    expect(m1row).toMatchObject({
      username: 'm1',
      email: 'm1@acme.test',
      position: 'Staff Eng',
      status: 'active',
      extra_roles: ['member'], // default role for createUser (T7-3)
    });
    expect(detail!.members).toHaveLength(1); // only direct members of BE
    expect(detail!.canAct).toBe(true);
  });

  test('getDeptDetail canAct is false for a scope that excludes the dept', async () => {
    const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    const detail = await orgService.getDeptDetail('o1', eng.id, { kind: 'self' });
    expect(detail!.canAct).toBe(false);
  });

  test('getDeptDetail returns null for unknown dept or other org', async () => {
    const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    expect(await orgService.getDeptDetail('o1', 'nope', { kind: 'all' })).toBeNull();
    expect(await orgService.getDeptDetail('o2', eng.id, { kind: 'all' })).toBeNull();
  });

  test('updateDept rewrites subtree paths when the name changes', async () => {
    const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    const be = await orgService.createDept({ orgId: 'o1', name: 'BE', code: 'BE', parentId: eng.id });
    const { before, after } = await orgService.updateDept(eng.id, { name: 'Engineering' });
    expect(before.path).toBe('/Eng');
    expect(after.path).toBe('/Engineering');
    const paths = new Map(
      (
        await testPool.query<{ id: string; path: string }>(
          `SELECT id, path FROM departments WHERE org_id='o1'`
        )
      ).rows.map((r) => [r.id, r.path]),
    );
    expect(paths.get(be.id)).toBe('/Engineering/BE');
  });

  test('updateDept rejects a code change', async () => {
    const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    await expect(orgService.updateDept(eng.id, { code: 'NEW' })).rejects.toThrow(DeptError);
  });

  test('updateDept reparents and updates leader/sort/description', async () => {
    const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    const be = await orgService.createDept({ orgId: 'o1', name: 'BE', code: 'BE', parentId: eng.id });
    const sales = await orgService.createDept({ orgId: 'o1', name: 'Sales', code: 'SALES', parentId: null });
    const leader = await orgService.createUser({ orgId: 'o1', username: 'lead', password: 'pw-12345678' });

    const reparent = await orgService.updateDept(be.id, { parentId: sales.id });
    expect(reparent.after.parent_id).toBe(sales.id);
    expect(reparent.after.path).toBe('/Sales/BE');

    const meta = await orgService.updateDept(eng.id, {
      leaderId: leader.id,
      sort: 5,
      description: 'renamed desc',
    });
    expect(meta.after.leader_id).toBe(leader.id);
    expect(meta.after.sort).toBe(5);
    const row = await testPool.query<{ leader_id: string; sort: number; description: string }>(
      `SELECT leader_id, sort, description FROM departments WHERE id=$1`,
      [eng.id]
    );
    expect(row.rows[0]).toEqual({
      leader_id: leader.id,
      sort: 5,
      description: 'renamed desc',
    });
  });

  test('reorderSiblings assigns sort = index+1', async () => {
    const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    const b1 = await orgService.createDept({ orgId: 'o1', name: 'B1', code: 'B1', parentId: eng.id });
    const b2 = await orgService.createDept({ orgId: 'o1', name: 'B2', code: 'B2', parentId: eng.id });
    const items = await orgService.reorderSiblings('o1', eng.id, [b2.id, b1.id]);
    expect(items).toEqual([
      { id: b2.id, before: 100, after: 1 },
      { id: b1.id, before: 100, after: 2 },
    ]);
    const sorts = new Map(
      (
        await testPool.query<{ id: string; sort: number }>(
          `SELECT id, sort FROM departments WHERE org_id='o1'`
        )
      ).rows.map((r) => [r.id, r.sort]),
    );
    expect(sorts.get(b2.id)).toBe(1);
    expect(sorts.get(b1.id)).toBe(2);
  });
});
