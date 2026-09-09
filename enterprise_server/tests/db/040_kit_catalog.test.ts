import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

async function cols(table: string): Promise<Set<string>> {
  const r = await testPool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

describe('migration 040 kit_catalog', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('kit_catalog has the required columns', async () => {
    const c = await cols('kit_catalog');
    for (const col of ['slug', 'org_id', 'category_id', 'name_en', 'name_zh', 'description_en',
      'description_zh', 'icon_url', 'author', 'version', 'try_asking', 'skill_list', 'scope',
      'enabled', 'is_builtin', 'zip_file_name', 'zip_file_size', 'zip_sha256', 'created_at', 'updated_at']) {
      expect(c.has(col)).toBe(true);
    }
  });

  test('kit_categories has localized names + org scoping + reserved flag', async () => {
    const c = await cols('kit_categories');
    for (const col of ['category_id', 'name_zh', 'name_en', 'display_order', 'org_id', 'is_reserved']) {
      expect(c.has(col)).toBe(true);
    }
  });

  test('org creation seeds the reserved uncategorized bucket', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1')`);
    const r = await testPool.query(
      `SELECT category_id, is_reserved FROM kit_categories WHERE org_id = 'o1' AND category_id = 'uncategorized'`);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].is_reserved).toBe(true);
  });

  test('grants kit points to org_admin/super_admin', async () => {
    const r = await testPool.query(
      `SELECT name, permissions FROM roles WHERE name IN ('org_admin','super_admin')`);
    for (const row of r.rows) {
      expect(row.permissions).toContain('kit:view');
      expect(row.permissions).toContain('kit:create');
      expect(row.permissions).toContain('kit:delete');
    }
  });
});
