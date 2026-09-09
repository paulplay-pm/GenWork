import '../helpers/setupEnv';

import { randomUUID } from 'node:crypto';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { BUILTIN_KIT_CATEGORIES, BUILTIN_KITS, seedBuiltinKits } from '../../src/org/builtinKits';

/** Write a tiny valid zip named <name> into dir. Bytes are irrelevant to the seed
 * (it only sha256s + copies them), so a 1-SKILL.md fixture satisfies parseKitZip. */
function makeZip(dir: string, name: string): void {
  const z = new AdmZip();
  z.addFile(`${name}/SKILL.md`, Buffer.from('# s\n'));
  z.writeZip(join(dir, name));
}

describe('seedBuiltinKits', () => {
  let seedDir: string;
  let orgId: string;
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    seedDir = mkdtempSync(join(tmpdir(), 'kitseed-'));
    process.env.KITS_SEED_DIR = seedDir;
    for (const k of BUILTIN_KITS) makeZip(seedDir, k.seedZipFile);
    const r = await testPool.query('INSERT INTO orgs(id, name) VALUES ($1,$2) RETURNING id', [`org-${randomUUID().slice(0, 8)}`, 'T']);
    orgId = r.rows[0].id as string;
  });
  afterEach(() => { delete process.env.KITS_SEED_DIR; });

  test('seeds all built-in kits + categories with all-company scope', async () => {
    await seedBuiltinKits(orgId);
    const kits = await testPool.query(
      `SELECT slug, scope, enabled, is_builtin, author FROM kit_catalog WHERE org_id = $1 ORDER BY slug`, [orgId]);
    expect(kits.rowCount).toBe(BUILTIN_KITS.length);
    for (const row of kits.rows) {
      expect(row.enabled).toBe(true);
      expect(row.is_builtin).toBe(true);
      expect(row.author).toBe('GenWork');
      expect(row.scope).toEqual({ allCompany: true, deptIds: [], userIds: [] });
    }
    const cats = await testPool.query(`SELECT category_id FROM kit_categories WHERE org_id = $1`, [orgId]);
    expect(cats.rowCount).toBeGreaterThanOrEqual(BUILTIN_KIT_CATEGORIES.length);
  });

  test('is idempotent: a second run adds nothing', async () => {
    await seedBuiltinKits(orgId);
    await seedBuiltinKits(orgId);
    const r = await testPool.query(`SELECT count(*)::int AS n FROM kit_catalog WHERE org_id = $1`, [orgId]);
    expect(r.rows[0].n).toBe(BUILTIN_KITS.length);
  });

  test('skips a missing and a corrupt seed file without throwing', async () => {
    const missing = BUILTIN_KITS[0].slug;
    const corrupt = BUILTIN_KITS[1].slug;
    unlinkSync(join(seedDir, `${missing}.zip`));          // missing
    writeFileSync(join(seedDir, `${corrupt}.zip`), 'not a zip'); // corrupt on purpose
    await expect(seedBuiltinKits(orgId)).resolves.toBeUndefined();
    const absent = await testPool.query(
      `SELECT count(*)::int AS n FROM kit_catalog WHERE org_id = $1 AND slug IN ($2,$3)`, [orgId, missing, corrupt]);
    expect(absent.rows[0].n).toBe(0);
    const total = await testPool.query(`SELECT count(*)::int AS n FROM kit_catalog WHERE org_id = $1`, [orgId]);
    expect(total.rows[0].n).toBe(BUILTIN_KITS.length - 2);
  });
});
