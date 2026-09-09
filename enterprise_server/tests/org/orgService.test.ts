import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { verifyPassword } from '../../src/auth/password';
import { resetSchema, runMigrations,testPool } from '../../src/db/testDb';
import { orgService } from '../../src/org/orgService';

describe('org/orgService', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Test')`);
  });

  test('createDept 写入 path', async () => {
    const root = await orgService.createDept({
      orgId: 'o1',
      name: 'root',
      parentId: null,
    });
    const child = await orgService.createDept({
      orgId: 'o1',
      name: 'eng',
      parentId: root.id,
    });
    expect(child.path).toBe('/root/eng');
  });

  test('createUser 时 timezone 无效回退 org', async () => {
    const u = await orgService.createUser({
      orgId: 'o1',
      username: 'a',
      password: 'pw12345',
      timezone: 'Bad/Zone',
    });
    const r = await testPool.query<{ timezone: string | null }>(
      `SELECT timezone FROM users WHERE id=$1`,
      [u.id]
    );
    expect(r.rows[0].timezone).toBeNull();
  });

  test('listUsers returns users for org', async () => {
    await orgService.createUser({ orgId: 'o1', username: 'a', password: 'pw12345678' });
    const list = await orgService.listUsers('o1');
    expect(list).toHaveLength(1);
    expect(list[0].username).toBe('a');
  });

  test('patchUser 改 status + department', async () => {
    const dept = await orgService.createDept({
      orgId: 'o1',
      name: 'root',
      parentId: null,
    });
    const u = await orgService.createUser({
      orgId: 'o1',
      username: 'a',
      password: 'pw12345678',
    });
    await orgService.patchUser(u.id, { status: 'disabled', departmentId: dept.id });
    const after = await orgService.getUser(u.id);
    expect(after?.status).toBe('disabled');
    expect(after?.department_id).toBe(dept.id);
  });

  test('setUserStatus 可禁用也可启用(对称)', async () => {
    const u = await orgService.createUser({
      orgId: 'o1',
      username: 'a',
      password: 'pw12345678',
    });
    await orgService.setUserStatus(u.id, 'disabled');
    expect((await orgService.getUser(u.id))?.status).toBe('disabled');
    // re-enable round-trips back to active
    await orgService.setUserStatus(u.id, 'active');
    expect((await orgService.getUser(u.id))?.status).toBe('active');
  });

  test('resetPassword 重写 hash,旧密码失效、新密码可用', async () => {
    const u = await orgService.createUser({
      orgId: 'o1',
      username: 'a',
      password: 'original-pw-1',
    });
    const found = await orgService.resetPassword(u.id, 'new-password-1');
    expect(found).toBe(true);
    const row = await testPool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id=$1`,
      [u.id]
    );
    expect(await verifyPassword('new-password-1', row.rows[0].password_hash)).toBe(true);
    expect(await verifyPassword('original-pw-1', row.rows[0].password_hash)).toBe(false);
  });

  test('resetPassword 对未知用户返回 false(不写入)', async () => {
    const found = await orgService.resetPassword('does-not-exist', 'brand-new-pw');
    expect(found).toBe(false);
  });
});