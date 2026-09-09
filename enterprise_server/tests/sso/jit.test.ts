// enterprise_server/tests/sso/jit.test.ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { DomainNotAllowedError, EmailRequiredError, resolveUser, UserDisabledError,UsernameConflictError } from '../../src/sso/jit';

async function seedOrgAndConn(whitelist: string[]): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  await testPool.query(
    `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, require_prebinding, email_domain_whitelist)
     VALUES ('c1','o1','Acme','generic-oidc','oidc', false, $1::jsonb)`,
    [JSON.stringify(whitelist)]
  );
}

describe('sso/jit', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('rejects when email domain not in whitelist', async () => {
    await seedOrgAndConn(['example.com']);
    await expect(resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext1',
      email: 'user@evil.com', loginName: 'alice',
    })).rejects.toBeInstanceOf(DomainNotAllowedError);
  });

  test('rejects when email missing and whitelist non-empty', async () => {
    await seedOrgAndConn(['example.com']);
    await expect(resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext1',
      email: null, loginName: 'alice',
    })).rejects.toBeInstanceOf(EmailRequiredError);
  });

  test('JIT creates a user when nothing exists', async () => {
    await seedOrgAndConn([]);
    const r = await resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext1',
      email: 'alice@example.com', loginName: 'alice',
    });
    expect(r.createdJit).toBe(true);
    expect(typeof r.userId).toBe('string');
    const u = await testPool.query(`SELECT username, email FROM users WHERE id = $1`, [r.userId]);
    expect(u.rows[0]).toEqual({ username: 'alice', email: 'alice@example.com' });
    const b = await testPool.query(`SELECT 1 FROM user_idp_identities WHERE user_id = $1 AND sso_connection_id='c1' AND external_id='ext1'`, [r.userId]);
    expect(b.rowCount).toBe(1);
  });

  test('returns existing user when (connection, external_id) already bound', async () => {
    await seedOrgAndConn([]);
    const first = await resolveUser({ orgId: 'o1', connectionId: 'c1', externalId: 'ext1', email: 'a@x.com', loginName: 'a' });
    const second = await resolveUser({ orgId: 'o1', connectionId: 'c1', externalId: 'ext1', email: 'a@x.com', loginName: 'a' });
    expect(second.userId).toBe(first.userId);
    expect(second.createdJit).toBe(false);
  });

  test('cross-IdP dedup binds a new IdP identity to the same user via email', async () => {
    await seedOrgAndConn([]);
    const first = await resolveUser({ orgId: 'o1', connectionId: 'c1', externalId: 'ext1', email: 'a@x.com', loginName: 'a' });
    // Create a second SSO connection in the same org.
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, require_prebinding, email_domain_whitelist)
       VALUES ('c2','o1','Other','generic-oauth2','oauth2', false, '[]'::jsonb)`
    );
    const second = await resolveUser({ orgId: 'o1', connectionId: 'c2', externalId: 'ext_other', email: 'a@x.com', loginName: 'a' });
    expect(second.userId).toBe(first.userId);
    expect(second.createdJit).toBe(false);
  });

  test('username conflict with existing password user is rejected', async () => {
    await seedOrgAndConn([]);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u_existing','o1','alice','x')`
    );
    await expect(resolveUser({ orgId: 'o1', connectionId: 'c1', externalId: 'ext1', email: 'a@x.com', loginName: 'alice' }))
      .rejects.toBeInstanceOf(UsernameConflictError);
  });

  test('rejects a disabled user whose identity is already bound (2a)', async () => {
    await seedOrgAndConn([]);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, status)
       VALUES ('u_disabled','o1','bob','x','disabled')`
    );
    await testPool.query(
      `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
       VALUES ('b1','o1','u_disabled','c1','ext1')`
    );
    await expect(resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext1',
      email: 'bob@example.com', loginName: 'bob',
    })).rejects.toThrow(UserDisabledError);
  });

  test('rejects a disabled user found via email dedup (2b) without binding a new identity', async () => {
    await seedOrgAndConn([]);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, email, status)
       VALUES ('u_disabled2','o1','bob','x','bob@example.com','disabled')`
    );
    await expect(resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext1',
      email: 'bob@example.com', loginName: 'bob',
    })).rejects.toThrow(UserDisabledError);
    // A disabled user must not receive a fresh binding row.
    const b = await testPool.query(
      `SELECT 1 FROM user_idp_identities WHERE user_id='u_disabled2' AND sso_connection_id='c1' AND external_id='ext1'`
    );
    expect(b.rowCount).toBe(0);
  });

  test('empty loginName falls back to the email local-part for the username', async () => {
    await seedOrgAndConn([]);
    const r = await resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext1',
      email: 'bob@example.com', loginName: '',
    });
    expect(r.createdJit).toBe(true);
    const u = await testPool.query<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [r.userId]);
    expect(u.rows[0]).toEqual({ username: 'bob' });
  });

  // An IdP that does not return email (e.g. Feishu without the `email`
  // scope granted) must still succeed when no whitelist is configured.
  // Cross-IdP dedup is unavailable in that case — two no-email logins
  // from different IdPs become two distinct users — but the more common
  // repeat-login case still works because (connection, external_id) is
  // the primary key.
  test('JIT creates a user when email is null and no whitelist is set', async () => {
    await seedOrgAndConn([]);
    const r = await resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext-noemail',
      email: null, loginName: null,
    });
    expect(r.createdJit).toBe(true);
    expect(typeof r.userId).toBe('string');
    const u = await testPool.query<{ username: string; email: string | null }>(
      `SELECT username, email FROM users WHERE id = $1`, [r.userId]
    );
    // No email → no email-local-part → fallback to the deterministic
    // `sso-${external_id[:8]}` shape, so two distinct external_ids never
    // collide on username.
    expect(u.rows[0]).toEqual({ username: 'sso-ext-noem', email: null });
    const b = await testPool.query(
      `SELECT 1 FROM user_idp_identities WHERE user_id = $1 AND sso_connection_id='c1' AND external_id='ext-noemail'`,
      [r.userId]
    );
    expect(b.rowCount).toBe(1);
  });

  test('a no-email user re-login on the same connection resolves to the same user', async () => {
    await seedOrgAndConn([]);
    const first = await resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext-noemail', email: null, loginName: null,
    });
    const second = await resolveUser({
      orgId: 'o1', connectionId: 'c1', externalId: 'ext-noemail', email: null, loginName: null,
    });
    expect(second.userId).toBe(first.userId);
    expect(second.createdJit).toBe(false);
  });
});
