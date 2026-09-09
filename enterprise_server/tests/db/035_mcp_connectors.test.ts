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

describe('migration 035 (mcp connector subsystem)', () => {
  test('creates the 4 connector tables and the orgs toggle column', async () => {
    await resetSchema();
    await runMigrations();
    const tables = await testPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN (
         'mcp_connectors', 'mcp_connector_versions',
         'mcp_connector_submissions', 'mcp_connector_categories'
       ) ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'mcp_connector_categories',
      'mcp_connector_submissions',
      'mcp_connector_versions',
      'mcp_connectors',
    ]);
    const col = await testPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'orgs'
       AND column_name = 'members_can_submit_connectors'`,
    );
    expect(col.rows).toHaveLength(1);
  });

  test('migrates URL-bearing legacy marketplace servers into the existing org', async () => {
    await resetSchema();
    await runMigrations();
    // orgs is empty at this point, so the 035 INSERT was a no-op during the
    // chain — the upgraded-deployment shape (org + legacy data already present
    // when 035 applies) is simulated below by inserting data then re-applying
    // the 035 file (same idiom as tests/db/migration033.test.ts).
    await testPool.query(
      `INSERT INTO orgs(id, name) VALUES ('org-abc12345', 'Acme')`,
    );
    await testPool.query(
      `INSERT INTO mcp_marketplace_servers
       (server_id, name, name_zh, description_en, description_zh, category_id,
        transport_type, command, server_url, auth_method, enabled)
       VALUES
         ('legacy-http', 'Legacy Http', '旧版 HTTP', 'en desc', 'zh desc', 'search',
          'http', 'cmd', 'https://mcp.example.com/mcp', 'bearer', true),
         ('legacy-sse', 'Legacy Sse', NULL, 'en only', NULL, 'data-api',
          'sse', 'cmd', 'https://mcp.example.com/sse', 'oauth', false),
         ('legacy-stdio', 'Legacy Stdio', NULL, 'no url', NULL, 'uncategorized',
          'stdio', 'npx foo', NULL, 'none', true)`,
    );
    await applyMigrationFile('035_mcp_connectors.sql');

    const res = await testPool.query<{
      id: string;
      org_id: string;
      server_key: string;
      url: string;
      transport: string;
      auth_mode: string;
      enabled: boolean;
      category_id: string | null;
      description: string | null;
      scope: { allCompany: boolean; deptIds: string[]; userIds: string[] };
    }>(
      `SELECT id, org_id, server_key, url, transport, auth_mode, enabled,
              category_id, description, scope
       FROM mcp_connectors ORDER BY id`,
    );
    const rows = res.rows;
    // The stdio / no-URL row stays in the old table, unserved.
    expect(rows).toHaveLength(2);
    const http = rows.find((r) => r.id === 'legacy-http');
    const sse = rows.find((r) => r.id === 'legacy-sse');
    expect(http).toBeDefined();
    expect(sse).toBeDefined();
    // Legacy rows land in the org that exists at apply time (not a
    // hardcoded/dangling id), scoped to the whole company.
    expect(http!.org_id).toBe('org-abc12345');
    expect(http!.scope).toEqual({ allCompany: true, deptIds: [], userIds: [] });
    expect(http!.auth_mode).toBe('shared-key');
    expect(http!.url).toBe('https://mcp.example.com/mcp');
    expect(http!.enabled).toBe(true);
    expect(sse!.auth_mode).toBe('user-oauth');
    expect(sse!.enabled).toBe(false);
    expect(sse!.description).toBe('en only');
    // 'uncategorized' is not a real category.
    const uncategorized = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM mcp_connectors WHERE category_id = 'uncategorized'`,
    );
    expect(uncategorized.rows[0].n).toBe(0);

    // Idempotency: a second apply is a no-op (no error, no duplicates).
    await applyMigrationFile('035_mcp_connectors.sql');
    const count = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM mcp_connectors`,
    );
    expect(count.rows[0].n).toBe(2);
  });
});
