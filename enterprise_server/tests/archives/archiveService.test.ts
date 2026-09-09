import '../helpers/setupEnv';
import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, testPool, runMigrations } from '../../src/db/testDb';
import { archiveService } from '../../src/archives/archiveService';

describe('archives/archiveService', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1', 'o1', 'a', 'x')`
    );
  });

  test('store 写入 BYTEA + 返回 archiveId', async () => {
    const blob = Buffer.from('zip-bytes');
    const { archiveId, size } = await archiveService.store('o1', 'u1', blob);
    expect(size).toBe(blob.length);
    const r = await testPool.query<{ archive_blob: Uint8Array }>(
      `SELECT archive_blob FROM user_archives WHERE id=$1`,
      [archiveId]
    );
    expect(Buffer.from(r.rows[0].archive_blob)).toEqual(blob);
  });

  test('list 按 user 过滤', async () => {
    await archiveService.store('o1', 'u1', Buffer.from('one'));
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u2', 'o1', 'b', 'x')`
    );
    await archiveService.store('o1', 'u2', Buffer.from('two'));
    const list = await archiveService.list('o1', 'u1');
    expect(list).toHaveLength(1);
    expect(list[0].user_id).toBe('u1');
  });

  test('getBlob 拿到原 blob', async () => {
    const blob = Buffer.from('payload');
    const { archiveId } = await archiveService.store('o1', 'u1', blob);
    const got = await archiveService.getBlob(archiveId);
    expect(got).toEqual(blob);
  });
});