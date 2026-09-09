import '../helpers/setupEnv';
import { describe, expect, test, beforeEach, vi } from 'vitest';

// 在 import authService 之前替换它引用的 pool 为 testPool。
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, testPool, runMigrations } from '../../src/db/testDb';
import { authService } from '../../src/auth/authService';

describe('auth/authService', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Test')`);
  });

  test('login 成功返回 JWT', async () => {
    await authService.createUser({ orgId: 'o1', username: 'alice', password: 'pw12345' });
    const { token, claims } = await authService.login('Test', 'alice', 'pw12345');
    expect(typeof claims.sub).toBe('string');
    expect(claims.roles).toContain('user');
    expect(token.length).toBeGreaterThan(20);
  });

  test('login 密码错误抛 LoginFailed', async () => {
    await authService.createUser({ orgId: 'o1', username: 'alice', password: 'pw12345' });
    await expect(authService.login('Test', 'alice', 'wrong')).rejects.toThrow(/invalid/i);
  });

  test('login 禁用账号抛 LoginFailed', async () => {
    const u = await authService.createUser({ orgId: 'o1', username: 'bob', password: 'pw12345' });
    await authService.disable(u.id);
    await expect(authService.login('Test', 'bob', 'pw12345')).rejects.toThrow(/disabled/i);
  });

  test('login 未知组织抛 LoginFailed', async () => {
    await authService.createUser({ orgId: 'o1', username: 'alice', password: 'pw12345' });
    await expect(authService.login('Nonexistent', 'alice', 'pw12345')).rejects.toThrow(/invalid/i);
  });
});