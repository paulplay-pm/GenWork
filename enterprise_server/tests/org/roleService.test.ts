import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { RoleError, RoleGuardError, RoleInUseError, roleService } from '../../src/org/roleService';
import type { DataScope } from '../../src/shared/permissionPoints';

describe('roleService', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  });

  test('lists seeded core roles', async () => {
    const rows = await roleService.list();
    // Migration 029 seeds the six built-ins and demotes three legacy admin
    // roles to custom; together that is the full v2 catalog.
    expect(rows.map((r) => r.name).sort()).toEqual(
      ['agent_admin', 'auditor', 'dept_admin', 'dev', 'member', 'model_admin', 'org_admin', 'policy_admin', 'super_admin']
    );
    const org = rows.find((r) => r.name === 'org_admin');
    expect(org?.permissions).toContain('user:view');
  });

  test('create + get', async () => {
    const { id } = await roleService.create({
      name: 'viewer',
      description: 'read-only',
      permissions: ['audit:view'],
    });
    const got = await roleService.get(id);
    expect(got?.name).toBe('viewer');
    expect(got?.permissions).toEqual(['audit:view']);
  });

  test('create rejects duplicate name', async () => {
    await expect(roleService.create({ name: 'auditor', permissions: [] })).rejects.toThrow(/already/i);
  });

  test('update changes permissions and description', async () => {
    const { id } = await roleService.create({ name: 'x', permissions: [] });
    await roleService.update(id, { permissions: ['audit:view', 'role:view'], description: 'd' });
    const got = await roleService.get(id);
    expect(got?.permissions.sort()).toEqual(['audit:view', 'role:view']);
    expect(got?.description).toBe('d');
  });

  test('remove deletes', async () => {
    const { id } = await roleService.create({ name: 'tmp', permissions: [] });
    await roleService.remove(id);
    expect(await roleService.get(id)).toBeNull();
  });

  test('remove refuses a built-in role', async () => {
    const rows = await roleService.list({ type: 'builtin' });
    expect(rows.length).toBe(6);
    await expect(roleService.remove(rows[0]!.id)).rejects.toThrow(RoleGuardError);
    // still present
    expect(await roleService.get(rows[0]!.id)).not.toBeNull();
  });

  test('remove refuses a custom role that users still carry', async () => {
    const { id } = await roleService.create({ name: 'used', permissions: [] });
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, extra_roles)
       VALUES ('u1', 'o1', 'u1', 'x', '["used"]'::jsonb)`
    );
    await expect(roleService.remove(id)).rejects.toThrow(RoleInUseError);
    expect(await roleService.get(id)).not.toBeNull();
  });

  test('remove of an unknown id throws not_found', async () => {
    await expect(roleService.remove('nope')).rejects.toSatisfy((e) => {
      expect(e).toBeInstanceOf(RoleError);
      return (e as RoleError).code === 'not_found';
    });
  });

  test('create defaults v2 fields and persists provided ones', async () => {
    const { id } = await roleService.create({
      name: 'scoped',
      permissions: ['audit:view'],
      dataScope: 'dept',
      customDeptIds: ['d1', 'd2'],
    });
    const got = await roleService.get(id);
    expect(got?.displayName).toBe('scoped');
    expect(got?.dataScope).toBe('dept');
    expect(got?.customDeptIds).toEqual(['d1', 'd2']);
    expect(got?.isBuiltin).toBe(false);
  });

  test('create rejects a malformed code', async () => {
    await expect(roleService.create({ name: 'Bad Name', permissions: [] })).rejects.toThrow(
      RoleError
    );
  });

  test('update persists a dataScope change', async () => {
    const { id } = await roleService.create({ name: 'ds', permissions: [] });
    await roleService.update(id, { dataScope: 'dept_and_below' });
    const got = await roleService.get(id);
    expect(got?.dataScope).toBe('dept_and_below');
  });

  test('update rejects an invalid dataScope', async () => {
    const { id } = await roleService.create({ name: 'ds2', permissions: [] });
    await expect(
      roleService.update(id, { dataScope: 'bogus' as DataScope })
    ).rejects.toThrow(RoleError);
  });

  test('copy preserves points and scope, is always custom', async () => {
    const { id } = await roleService.create({
      name: 'orig',
      description: 'o',
      permissions: ['audit:view', 'role:view'],
      dataScope: 'dept',
      customDeptIds: ['d1'],
    });
    const { id: copyId } = await roleService.copy(id, 'orig_copy');
    const got = await roleService.get(copyId);
    expect(got?.name).toBe('orig_copy');
    expect(got?.displayName).toBe('orig (copy)');
    expect(got?.description).toBe('o');
    expect(got?.permissions).toEqual(['audit:view', 'role:view']);
    expect(got?.dataScope).toBe('dept');
    expect(got?.customDeptIds).toEqual(['d1']);
    expect(got?.isBuiltin).toBe(false);
  });

  test('copy of a built-in is a custom role', async () => {
    const rows = await roleService.list({ type: 'builtin' });
    const src = rows[0]!;
    const { id } = await roleService.copy(src.id, 'customized_admin');
    const got = await roleService.get(id);
    expect(got?.isBuiltin).toBe(false);
    expect(got?.permissions).toEqual(src.permissions);
  });

  test('copy rejects a duplicate code', async () => {
    const rows = await roleService.list({ type: 'builtin' });
    await expect(roleService.copy(rows[0]!.id, rows[0]!.name)).rejects.toThrow(RoleError);
  });
});
