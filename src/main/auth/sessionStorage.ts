import type Database from 'better-sqlite3';

export interface Session {
  userId: string;
  orgId: string;
  username: string;
  displayName: string;
  roles: string[];
  jwt: string;
  expiresAt: number;
}

const KEY = 'enterprise_session';

let db: Database.Database | null = null;

export const sessionStorage = {
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
  save(s: Session): void {
    if (!db) throw new Error('sessionStorage not configured');
    const now = Date.now();
    db.prepare(
      `INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run(KEY, JSON.stringify(s), now);
  },
  load(): Session | null {
    if (!db) return null;
    const row = db
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KEY) as { value: string } | undefined;
    if (!row) return null;
    let s: Session;
    try {
      s = JSON.parse(row.value) as Session;
    } catch {
      return null;
    }
    if (s.expiresAt > 0 && s.expiresAt < Date.now()) return null;
    return s;
  },
  clear(): void {
    if (!db) return;
    db.prepare('DELETE FROM kv WHERE key = ?').run(KEY);
  },
};