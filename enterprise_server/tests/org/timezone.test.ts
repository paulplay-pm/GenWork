import '../helpers/setupEnv';
import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, testPool, runMigrations } from '../../src/db/testDb';
import { timezone } from '../../src/org/timezone';

describe('org/timezone', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(
      `INSERT INTO orgs(id, name, timezone) VALUES ('o1', 'Test', 'Asia/Shanghai')`
    );
  });

  test('用户时区优先', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash, timezone)
       VALUES ('u1', 'o1', 'a', 'x', 'Europe/London')`
    );
    // UTC 16:00 = London 17:00（夏令时 BST=UTC+1）→ London 日期 8/25
    const w = await timezone.quotaWindowDate('u1', new Date('2026-08-25T16:00:00Z'));
    expect(w).toBe('2026-08-25');
  });

  test('缺省回退 org 时区', async () => {
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u2', 'o1', 'b', 'x')`
    );
    // UTC 16:00 = Shanghai 00:00 (次日) → Shanghai 日期 8/26
    const w = await timezone.quotaWindowDate('u2', new Date('2026-08-25T16:00:00Z'));
    expect(w).toBe('2026-08-26');
  });

  test('无效时区抛错', () => {
    expect(() => timezone.resolveZone('Not/AZone')).toThrow();
  });

  test('UTC 用户：UTC 00:00 边界点为当天', async () => {
    await testPool.query(
      `INSERT INTO orgs(id, name, timezone) VALUES ('o2', 'O2', 'UTC')`
    );
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u3', 'o2', 'c', 'x')`
    );
    const w = await timezone.quotaWindowDate('u3', new Date('2026-08-25T00:00:00Z'));
    expect(w).toBe('2026-08-25');
  });
});