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
import { parseCsv, toCsv } from '../../src/org/csv';
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

/** A dept-scoped caller (data_scope dept_and_below) carrying user:export —
 * the built-in dept_admin role lacks user:export, so grant a custom role. */
async function deptExporterToken(deptId: string): Promise<string> {
  await testPool.query(
    `INSERT INTO roles(id, name, data_scope, permissions)
     VALUES ('r1', 'exporter', 'dept_and_below', '["user:view","user:export"]'::jsonb)`,
  );
  roleResolver.invalidate();
  const { id } = await orgService.createUser({
    orgId: 'o1',
    username: 'exporter',
    password: 'pw-12345678',
    primaryDeptId: deptId,
  });
  return signToken({ sub: id, orgId: 'o1', roles: ['exporter'] });
}

async function junctionMap(userId: string): Promise<Map<string, boolean>> {
  const r = await testPool.query<{ dept_id: string; is_primary: boolean }>(
    `SELECT dept_id, is_primary FROM user_departments WHERE user_id=$1`,
    [userId],
  );
  return new Map(r.rows.map((x) => [x.dept_id, x.is_primary]));
}

async function findByUsername(
  username: string
): Promise<{ id: string; email: string | null; extra_roles: string[] } | null> {
  const r = await testPool.query<{ id: string; email: string | null; extra_roles: string[] }>(
    `SELECT id, email, extra_roles FROM users WHERE username=$1`,
    [username],
  );
  return r.rows[0] ?? null;
}

interface ImportResult {
  created: number;
  skipped: number;
  errors: { row: number; reason: string }[];
  tempPasswords: { username: string; tempPassword: string }[];
}

async function doImport(csv: string): Promise<{ status: number; body: ImportResult }> {
  const res = await app().request('/admin/users/import', {
    method: 'POST',
    headers: hdr(await superToken()),
    body: JSON.stringify({ orgId: 'o1', csv }),
  });
  return { status: res.status, body: (await res.json()) as ImportResult };
}

