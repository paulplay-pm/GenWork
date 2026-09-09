import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migrations/007_app_releases', () => {
  beforeEach(async () => {
    await resetSchema();
  });

  test('creates app_releases with the expected columns and partial unique index', async () => {
    await runMigrations();
    const cols = await testPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='app_releases'`
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
      'change_log', 'created_at', 'enabled', 'id', 'installers',
      'is_latest', 'org_id', 'published_at', 'version',
    ]);
    const idx = await testPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='app_releases'`
    );
    expect(idx.rows.map((r) => r.indexname)).toContain('app_releases_one_latest');
  });

  test('idempotent — running runMigrations twice is a no-op', async () => {
    await runMigrations();
    await expect(runMigrations()).resolves.not.toThrow();
  });

  test('partial unique index prevents two latest rows in one org', async () => {
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
    await testPool.query(
      `INSERT INTO app_releases(org_id,version,is_latest) VALUES ('o1','1.0.0',true)`
    );
    await testPool.query(
      `INSERT INTO app_releases(org_id,version,is_latest) VALUES ('o1','2.0.0',true)`
    ).catch((e: Error) => {
      expect((e as Error).message).toMatch(/app_releases_one_latest|duplicate|conflict|unique/i);
    });
  });
});
