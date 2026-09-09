import '../helpers/setupEnv';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { splitStatements } from '../../src/db/migrate';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS = join(__dirname, '../../src/db/migrations');

/** Execute one migration file through the same single-statement path production uses. */
async function applyMigrationFile(file: string): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  for (const stmt of splitStatements(sql)) {
    await testPool.query(stmt);
  }
}

describe('migration 032 (model_catalog multi-type)', () => {
  test('adds types and backfills from the legacy type column', async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A')`);
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, is_builtin) VALUES ('p1','o1','openai', true)`,
    );
    // Seed legacy rows as if they predated 032, then re-apply 032 statement
    // by statement (same idiom as tests/migrations/migration030.test.ts):
    // the one-off backfill UPDATE only sees rows present at apply time, and
    // the chain run above already applied 032 to an empty table.
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, type)
       VALUES
         ('m1','o1','p1','openai','a','image'),
         ('m2','o1','p1','openai','b','audio'),
         ('m3','o1','p1','openai','c','reasoning'),
         ('m4','o1','p1','openai','d','chat')`,
    );
    await applyMigrationFile('032_model_multi_type.sql');
    const rows = await testPool.query<{ model: string; types: string[] }>(
      `SELECT model, types FROM model_catalog ORDER BY model`,
    );
    const byModel = Object.fromEntries(rows.rows.map((r) => [r.model, r.types]));
    expect(byModel.a).toEqual(['image-gen']);
    expect(byModel.b).toEqual(['asr']);
    expect(byModel.c).toEqual(['reasoning']);
    expect(byModel.d).toEqual(['chat']);
  });
});
