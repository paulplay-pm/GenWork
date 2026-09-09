import type Database from 'better-sqlite3';
import { enterpriseClient } from '../auth/enterpriseClient';

export interface OutboxEvent {
  action: string;
  targetType?: string;
  targetId?: string;
  payload?: unknown;
}

let db: Database.Database | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const FLUSH_BATCH = 50;
const FLUSH_INTERVAL_MS = 30_000;

export const auditOutbox = {
  configure(database: Database.Database): void {
    db = database;
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        payload TEXT,
        delivered INTEGER NOT NULL DEFAULT 0
      )
    `);
  },

  push(e: OutboxEvent): void {
    if (!db) throw new Error('auditOutbox not configured');
    db.prepare(
      `INSERT INTO audit_outbox(ts, action, target_type, target_id, payload)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      Date.now(),
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.payload !== undefined ? JSON.stringify(e.payload) : null
    );
  },

  async flush(): Promise<void> {
    if (!db) return;
    const rows = db
      .prepare(
        `SELECT id, action, target_type, target_id, payload
         FROM audit_outbox WHERE delivered=0
         ORDER BY id LIMIT ?`
      )
      .all(FLUSH_BATCH) as {
      id: number;
      action: string;
      target_type: string | null;
      target_id: string | null;
      payload: string | null;
    }[];
    if (rows.length === 0) return;
    const events = rows.map((r) => ({
      action: r.action,
      targetType: r.target_type ?? undefined,
      targetId: r.target_id ?? undefined,
      payload: r.payload ? (JSON.parse(r.payload) as unknown) : undefined,
    }));
    try {
      await enterpriseClient.postAudit(events);
      for (const r of rows) {
        db.prepare(`UPDATE audit_outbox SET delivered=1 WHERE id=?`).run(r.id);
      }
    } catch {
      /* network failure: leave rows undelivered, retry next interval */
    }
  },

  start(): void {
    if (timer) return;
    timer = setInterval(() => {
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};