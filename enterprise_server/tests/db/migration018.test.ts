import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 018', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('adds v2 columns and relaxes command', async () => {
    const r = await testPool.query<{ cols: string[] }>(
      `SELECT array_agg(column_name) AS cols
       FROM information_schema.columns
       WHERE table_name = 'mcp_marketplace_servers'
       AND column_name IN ('server_url','auth_method','credential_cipher','api_key_header','timeout_seconds','allowed_roles','last_status','last_latency_ms','last_tested_at')`,
    );
    expect(r.rows[0].cols.sort()).toEqual(
      ['allowed_roles','api_key_header','auth_method','credential_cipher','last_latency_ms','last_status','last_tested_at','server_url','timeout_seconds'].sort(),
    );
    // command is now nullable (no NOT NULL constraint).
    const notNull = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_name='mcp_marketplace_servers' AND column_name='command' AND is_nullable='NO'`,
    );
    expect(notNull.rows[0].n).toBe(0);
  });

  test('seeds reserved uncategorized category and backfills allowed_roles', async () => {
    const cat = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM mcp_marketplace_categories WHERE category_id='uncategorized'`,
    );
    expect(cat.rows[0].n).toBe(1);
    const backfilled = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM mcp_marketplace_servers
       WHERE server_id IN ('qichacha','exa-search','tavily-search')
       AND allowed_roles::text = '["super_admin"]'`,
    );
    expect(backfilled.rows[0].n).toBe(3);
  });

  test('is idempotent (re-run safe)', async () => {
    // resetSchema + runMigrations already ran; run again to prove no error.
    await resetSchema();
    await runMigrations();
    const cat = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM mcp_marketplace_categories WHERE category_id='uncategorized'`,
    );
    expect(cat.rows[0].n).toBe(1);
  });
});
