import '../helpers/setupEnv';

import { describe, expect, test } from 'vitest';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 031 (provider_keys v2)', () => {
  test('adds is_builtin/protocol, relaxes NOT NULLs, partial-unique on builtins', async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A')`);
    // Keyless, system-seeded builtin: no api_key, no created_by — must insert.
    await testPool.query(
      `INSERT INTO provider_keys(id, org_id, provider, is_builtin, protocol, endpoint)
       VALUES ('b1','o1','openai', true, 'openai', 'https://api.openai.com/v1')`,
    );
    const cols = await testPool.query<{ name: string; null: boolean }>(
      `SELECT a.attname AS name, NOT a.attnotnull AS null FROM pg_attribute a
       WHERE a.attrelid = 'provider_keys'::regclass
         AND a.attname IN ('is_builtin','protocol','api_key_encrypted','created_by')`,
    );
    const byName = Object.fromEntries(cols.rows.map((c) => [c.name, c.null]));
    expect(byName.is_builtin).toBe(false); // NOT NULL
    expect(byName.protocol).toBe(false);   // NOT NULL
    expect(byName.api_key_encrypted).toBe(true);  // now nullable
    expect(byName.created_by).toBe(true);         // now nullable
    // A custom provider may repeat a builtin's slug (partial index excludes it).
    await testPool.query(`INSERT INTO provider_keys(id, org_id, provider, is_builtin)
       VALUES ('c1','o1','openai', false)`);
    // Second builtin of the same (org, provider) is rejected.
    await expect(
      testPool.query(
        `INSERT INTO provider_keys(id, org_id, provider, is_builtin) VALUES ('b2','o1','openai', true)`,
      ),
    ).rejects.toThrow();
  });
});
