// enterprise_server/tests/sso/migration043.test.ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 043 — sso prebinding', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, require_prebinding, email_domain_whitelist)
       VALUES ('c1','o1','Acme','generic-oidc','oidc', false, '[]'::jsonb)`
    );
  });

  test('users.sso_connection_id and sso_external_id exist and are nullable', async () => {
    const cols = await testPool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'users' AND column_name IN ('sso_connection_id', 'sso_external_id')`
    );
    expect(cols.rows.map(r => r.column_name).sort()).toEqual(['sso_connection_id', 'sso_external_id']);
    for (const c of cols.rows) expect(c.is_nullable).toBe('YES');
  });

  test('sso_connections.require_prebinding exists and accepts an explicit false value', async () => {
    // Migration 044 flipped the column default to true; this test pins
    // migration 043's contract: an explicit false is accepted and stored.
    // The "default is true" assertion lives in tests/sso/migration044.test.ts.
    const r = await testPool.query<{ require_prebinding: boolean }>(
      `SELECT require_prebinding FROM sso_connections WHERE id = 'c1'`
    );
    expect(r.rows[0]?.require_prebinding).toBe(false);
  });

  test('sso_login_states.phase exists and defaults to sso_completed', async () => {
    await testPool.query(
      `INSERT INTO sso_login_states(state, org_id, sso_connection_id, return_target, expires_at)
       VALUES ('st1','o1','c1','console', now() + interval '1 minute')`
    );
    const r = await testPool.query<{ phase: string }>(
      `SELECT phase FROM sso_login_states WHERE state = 'st1'`
    );
    expect(r.rows[0]?.phase).toBe('sso_completed');
  });

  test('users binding unique index rejects duplicates but allows cross-org same id', async () => {
    // Two users in same org trying to bind the same (connection, external_id) → reject.
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id)
       VALUES ('u1','o1','a','x','c1','ext-1')`
    );
    await expect(testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id)
       VALUES ('u2','o1','b','x','c1','ext-1')`
    )).rejects.toThrow(/unique/i);

    // Cross-org same (connection, external_id) → allowed (index is per-connection,
    // not per-org). Insert a second org + connection + user.
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2','Other')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, email_domain_whitelist)
       VALUES ('c2','o2','Acme2','generic-oidc','oidc','[]'::jsonb)`
    );
    await expect(testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, sso_connection_id, sso_external_id)
       VALUES ('u3','o2','c','x','c2','ext-1')`
    )).resolves.toBeDefined();
  });
});