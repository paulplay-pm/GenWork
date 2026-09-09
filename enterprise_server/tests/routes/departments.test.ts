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
import { orgService } from '../../src/org/orgService';
import { deptRoutes } from '../../src/routes/admin/departments';

const app = () => {
  const a = new Hono();
  a.route('/', deptRoutes);
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
 *  whose membership is `deptId` (createUser writes the primary junction). */
async function deptAdminToken(deptId: string, username = 'boss'): Promise<string> {
  const { id } = await orgService.createUser({
    orgId: 'o1',
    username,
    password: 'pw-12345678',
    departmentId: deptId,
  });
  return signToken({ sub: id, orgId: 'o1', roles: ['dept_admin'] });
}

async function addMember(deptId: string, username: string): Promise<void> {
  await orgService.createUser({
    orgId: 'o1',
    username,
    password: 'pw-12345678',
    departmentId: deptId,
  });
}

async function auditRows(action: string): Promise<{ target_id: string | null; payload: unknown }[]> {
  const r = await testPool.query<{ target_id: string | null; payload: unknown }>(
    `SELECT target_id, payload FROM audit_events WHERE action=$1`,
    [action]
  );
  return r.rows;
}

describe('routes/admin/departments', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
    await scopeApi.invalidate();
  });

  test('403 when the role lacks dept:view', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['member'] });
    const res = await app().request('/admin/departments?orgId=o1', { headers: hdr(t) });
    expect(res.status).toBe(403);
  });

  test('GET without orgId → 400', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['org_admin'] });
    const res = await app().request('/admin/departments', { headers: hdr(t) });
    expect(res.status).toBe(400);
  });

  test('GET tree with an orgId from another org → 400', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['org_admin'] });
    const res = await app().request('/admin/departments?orgId=o2', { headers: hdr(t) });
    expect(res.status).toBe(400);
  });

  test('org_admin gets the full tree with member rollup', async () => {
    const { eng, be, sales } = await seedDepts();
    await addMember(eng, 'm1');
    await addMember(be, 'm2');
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['org_admin'] });
    const res = await app().request('/admin/departments?orgId=o1', { headers: hdr(t) });
    expect(res.status).toBe(200);
    const tree = (await res.json()) as { id: string; name: string; directMembers: number; subtreeMembers: number; children: { id: string }[] }[];
    expect(tree.map((n) => n.name)).toEqual(['Eng', 'Sales']);
    const engNode = tree.find((n) => n.id === eng)!;
    expect(engNode.subtreeMembers).toBe(2);
    expect(engNode.children.map((c) => c.id)).toEqual([be]);
    expect(tree.find((n) => n.id === sales)).toBeDefined();
  });

  test('dept-scoped caller sees only their subtree', async () => {
    const { eng } = await seedDepts();
    const t = await deptAdminToken(eng);
    const res = await app().request('/admin/departments?orgId=o1', { headers: hdr(t) });
    expect(res.status).toBe(200);
    const tree = (await res.json()) as { id: string; name: string }[];
    expect(tree.map((n) => n.name)).toEqual(['Eng']); // Sales is out of scope
  });

  test('dept-scoped caller with no membership sees no structure', async () => {
    await seedDepts();
    const { id } = await orgService.createUser({
      orgId: 'o1',
      username: 'nobody',
      password: 'pw-12345678',
    });
    const t = await signToken({ sub: id, orgId: 'o1', roles: ['dept_admin'] });
    const res = await app().request('/admin/departments?orgId=o1', { headers: hdr(t) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('out-of-scope dept detail → 403 + admin_access_denied audit', async () => {
    const { eng, sales } = await seedDepts();
    const t = await deptAdminToken(eng);
    const res = await app().request(`/admin/departments/${sales}`, { headers: hdr(t) });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: 'forbidden' });
    const denied = await testPool.query<{ target_id: string }>(
      `SELECT target_id FROM audit_events WHERE action='admin_access_denied' AND target_type='dept'`
    );
    expect(denied.rows.map((r) => r.target_id)).toEqual([sales]);
  });

  test('in-scope dept detail → 200 with stats, breadcrumbs, members, canAct', async () => {
    const { eng, be } = await seedDepts();
    await addMember(be, 'm1');
    const t = await deptAdminToken(eng);
    const res = await app().request(`/admin/departments/${be}`, { headers: hdr(t) });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      id: string;
      canAct: boolean;
      stats: { direct: number; subtree: number; childrenCount: number };
      breadcrumbs: { id: string; name: string }[];
      members: { username: string }[];
    };
    expect(detail.id).toBe(be);
    expect(detail.canAct).toBe(true);
    expect(detail.stats).toEqual({ direct: 1, subtree: 1, childrenCount: 0 });
    expect(detail.breadcrumbs.map((b) => b.name)).toEqual(['Eng', 'BE']);
    expect(detail.members.map((m) => m.username)).toEqual(['m1']);
  });

  test('unknown dept detail → 404', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/departments/nope', { headers: hdr(t) });
    expect(res.status).toBe(404);
  });

  test('PATCH on an out-of-scope dept → 403', async () => {
    const { eng, sales } = await seedDepts();
    const t = await deptAdminToken(eng);
    const res = await app().request(`/admin/departments/${sales}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ name: 'Hacked' }),
    });
    expect(res.status).toBe(403);
    const name = (
      await testPool.query<{ name: string }>(`SELECT name FROM departments WHERE id=$1`, [sales])
    ).rows[0].name;
    expect(name).toBe('Sales');
  });

  test('PATCH on a dept from another org → 404 (no cross-org mutation)', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    const other = await orgService.createDept({ orgId: 'o2', name: 'X', code: 'X', parentId: null });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/departments/${other.id}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ name: 'Hacked' }),
    });
    expect(res.status).toBe(404);
    const name = (
      await testPool.query<{ name: string }>(`SELECT name FROM departments WHERE id=$1`, [other.id])
    ).rows[0].name;
    expect(name).toBe('X');
  });

  test('DELETE on a dept from another org → 404', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    const other = await orgService.createDept({ orgId: 'o2', name: 'X', code: 'X', parentId: null });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/departments/${other.id}`, {
      method: 'DELETE',
      headers: hdr(t),
    });
    expect(res.status).toBe(404);
    const row = await testPool.query(`SELECT id FROM departments WHERE id=$1`, [other.id]);
    expect(row.rowCount).toBe(1);
  });

  test('POST creates a dept and writes dept_create audit', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/departments', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ orgId: 'o1', name: 'New', code: 'NEW', parentId: null }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { id: string; path: string };
    expect(j.path).toBe('/New');
    const rows = await auditRows('dept_create');
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(j.id);
  });

  test('POST with an out-of-scope parentId → 403 + audit, nothing created', async () => {
    const { be, sales } = await seedDepts();
    const t = await deptAdminToken(be); // dept_and_below over {BE} only
    const res = await app().request('/admin/departments', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ orgId: 'o1', name: 'X', code: 'X', parentId: sales }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: 'forbidden' });
    const denied = await testPool.query<{ target_id: string }>(
      `SELECT target_id FROM audit_events WHERE action='admin_access_denied' AND target_type='dept'`
    );
    expect(denied.rows.map((r) => r.target_id)).toEqual([sales]);
    const created = await testPool.query(
      `SELECT id FROM departments WHERE org_id='o1' AND name='X'`
    );
    expect(created.rowCount).toBe(0);
  });

  test('POST parentId:null rejected under a dept scope, allowed under all', async () => {
    const { be } = await seedDepts();
    const scoped = await deptAdminToken(be);
    const denied = await app().request('/admin/departments', {
      method: 'POST',
      headers: hdr(scoped),
      body: JSON.stringify({ orgId: 'o1', name: 'Root2', code: 'R2', parentId: null }),
    });
    expect(denied.status).toBe(403);
    const created = await testPool.query(
      `SELECT id FROM departments WHERE org_id='o1' AND name='Root2'`
    );
    expect(created.rowCount).toBe(0);
    const admin = await signToken({ sub: 'u', orgId: 'o1', roles: ['org_admin'] });
    const ok = await app().request('/admin/departments', {
      method: 'POST',
      headers: hdr(admin),
      body: JSON.stringify({ orgId: 'o1', name: 'Root2', code: 'R2', parentId: null }),
    });
    expect(ok.status).toBe(200);
  });

  test('POST duplicate code → 409', async () => {
    await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/departments', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ orgId: 'o1', name: 'Other', code: 'ENG', parentId: null }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: 'duplicate_code' });
  });

  test('POST with an invalid body → 422', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/departments', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'no-org' }),
    });
    expect(res.status).toBe(422);
  });

  test('PATCH with a code change → 422', async () => {
    const { eng } = await seedDepts();
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/departments/${eng}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ code: 'NEW' }),
    });
    expect(res.status).toBe(422);
  });

  test('PATCH rename rewrites subtree paths and writes dept_update audit', async () => {
    const { eng, be } = await seedDepts();
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/departments/${eng}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ name: 'Engineering' }),
    });
    expect(res.status).toBe(200);
    const path = (
      await testPool.query<{ path: string }>(`SELECT path FROM departments WHERE id=$1`, [be])
    ).rows[0].path;
    expect(path).toBe('/Engineering/BE');
    const rows = await auditRows('dept_update');
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as { before: { name: string }; after: { name: string } };
    expect(payload.before.name).toBe('Eng');
    expect(payload.after.name).toBe('Engineering');
  });

  test('PATCH re-parent writes dept_move audit and re-prefixes paths', async () => {
    const { eng, be, sales } = await seedDepts();
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/departments/${be}`, {
      method: 'PATCH',
      headers: hdr(t),
      body: JSON.stringify({ parentId: sales }),
    });
    expect(res.status).toBe(200);
    const path = (
      await testPool.query<{ path: string }>(`SELECT path FROM departments WHERE id=$1`, [be])
    ).rows[0].path;
    expect(path).toBe('/Sales/BE');
    const engPath = (
      await testPool.query<{ path: string }>(`SELECT path FROM departments WHERE id=$1`, [eng])
    ).rows[0].path;
    expect(engPath).toBe('/Eng');
    const rows = await auditRows('dept_move');
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(be);
  });

  test('DELETE blocked by direct members → 409 has_members', async () => {
    const { eng } = await seedDepts();
    await addMember(eng, 'm1');
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/departments/${eng}`, {
      method: 'DELETE',
      headers: hdr(t),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: 'has_members' });
  });

  test('DELETE blocked by children → 409 has_children', async () => {
    const { eng } = await seedDepts();
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/departments/${eng}`, {
      method: 'DELETE',
      headers: hdr(t),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: 'has_children' });
  });

  test('DELETE an empty leaf dept → 200 + dept_delete audit', async () => {
    const { be } = await seedDepts();
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request(`/admin/departments/${be}`, {
      method: 'DELETE',
      headers: hdr(t),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query(`SELECT id FROM departments WHERE id=$1`, [be]);
    expect(row.rowCount).toBe(0);
    const rows = await auditRows('dept_delete');
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(be);
  });

  test('reorder updates sort order and writes dept_reorder audit', async () => {
    const { eng, be } = await seedDepts();
    const b2 = await orgService.createDept({ orgId: 'o1', name: 'B2', code: 'B2', parentId: eng });
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/departments/reorder', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ orgId: 'o1', parentId: eng, orderedIds: [b2.id, be] }),
    });
    expect(res.status).toBe(200);
    const sorts = new Map(
      (
        await testPool.query<{ id: string; sort: number }>(
          `SELECT id, sort FROM departments WHERE org_id='o1'`
        )
      ).rows.map((r) => [r.id, r.sort])
    );
    expect(sorts.get(b2.id)).toBe(1);
    expect(sorts.get(be)).toBe(2);
    const rows = await auditRows('dept_reorder');
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(eng);
  });

  test('reorder with an invalid body → 422', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/departments/reorder', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ orgId: 'o1', parentId: null }),
    });
    expect(res.status).toBe(422);
  });

  test('reorder of root depts under a dept scope → 403, sorts untouched', async () => {
    const { eng, be, sales } = await seedDepts();
    const t = await deptAdminToken(be); // dept_and_below over {BE} only
    const res = await app().request('/admin/departments/reorder', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ orgId: 'o1', parentId: null, orderedIds: [sales, eng] }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: 'forbidden' });
    const sorts = new Map(
      (
        await testPool.query<{ id: string; sort: number }>(
          `SELECT id, sort FROM departments WHERE org_id='o1'`
        )
      ).rows.map((r) => [r.id, r.sort])
    );
    expect(sorts.get(eng)).toBe(100);
    expect(sorts.get(sales)).toBe(100);
    const rows = await auditRows('dept_reorder');
    expect(rows).toHaveLength(0);
  });
});
