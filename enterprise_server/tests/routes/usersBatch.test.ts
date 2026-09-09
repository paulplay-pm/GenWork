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
import { adminUserRoutes } from '../../src/routes/admin/users';

const app = () => {
  const a = new Hono();
  a.route('/', adminUserRoutes);
  return a;
};
const hdr = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const superToken = () => signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });

async function seedDepts(): Promise<{ eng: string; be: string; sales: string }> {
  const eng = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
  const be = await orgService.createDept({ orgId: 'o1', name: 'BE', code: 'BE', parentId: eng.id });
  const sales = await orgService.createDept({ orgId: 'o1', name: 'Sales', code: 'SALES', parentId: null });
  return { eng: eng.id, be: be.id, sales: sales.id };
}

/** A user with the built-in dept_admin role (data scope dept_and_below)
 * whose primary membership is `deptId`. dept_admin carries user:edit, so it
 * may POST /batch. */
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

async function userState(userId: string): Promise<{
  extra_roles: string[];
  status: string;
  password_hash: string;
  department_id: string | null;
}> {
  const r = await testPool.query<{
    extra_roles: string[];
    status: string;
    password_hash: string;
    department_id: string | null;
  }>(`SELECT extra_roles, status, password_hash, department_id FROM users WHERE id=$1`, [userId]);
  return r.rows[0]!;
}

async function batch(token: string, body: unknown): Promise<Response> {
  return app().request('/admin/users/batch', {
    method: 'POST',
    headers: hdr(token),
    body: JSON.stringify(body),
  });
}

