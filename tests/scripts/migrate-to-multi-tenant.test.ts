import { existsSync, mkdirSync,mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach,describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { migrateToMultiTenant } = require('../../scripts/migrate-to-multi-tenant.cjs');

const nodeSqlite = require('node:sqlite') as { DatabaseSync: new (p: string) => unknown };

describe('scripts/migrate-to-multi-tenant', () => {
  let userData: string;
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'genwork-mig-'));
  });

  test('旧 workspace-main 移到 default-org/<userId>/', async () => {
    const old = join(userData, 'openclaw', 'state', 'workspace-main');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'MEMORY.md'), 'old memory');
    await migrateToMultiTenant({ userData, enterpriseLogin: async () => 'u-abc' });
    const moved = join(userData, 'openclaw', 'state', 'default-org', 'u-abc', 'workspace-main', 'MEMORY.md');
    expect(existsSync(moved)).toBe(true);
  });

  test('旧 users 表被 DROP', async () => {
    const dbPath = join(userData, 'genwork.sqlite');
    const db = new nodeSqlite.DatabaseSync(dbPath);
    (db as unknown as { exec: (sql: string) => void }).exec(
      `CREATE TABLE users(id TEXT, username TEXT, password_hash TEXT)`
    );
    (db as unknown as { exec: (sql: string) => void }).exec(
      `INSERT INTO users VALUES ('u1','me','x')`
    );
    (db as unknown as { close: () => void }).close();

    await migrateToMultiTenant({ userData, enterpriseLogin: async () => 'u-new' });

    const db2 = new nodeSqlite.DatabaseSync(dbPath);
    const t = (
      db2 as unknown as {
        prepare: (sql: string) => { get: () => { name: string } | undefined };
      }
    )
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`)
      .get();
    expect(t).toBeUndefined();
  });

  test('旧 providers 表被 DROP', async () => {
    const dbPath = join(userData, 'genwork.sqlite');
    const db = new nodeSqlite.DatabaseSync(dbPath);
    (db as unknown as { exec: (sql: string) => void }).exec(
      `CREATE TABLE providers(id TEXT, name TEXT, api_key TEXT)`
    );
    (db as unknown as { exec: (sql: string) => void }).exec(
      `INSERT INTO providers VALUES ('p1','openai','sk-test')`
    );
    (db as unknown as { close: () => void }).close();

    await migrateToMultiTenant({ userData, enterpriseLogin: async () => 'u-x' });

    const db2 = new nodeSqlite.DatabaseSync(dbPath);
    const t = (
      db2 as unknown as {
        prepare: (sql: string) => { get: () => { name: string } | undefined };
      }
    )
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`)
      .get();
    expect(t).toBeUndefined();
  });

  test('旧路径不存在时是 no-op', async () => {
    await expect(
      migrateToMultiTenant({ userData, enterpriseLogin: async () => 'u-y' })
    ).resolves.not.toThrow();
  });
});