import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { scopeApi } from '../../src/auth/scopeResolver';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

const claims = (roles: string[]) => ({ sub: 'u1', orgId: 'o1', roles });

describe('scopeApi (DB-backed loaders)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1', 'o1', 'u1', 'x')`);
    await scopeApi.invalidate();
  });

  test('deptIdsFor returns the user department ids (primary + concurrent)', async () => {
    await testPool.query(
      `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES
       ('d1', 'o1', 'Root', NULL, '/Root'),
       ('d2', 'o1', 'Child', 'd1', '/Root/Child')`,
    );
    await testPool.query(
      `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES
       ('u1', 'd1', true), ('u1', 'd2', false)`,
    );
    const ids = await scopeApi.deptIdsFor('o1', 'u1');
    expect([...ids].sort()).toEqual(['d1', 'd2']);
  });

  test('deptIdsFor is org-scoped: a user of another org yields nothing', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'T2')`);
    await testPool.query(
      `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES ('d1', 'o1', 'Root', NULL, '/Root')`,
    );
    await testPool.query(`INSERT INTO user_departments(user_id, dept_id) VALUES ('u1', 'd1')`);
    expect(await scopeApi.deptIdsFor('o2', 'u1')).toEqual([]);
  });

  test('super_admin claims resolve to scope kind all', async () => {
    const scope = await scopeApi.loadScope(claims(['super_admin']));
    expect(scope).toEqual({ kind: 'all' });
  });

  test('a roleless user resolves to scope kind self (fail-closed)', async () => {
    const scope = await scopeApi.loadScope(claims([]));
    expect(scope).toEqual({ kind: 'self' });
  });

  test('an unknown role name resolves to self (fail-closed)', async () => {
    const scope = await scopeApi.loadScope(claims(['ghost_role']));
    expect(scope).toEqual({ kind: 'self' });
  });

  test('an org_wide built-in role resolves to scope kind all', async () => {
    // 'auditor' is seeded by migration 029 with data_scope org_wide.
    const scope = await scopeApi.loadScope(claims(['auditor']));
    expect(scope).toEqual({ kind: 'all' });
  });

  test('a dept_and_below role resolves to the caller dept + its descendants', async () => {
    await testPool.query(
      `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES
       ('d1', 'o1', 'Root', NULL, '/Root'),
       ('d2', 'o1', 'Child', 'd1', '/Root/Child'),
       ('d3', 'o1', 'Sister', NULL, '/Sister')`,
    );
    await testPool.query(`INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES ('u1', 'd1', true)`);
    await testPool.query(
      `INSERT INTO roles(id, name, data_scope, permissions) VALUES ('r1', 'scoped', 'dept_and_below', '[]'::jsonb)`,
    );
    const scope = await scopeApi.loadScope(claims(['scoped']));
    expect(scope.kind).toBe('dept');
    if (scope.kind === 'dept') expect([...scope.deptIds].sort()).toEqual(['d1', 'd2']);
  });

  test('invalidate() picks up a role data_scope change live', async () => {
    await testPool.query(
      `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES ('d1', 'o1', 'Root', NULL, '/Root')`,
    );
    await testPool.query(`INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES ('u1', 'd1', true)`);
    await testPool.query(
      `INSERT INTO roles(id, name, data_scope, permissions) VALUES ('r1', 'scoped', 'self', '[]'::jsonb)`,
    );
    expect(await scopeApi.loadScope(claims(['scoped']))).toEqual({ kind: 'self' });

    await testPool.query(`UPDATE roles SET data_scope = 'dept_and_below' WHERE id = 'r1'`);
    // Without invalidation the stale 30s cache would still say self.
    await scopeApi.invalidate();
    const scope = await scopeApi.loadScope(claims(['scoped']));
    expect(scope).toEqual({ kind: 'dept', deptIds: ['d1'] });
  });

  test('invalidate() landing mid-loadScope does not throw (maps captured before await)', async () => {
    await testPool.query(
      `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES ('d1', 'o1', 'Root', NULL, '/Root')`,
    );
    await testPool.query(`INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES ('u1', 'd1', true)`);
    await testPool.query(
      `INSERT INTO roles(id, name, data_scope, permissions) VALUES ('r1', 'scoped', 'dept_and_below', '[]'::jsonb)`,
    );
    // Warm the cache first.
    expect(await scopeApi.loadScope(claims(['scoped']))).toEqual({ kind: 'dept', deptIds: ['d1'] });
    // Deterministic race: a role mutation fires invalidate() while this
    // loadScope call is awaiting deptIdsFor. The maps must have been captured
    // into locals before that await, or effectiveScope receives null and
    // throws TypeError (500 on /me and scope-filtered list routes).
    const orig = scopeApi.deptIdsFor;
    const spy = vi
      .spyOn(scopeApi, 'deptIdsFor')
      .mockImplementation(async (orgId: string, userId: string) => {
        const ids = await orig.call(scopeApi, orgId, userId);
        await scopeApi.invalidate();
        return ids;
      });
    try {
      const scope = await scopeApi.loadScope(claims(['scoped']));
      expect(scope).toEqual({ kind: 'dept', deptIds: ['d1'] });
    } finally {
      spy.mockRestore();
    }
  });
});
