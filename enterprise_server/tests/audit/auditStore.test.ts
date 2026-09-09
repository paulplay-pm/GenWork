import '../helpers/setupEnv';
import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, testPool, runMigrations } from '../../src/db/testDb';
import { auditStore } from '../../src/audit/auditStore';

describe('audit/auditStore', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  });

  test('write + query', async () => {
    await auditStore.write({ orgId: 'o1', userId: 'u1', action: 'login' });
    const r = await auditStore.query({ orgId: 'o1', limit: 10 });
    expect(r).toHaveLength(1);
    expect(r[0].action).toBe('login');
  });

  test('payload JSON 序列化', async () => {
    await auditStore.write({
      orgId: 'o1',
      userId: 'u1',
      action: 'mcp_call',
      payload: { args: ['a', 'b'] },
    });
    const r = await auditStore.query({ orgId: 'o1' });
    expect(r[0].payload).toEqual({ args: ['a', 'b'] });
  });
});