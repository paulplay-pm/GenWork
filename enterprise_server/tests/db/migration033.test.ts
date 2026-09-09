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

describe('migration 033 (provider_keys protocol backfill)', () => {
  test('recovers the protocol for pre-031 custom anthropic rows, leaves built-ins untouched', async () => {
    await resetSchema();
    await runMigrations();
    // Simulate the live-DB shape 033 fixes: a CUSTOM anthropic row that
    // predated 031's `protocol` column. 031 already ran during the chain above
    // (on an empty table), so its NOT NULL DEFAULT stamped 'openai' — the
    // INSERT below omits `protocol` and picks up that same default.
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A')`);
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, is_builtin) VALUES ('p1','o1','anthropic', false)`,
    );
    // And the seeded BUILT-IN anthropic row (already protocol='anthropic').
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, is_builtin, protocol)
       VALUES ('p2','o1','anthropic', true, 'anthropic')`,
    );
    // The one-off backfill UPDATE only sees rows present at apply time, and
    // the chain run above already applied 033 to an empty table — re-apply the
    // 033 file to observe it (same idiom as tests/db/migration032.test.ts).
    await applyMigrationFile('033_provider_keys_protocol_backfill.sql');
    const custom = await testPool.query<{ protocol: string }>(
      `SELECT protocol FROM provider_keys WHERE id = 'p1'`,
    );
    expect(custom.rows[0].protocol).toBe('anthropic');
    // Built-in safety: the seeded built-in row is unchanged.
    const builtin = await testPool.query<{ protocol: string }>(
      `SELECT protocol FROM provider_keys WHERE id = 'p2'`,
    );
    expect(builtin.rows[0].protocol).toBe('anthropic');
    // Idempotency: a second apply is a no-op (no error, no change).
    await applyMigrationFile('033_provider_keys_protocol_backfill.sql');
    const again = await testPool.query<{ protocol: string }>(
      `SELECT protocol FROM provider_keys WHERE id = 'p1'`,
    );
    expect(again.rows[0].protocol).toBe('anthropic');
  });
});