describe('routes/admin/users csv', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
    await scopeApi.invalidate();
  });

  test('export returns a scope-filtered CSV with headers, one row per visible user', async () => {
    const { eng, sales } = await seedDepts();
    await orgService.createUser({
      orgId: 'o1',
      username: 'm1',
      password: 'pw-12345678',
      primaryDeptId: eng,
      email: 'm1@t.test',
    });
    await orgService.createUser({
      orgId: 'o1',
      username: 'm2',
      password: 'pw-12345678',
      primaryDeptId: sales,
    });
    const res = await app().request('/admin/users/export?orgId=o1', { headers: hdr(await superToken()) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="users.csv"');
    const rows = parseCsv(await res.text());
    expect(rows[0]).toEqual([
      'username',
      'display_name',
      'email',
      'phone',
      'position',
      'level',
      'primary_dept_code',
      'roles',
      'status',
      'timezone',
    ]);
    expect(rows).toHaveLength(3); // header + 2 users
    const byName = new Map(rows.slice(1).map((r) => [r[0], r]));
    expect(byName.get('m1')?.[6]).toBe('ENG');
    expect(byName.get('m1')?.[7]).toBe('member');
    expect(byName.get('m1')?.[8]).toBe('active');
    expect(byName.get('m2')?.[6]).toBe('SALES');
  });

  test('dept-scoped caller export EXCLUDES other-dept users', async () => {
    const { eng, sales } = await seedDepts();
    await orgService.createUser({
      orgId: 'o1',
      username: 'm1',
      password: 'pw-12345678',
      primaryDeptId: eng,
    });
    await orgService.createUser({
      orgId: 'o1',
      username: 'm3',
      password: 'pw-12345678',
      primaryDeptId: sales,
    });
    const t = await deptExporterToken(eng);
    const res = await app().request('/admin/users/export?orgId=o1', { headers: hdr(t) });
    expect(res.status).toBe(200);
    const rows = parseCsv(await res.text());
    const names = rows.slice(1).map((r) => r[0]).sort();
    // The caller (exporter, in Eng) + m1 (Eng); m3 (Sales) is out of scope.
    expect(names).toEqual(['exporter', 'm1']);
  });

  test('export without orgId / other orgId → 400', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    const t = await superToken();
    expect((await app().request('/admin/users/export', { headers: hdr(t) })).status).toBe(400);
    expect((await app().request('/admin/users/export?orgId=o2', { headers: hdr(t) })).status).toBe(
      400
    );
  });

  test('import well-formed CSV → 2 users, junction written, tempPasswords', async () => {
    const { eng } = await seedDepts();
    const csv = [
      'username,display_name,email,primary_dept_code,roles',
      'imp1,Imp One,imp1@t.test,ENG,org_admin',
      'imp2,Imp Two,imp2@t.test,,member',
    ].join('\n');
    const { status, body } = await doImport(csv);
    expect(status).toBe(200);
    expect(body.created).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.errors).toEqual([]);
    expect(body.tempPasswords).toHaveLength(2);
    for (const tp of body.tempPasswords) {
      expect(tp.tempPassword).toEqual(expect.stringMatching(/^[A-Za-z0-9]{16}$/));
    }
    const imp1 = await findByUsername('imp1');
    expect(imp1).not.toBeNull();
    expect(imp1!.email).toBe('imp1@t.test');
    expect(imp1!.extra_roles).toEqual(expect.arrayContaining(['org_admin', 'member']));
    const jm = await junctionMap(imp1!.id);
    expect(jm.get(eng)).toBe(true);
    const imp2 = await findByUsername('imp2');
    expect(imp2).not.toBeNull();
    expect(imp2!.extra_roles).toEqual(['member']);
    expect(await junctionMap(imp2!.id)).toEqual(new Map());
    // Every imported user is audited like a single create: N user_create
    // rows, target_user_id set, source marked csv_import.
    const created = await testPool.query<{
      user_id: string | null;
      target_user_id: string | null;
      target_type: string | null;
      payload: { username: string; source: string };
    }>(`SELECT user_id, target_user_id, target_type, payload FROM audit_events WHERE action='user_create'`);
    expect(created.rows).toHaveLength(2);
    for (const row of created.rows) {
      expect(row.user_id).toBe('u');
      expect(row.target_type).toBe('user');
      expect(row.target_user_id).not.toBeNull();
      expect(row.payload.source).toBe('csv_import');
    }
    expect(new Set(created.rows.map((r) => r.payload.username))).toEqual(new Set(['imp1', 'imp2']));
    for (const row of created.rows) {
      const u = await findByUsername(row.payload.username);
      expect(u!.id).toBe(row.target_user_id);
    }
  });

  test('unexpected error mid-import → 500 with the partial result', async () => {
    const original = orgService.createUser.bind(orgService);
    const spy = vi
      .spyOn(orgService, 'createUser')
      .mockImplementation(async (input) => {
        if (input.username === 'boom') throw new Error('db exploded');
        return original(input);
      });
    try {
      const csv = ['username,roles', 'ok1,member', 'boom,member', 'ok2,member'].join('\n');
      const res = await app().request('/admin/users/import', {
        method: 'POST',
        headers: hdr(await superToken()),
        body: JSON.stringify({ orgId: 'o1', csv }),
      });
      expect(res.status).toBe(500);
      const j = (await res.json()) as {
        error: string;
        created: number;
        skipped: number;
        errors: unknown[];
        tempPasswords: { username: string; tempPassword: string }[];
      };
      expect(j.error).toBe('partial_import_failed');
      expect(j.created).toBe(1); // rows before the failing row still landed
      expect(j.tempPasswords).toHaveLength(1);
      expect(j.tempPasswords[0]!.username).toBe('ok1');
      expect(await findByUsername('ok1')).not.toBeNull();
      expect(await findByUsername('boom')).toBeNull();
      expect(await findByUsername('ok2')).toBeNull(); // loop halted at the failing row
    } finally {
      spy.mockRestore();
    }
  });

  test('import over 1000 data rows → 422 too_many_rows, nothing created', async () => {
    const lines = ['username,roles'];
    for (let i = 0; i < 1001; i += 1) lines.push(`bulk${i},member`);
    const res = await app().request('/admin/users/import', {
      method: 'POST',
      headers: hdr(await superToken()),
      body: JSON.stringify({ orgId: 'o1', csv: lines.join('\n') }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'too_many_rows', limit: 1000 });
    const count = await testPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    expect(count.rows[0].n).toBe(0);
  });

  test('import bad rows → errors collected, bad rows NOT created', async () => {
    await orgService.createUser({ orgId: 'o1', username: 'taken', password: 'pw-12345678' });
    const csv = [
      'username,roles',
      'good1,member', // row 2 — good
      'good1,member', // row 3 — duplicate within the batch
      'taken,member', // row 4 — existing org username
      'carol,member;ghost_role', // row 5 — unknown role code
    ].join('\n');
    const { status, body } = await doImport(csv);
    expect(status).toBe(200);
    expect(body.created).toBe(1);
    expect(body.skipped).toBe(3);
    expect(body.errors).toHaveLength(3);
    expect(body.errors.map((e) => e.row)).toEqual([3, 4, 5]);
    expect(body.errors[0]!.reason).toContain('good1');
    expect(body.errors[1]!.reason).toContain('taken');
    expect(body.errors[2]!.reason).toContain('ghost_role');
    expect(await findByUsername('carol')).toBeNull();
    expect(await findByUsername('good1')).not.toBeNull();
    const takenCount = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE username='taken'`
    );
    expect(takenCount.rows[0].n).toBe(1);
  });

  test('import with a deptCode that does not exist → row error, not created', async () => {
    const csv = ['username,primary_dept_code', 'newguy,NOSUCH'].join('\n');
    const { status, body } = await doImport(csv);
    expect(status).toBe(200);
    expect(body.created).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.errors).toEqual([{ row: 2, reason: 'unknown department code "NOSUCH"' }]);
    expect(await findByUsername('newguy')).toBeNull();
  });

  test('import org mismatch → 400', async () => {
    const res = await app().request('/admin/users/import', {
      method: 'POST',
      headers: hdr(await superToken()),
      body: JSON.stringify({ orgId: 'o2', csv: 'username\nx' }),
    });
    expect(res.status).toBe(400);
  });

  test('toCsv/parseCsv round-trips commas, embedded newlines, and quotes', () => {
    const columns = ['a', 'b', 'c'];
    const rows = [
      { a: 'plain', b: 'has,comma', c: 'has "quote"' },
      { a: 'line1\nline2', b: 'a"b"c', c: 'x' },
      { a: '', b: '', c: '' },
    ];
    expect(parseCsv(toCsv(rows, columns))).toEqual([
      ['a', 'b', 'c'], // header row
      ['plain', 'has,comma', 'has "quote"'],
      ['line1\nline2', 'a"b"c', 'x'],
      ['', '', ''],
    ]);
  });
});
