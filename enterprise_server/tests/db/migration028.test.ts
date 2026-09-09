import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => { const td = await import('../../src/db/testDb'); return { pool: td.testPool }; });
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 028', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  const colsOf = async (table: string, cols: string[]) => {
    const r = await testPool.query<{ cols: string[] }>(
      `SELECT array_agg(column_name) AS cols FROM information_schema.columns
       WHERE table_name=$1 AND column_name = ANY($2)`, [table, cols]);
    return r.rows[0].cols;
  };

  test('roles gains v2 columns', async () => {
    expect((await colsOf('roles', ['display_name','data_scope','custom_dept_ids','is_builtin'])).sort())
      .toEqual(['custom_dept_ids','data_scope','display_name','is_builtin'].sort());
  });
  test('departments gains v2 columns + unique (org_id, code)', async () => {
    expect((await colsOf('departments', ['code','leader_id','sort','description'])).sort())
      .toEqual(['code','description','leader_id','sort'].sort());
    const uq = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM pg_indexes WHERE tablename='departments' AND indexdef LIKE 'CREATE UNIQUE INDEX%USING btree (org_id, code)'`);
    expect(uq.rows[0].n).toBe(1);
  });
  test('users gains profile + login columns', async () => {
    expect((await colsOf('users', ['email','phone','position','level','joined_at','last_login_at','last_login_ip','last_login_device'])).sort())
      .toEqual(['email','joined_at','last_login_at','last_login_device','last_login_ip','level','phone','position'].sort());
  });
  test('creates user_departments and login_events', async () => {
    const t = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM information_schema.tables
       WHERE table_name IN ('user_departments','login_events')`);
    expect(t.rows[0].n).toBe(2);
  });
  test('is idempotent (re-run safe)', async () => {
    await resetSchema(); await runMigrations();
    const t = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name='user_departments'`);
    expect(t.rows[0].n).toBe(1);
  });
});
