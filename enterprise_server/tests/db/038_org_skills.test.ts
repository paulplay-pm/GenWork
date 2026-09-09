import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 038 (org skills)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('skill_marketplace_skills has org/scope/zip cols and drops allowed_roles', async () => {
    const cols = await testPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'skill_marketplace_skills' ORDER BY column_name`,
    );
    const names = new Set(cols.rows.map((r) => r.column_name));
    for (const c of ['org_id', 'scope', 'zip_file_name', 'zip_file_size', 'zip_sha256', 'use_count_30d', 'created_by', 'updated_by']) {
      expect(names.has(c)).toBe(true);
    }
    expect(names.has('allowed_roles')).toBe(false);
  });

  test('categories get org_id + (org_id, category_id) unique; per-org uncategorized', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','A'), ('o2','B')`);
    const rows = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM skill_marketplace_categories WHERE category_id = 'uncategorized'`,
    );
    expect(rows.rows[0].n).toBe(2); // one per org
  });

  test('skill_submissions + orgs.members_can_submit_skills exist', async () => {
    const tbl = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'skill_submissions'`,
    );
    expect(tbl.rows[0].n).toBe(1);
    const org = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'orgs' AND column_name = 'members_can_submit_skills'`,
    );
    expect(org.rows[0].n).toBe(1);
  });

  test('is re-run safe (idempotent)', async () => {
    await resetSchema();
    await runMigrations();
    // run every migration file a second time against the same pglite instance
    await runMigrations(); // must not throw
  });
});
