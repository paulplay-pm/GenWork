import type Database from 'better-sqlite3';

/**
 * Persistent storage for the user's enterprise server URL.
 *
 * The URL lives in the SQLite `kv` table (same place as `enterprise_session`),
 * keyed by `enterprise_server_url`. We persist the URL on every successful
 * verify (the modal's Save button), and read it on startup so the desktop
 * remembers the configured server across restarts.
 *
 * Persistence is independent of the JWT: the URL stays even after logout /
 * session expiry, so the user does not have to re-enter the URL every
 * launch. The JWT itself is wiped on every boot (see enterpriseMt.ts).
 */
const KEY = 'enterprise_server_url';

let db: Database.Database | null = null;

export const enterpriseServerUrlStore = {
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

  load(): string | null {
    if (!db) return null;
    const row = db
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KEY) as { value: string } | undefined;
    if (!row) return null;
    const trimmed = row.value.trim();
    return trimmed.length > 0 ? trimmed : null;
  },

  save(url: string): void {
    if (!db) throw new Error('enterpriseServerUrlStore not configured');
    const now = Date.now();
    db.prepare(
      `INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(KEY, url, now);
  },

  clear(): void {
    if (!db) return;
    db.prepare('DELETE FROM kv WHERE key = ?').run(KEY);
  },
};