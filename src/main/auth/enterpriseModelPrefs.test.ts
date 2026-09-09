// src/main/auth/enterpriseModelPrefs.test.ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

import { enterpriseModelPrefs } from './enterpriseModelPrefs';

const createInMemoryDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  return db;
};

describe('enterpriseModelPrefs', () => {
  beforeEach(() => {
    // Re-configure for isolation between tests
  });

  test('read returns null when nothing has been written', () => {
    enterpriseModelPrefs.configure(createInMemoryDb());
    expect(enterpriseModelPrefs.readLastSelectedModelId()).toBeNull();
  });

  test('write then read round-trips the model id', () => {
    const db = createInMemoryDb();
    enterpriseModelPrefs.configure(db);
    enterpriseModelPrefs.writeLastSelectedModelId('m-123');
    expect(enterpriseModelPrefs.readLastSelectedModelId()).toBe('m-123');
  });

  test('write(null) deletes the persisted id', () => {
    const db = createInMemoryDb();
    enterpriseModelPrefs.configure(db);
    enterpriseModelPrefs.writeLastSelectedModelId('m-123');
    enterpriseModelPrefs.writeLastSelectedModelId(null);
    expect(enterpriseModelPrefs.readLastSelectedModelId()).toBeNull();
  });

  test('a second database instance returns null (proves kv is per-store)', () => {
    const db1 = createInMemoryDb();
    enterpriseModelPrefs.configure(db1);
    enterpriseModelPrefs.writeLastSelectedModelId('m-x');
    enterpriseModelPrefs.configure(createInMemoryDb());
    expect(enterpriseModelPrefs.readLastSelectedModelId()).toBeNull();
  });
});