describe('routes/admin/users batch', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
    await scopeApi.invalidate();
  });

  test('assign_role batch unions roles for both users + user_batch audit', async () => {
    const { eng } = await seedDepts();
    const a = await orgService.createUser({
      orgId: 'o1',
      username: 'm1',
      password: 'pw-12345678',
      primaryDeptId: eng,
    });
    const b = await orgService.createUser({
      orgId: 'o1',
      username: 'm2',
      password: 'pw-12345678',
      primaryDeptId: eng,
    });
    const res = await batch(await superToken(), {
      action: 'assign_role',
      userIds: [a.id, b.id],
      roleCodes: ['org_admin'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, affected: 2 });
    for (const u of [a, b]) {
      const st = await userState(u.id);
      expect(st.extra_roles).toContain('org_admin');
      expect(st.extra_roles).toContain('member'); // unioned, default kept
    }
    const rows = await auditRows('user_batch');
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(a.id);
    expect(rows[0].payload).toEqual({ action: 'assign_role', userIds: [a.id, b.id] });
  });

  test('batch targeting an out-of-scope user → 403 + route audit, NO writes', async () => {
    const { eng, sales } = await seedDepts();
    const inScope = await orgService.createUser({
      orgId: 'o1',
      username: 'm1',
      password: 'pw-12345678',
      primaryDeptId: eng,
    });
    const outScope = await orgService.createUser({
      orgId: 'o1',
      username: 'm2',
      password: 'pw-12345678',
      primaryDeptId: sales,
    });
    const t = await deptAdminToken(eng); // dept_and_below over {Eng, BE}
    const res = await batch(t, { action: 'disable', userIds: [inScope.id, outScope.id] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    // Fail-closed: even the in-scope target of the same batch is untouched.
    const inSt = await userState(inScope.id);
    const outSt = await userState(outScope.id);
    expect(inSt.status).toBe('active');
    expect(inSt.extra_roles).toEqual(['member']);
    expect(outSt.status).toBe('active');
    const denied = await testPool.query<{
      target_type: string | null;
      target_id: string | null;
      payload: { reason?: string; action?: string; userIds?: string[] };
    }>(`SELECT target_type, target_id, payload FROM audit_events WHERE action='admin_access_denied'`);
    expect(denied.rows).toHaveLength(1);
    expect(denied.rows[0].target_type).toBe('route');
    expect(denied.rows[0].target_id).toBe('/admin/users/batch');
    // The route-level denial carries the same axis-reason marker as the
    // per-user denials, so auditors filtering on payload.reason catch it.
    expect(denied.rows[0].payload).toEqual({
      reason: 'outside_scope',
      action: 'disable',
      userIds: [inScope.id, outScope.id],
    });
    expect(await auditRows('user_batch')).toHaveLength(0);
  });

  test('enable/disable batch flips status', async () => {
    const a = await orgService.createUser({ orgId: 'o1', username: 'm1', password: 'pw-12345678' });
    const b = await orgService.createUser({ orgId: 'o1', username: 'm2', password: 'pw-12345678' });
    const t = await superToken();
    const dis = await batch(t, { action: 'disable', userIds: [a.id, b.id] });
    expect(dis.status).toBe(200);
    expect((await userState(a.id)).status).toBe('disabled');
    expect((await userState(b.id)).status).toBe('disabled');
    const en = await batch(t, { action: 'enable', userIds: [a.id, b.id] });
    expect(en.status).toBe(200);
    expect((await userState(a.id)).status).toBe('active');
    expect((await userState(b.id)).status).toBe('active');
  });

  test('reset_password batch → 200 with tempPasswords and changed hashes', async () => {
    const a = await orgService.createUser({ orgId: 'o1', username: 'm1', password: 'pw-12345678' });
    const b = await orgService.createUser({ orgId: 'o1', username: 'm2', password: 'pw-12345678' });
    const hash = (id: string) =>
      testPool
        .query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id=$1`, [id])
        .then((r) => r.rows[0]!.password_hash);
    const [h1, h2] = await Promise.all([hash(a.id), hash(b.id)]);
    const res = await batch(await superToken(), { action: 'reset_password', userIds: [a.id, b.id] });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      ok: boolean;
      affected: number;
      tempPasswords: { userId: string; tempPassword: string }[];
    };
    expect(j.ok).toBe(true);
    expect(j.affected).toBe(2);
    expect(j.tempPasswords).toHaveLength(2);
    for (const tp of j.tempPasswords) {
      expect(tp.tempPassword).toEqual(expect.stringMatching(/^[A-Za-z0-9]{16}$/));
    }
    expect(new Set(j.tempPasswords.map((x) => x.userId))).toEqual(new Set([a.id, b.id]));
    expect(await hash(a.id)).not.toBe(h1);
    expect(await hash(b.id)).not.toBe(h2);
  });

  test('adjust_dept batch moves the primary junction to deptId', async () => {
    const { eng, sales } = await seedDepts();
    const a = await orgService.createUser({
      orgId: 'o1',
      username: 'm1',
      password: 'pw-12345678',
      primaryDeptId: eng,
    });
    const res = await batch(await superToken(), { action: 'adjust_dept', userIds: [a.id], deptId: sales });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, affected: 1 });
    const jm = await junctionMap(a.id);
    expect(jm.size).toBe(1);
    expect(jm.get(sales)).toBe(true);
    expect((await userState(a.id)).department_id).toBe(sales);
  });

  test('adjust_dept to an out-of-scope dept → 403 + audit, nothing moved', async () => {
    const { eng, sales } = await seedDepts();
    const a = await orgService.createUser({
      orgId: 'o1',
      username: 'm1',
      password: 'pw-12345678',
      primaryDeptId: eng,
    });
    const t = await deptAdminToken(eng);
    const res = await batch(t, { action: 'adjust_dept', userIds: [a.id], deptId: sales });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    const jm = await junctionMap(a.id);
    expect(jm.size).toBe(1);
    expect(jm.get(eng)).toBe(true);
    const denied = await testPool.query<{ target_type: string | null; target_id: string | null }>(
      `SELECT target_type, target_id FROM audit_events WHERE action='admin_access_denied'`,
    );
    expect(denied.rows).toHaveLength(1);
    expect(denied.rows[0].target_type).toBe('dept'); // the denied entity is the destination dept
    expect(denied.rows[0].target_id).toBe(sales);
  });

  test('batch with duplicate ids reports the deduped affected count', async () => {
    const a = await orgService.createUser({ orgId: 'o1', username: 'm1', password: 'pw-12345678' });
    const res = await batch(await superToken(), {
      action: 'disable',
      userIds: [a.id, a.id, a.id],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, affected: 1 });
    expect((await userState(a.id)).status).toBe('disabled');
  });

  test('cross-org userId in a batch → 403, org users untouched', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    const other = await orgService.createUser({
      orgId: 'o2',
      username: 'intruder',
      password: 'pw-12345678',
    });
    const mine = await orgService.createUser({
      orgId: 'o1',
      username: 'm1',
      password: 'pw-12345678',
    });
    const res = await batch(await superToken(), { action: 'disable', userIds: [mine.id, other.id] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect((await userState(mine.id)).status).toBe('active');
  });

  test('assign_role without roleCodes → 422; empty userIds → 422', async () => {
    const t = await superToken();
    expect((await batch(t, { action: 'assign_role', userIds: ['x'] })).status).toBe(422);
    expect((await batch(t, { action: 'enable', userIds: [] })).status).toBe(422);
  });
});
