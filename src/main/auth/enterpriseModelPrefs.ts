// src/main/auth/enterpriseModelPrefs.ts
import type Database from 'better-sqlite3';

const KEY = 'enterpriseMt.lastSelectedModelId';

let db: Database.Database | null = null;

export const enterpriseModelPrefs = {
  configure(database: Database.Database): void {
    db = database;
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  },

  readLastSelectedModelId(): string | null {
    if (!db) return null;
    const row = db
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KEY) as { value: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  },

  writeLastSelectedModelId(id: string | null): void {
    if (!db) return;
    if (id === null) {
      db.prepare('DELETE FROM kv WHERE key = ?').run(KEY);
    } else {
      const now = Date.now();
      db.prepare(
        `INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      ).run(KEY, JSON.stringify(id), now);
    }
  },
};
