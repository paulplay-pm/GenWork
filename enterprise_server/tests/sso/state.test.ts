// enterprise_server/tests/sso/state.test.ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { consumeState,createState } from '../../src/sso/state';

describe('sso/state', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url, require_prebinding)
       VALUES ('c1', 'o1', 'Acme', 'generic-oidc', 'oidc', 'https://idp/a', 'https://idp/t', false)`
    );
  });

  test('createState + consumeState round-trips and is one-shot', async () => {
    const { state, codeVerifier } = await createState({
      orgId: 'o1', connectionId: 'c1', returnTarget: 'console', codeVerifier: 'verifier',
    });
    expect(state.length).toBeGreaterThan(32);
    expect(codeVerifier).toBe('verifier');
    const consumed = await consumeState(state);
    expect(consumed?.orgId).toBe('o1');
    expect(consumed?.connectionId).toBe('c1');
    expect(consumed?.returnTarget).toBe('console');
    expect(consumed?.codeVerifier).toBe('verifier');
    // second consume is null (one-shot)
    expect(await consumeState(state)).toBeNull();
  });

  test('consumeState on unknown state returns null', async () => {
    expect(await consumeState('nope')).toBeNull();
  });
});
