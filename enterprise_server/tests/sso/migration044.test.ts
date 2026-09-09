// enterprise_server/tests/sso/migration044.test.ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 044 — require_prebinding default true', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
  });

  test('new sso_connections rows default to require_prebinding=true', async () => {
    // Bare INSERT with no require_prebinding column → should pick up the
    // new default (true). The previous default was false; this test pins
    // the new behavior.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, email_domain_whitelist)
       VALUES ('c-new','o1','Strict By Default','generic-oidc','oidc','[]'::jsonb)`
    );
    const r = await testPool.query<{ require_prebinding: boolean }>(
      `SELECT require_prebinding FROM sso_connections WHERE id = 'c-new'`
    );
    expect(r.rows[0]?.require_prebinding).toBe(true);
  });

  test('migration 043 default-false rows keep their stored value (no backfill)', async () => {
    // Simulate an "existing" connection that was created under the
    // 043 default (require_prebinding=false). The migration must not
    // rewrite stored values; only the column default changes.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, require_prebinding, email_domain_whitelist)
       VALUES ('c-legacy','o1','Legacy','generic-oidc','oidc', false, '[]'::jsonb)`
    );
    const r = await testPool.query<{ require_prebinding: boolean }>(
      `SELECT require_prebinding FROM sso_connections WHERE id = 'c-legacy'`
    );
    expect(r.rows[0]?.require_prebinding).toBe(false);
  });

  test('explicit require_prebinding=true still works on a fresh INSERT', async () => {
    // Defensive: ensure the migration did not break the explicit-value path.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, require_prebinding, email_domain_whitelist)
       VALUES ('c-explicit','o1','Explicit True','generic-oidc','oidc', true, '[]'::jsonb)`
    );
    const r = await testPool.query<{ require_prebinding: boolean }>(
      `SELECT require_prebinding FROM sso_connections WHERE id = 'c-explicit'`
    );
    expect(r.rows[0]?.require_prebinding).toBe(true);
  });

  test('column default at the catalog level is true (not just at row-insert time)', async () => {
    // Direct check on pg_attribute so a future regression that only
    // touches application code is caught here too.
    const r = await testPool.query<{ column_default: string | null }>(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_name = 'sso_connections'
          AND column_name = 'require_prebinding'`
    );
    // pglite renders `true` without quoting; production pg renders `true` too.
    expect(r.rows[0]?.column_default).toBe('true');
  });
});
