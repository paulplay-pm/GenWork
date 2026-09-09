import { describe, expect, test } from 'vitest';
import '../helpers/setupEnv';
import { testPool, runMigrations, resetSchema } from '../../src/db/testDb';

describe('migration 036 — SSO tables', () => {
  test('applies cleanly and creates all three tables', async () => {
    await resetSchema();
    await runMigrations();
    const r = await testPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN
       ('sso_connections','user_idp_identities','sso_login_states')
       ORDER BY table_name`
    );
    // Note: the task-1 brief listed 'sso_login_states' first, but that order
    // is unachievable under the query's own `ORDER BY table_name` ('c' < 'l',
    // in any collation). Expected array corrected to the true sorted order;
    // assertion semantics (exactly these three tables) are unchanged.
    expect(r.rows.map((row) => row.table_name)).toEqual([
      'sso_connections',
      'sso_login_states',
      'user_idp_identities',
    ]);
  });
});

describe('migration 037 — sso:* grants', () => {
  test('migration 037 grants sso:* to org_admin', async () => {
    await resetSchema();
    await runMigrations();
    const r = await testPool.query<{ name: string; permissions: string[] }>(
      `SELECT name, permissions FROM roles WHERE name IN ('org_admin','super_admin') ORDER BY name`
    );
    for (const row of r.rows) {
      expect(row.permissions).toContain('sso:view');
      expect(row.permissions).toContain('sso:create');
      expect(row.permissions).toContain('sso:edit');
    }
  });
});
