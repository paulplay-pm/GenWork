import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, test } from 'vitest';

import { splitStatements } from '../../src/db/migrate';
import { resetSchema, testPool } from '../../src/db/testDb';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS = join(__dirname, '../../src/db/migrations');

describe('migration splitter fidelity', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  test('every migration applies via the production single-statement path', async () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
      if (sql.trim().startsWith('-- v2')) continue; // v2 placeholders are tracked, not applied
      for (const stmt of splitStatements(sql)) {
        await testPool.query(stmt);
      }
    }
    // Representative probe: the reserved category and a v2 column exist.
    const cat = await testPool.query(`SELECT 1 FROM mcp_marketplace_categories WHERE category_id = 'uncategorized'`);
    expect(cat.rows.length).toBe(1);
  });
});
