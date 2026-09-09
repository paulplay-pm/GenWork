import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations,testPool } from '../../src/db/testDb';
import { invitationService } from '../../src/setup/invitationService';

describe('setup/invitationService', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Test')`);
  });

  test('create 生成 code 且 6h 过期', async () => {
    const inv = await invitationService.create('o1');
    expect(inv.code).toMatch(/^GENWORK-SETUP-[A-Z0-9_-]{8}-[A-Z0-9_-]{8}-[A-Z0-9_-]{8}$/);
    expect(inv.expiresAt.getTime() - Date.now()).toBeGreaterThan(5 * 60 * 60 * 1000);
  });

  test('redeem 成功后 code 状态变 used', async () => {
    const inv = await invitationService.create('o1');
    const userId = await invitationService.redeem(inv.code, {
      orgId: 'o1',
      username: 'root',
      password: 'pw12345',
    });
    expect(typeof userId).toBe('string');
    const r = await testPool.query<{ status: string; used_by: string }>(
      `SELECT status, used_by FROM init_invitations WHERE id=$1`,
      [inv.id]
    );
    expect(r.rows[0].status).toBe('used');
    expect(r.rows[0].used_by).toBe(userId);
  });

  test('redeem 过期 code 抛 InvalidInvitation', async () => {
    const inv = await invitationService.create('o1');
    await testPool.query(
      `UPDATE init_invitations SET expires_at=now() - interval '1 hour' WHERE id=$1`,
      [inv.id]
    );
    await expect(
      invitationService.redeem(inv.code, { orgId: 'o1', username: 'r', password: 'pw12345' })
    ).rejects.toThrow(/expired/i);
  });

  test('redeem 已用 code 抛 InvalidInvitation', async () => {
    const inv = await invitationService.create('o1');
    await invitationService.redeem(inv.code, { orgId: 'o1', username: 'r1', password: 'pw12345' });
    await expect(
      invitationService.redeem(inv.code, { orgId: 'o1', username: 'r2', password: 'pw12345' })
    ).rejects.toThrow(/used/i);
  });
});