import type { PGlite, Transaction } from '@electric-sql/pglite';
import { PGlite as PGliteImpl } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Test-only pool backed by pglite (in-process Postgres via WASM).
 *
 * Production code uses the real `pg` Pool in `src/db/pool.ts` against DATABASE_URL.
 * Tests use this pglite-backed shim. Both expose the same `query<T>(sql, params)`
 * shape so call sites do not need to know which is in use.
 *
 * Ruling R1: chosen because the host machine has no psql/Postgres installed.
 *
 * `transaction` lets service code run BEGIN/COMMIT/ROLLBACK blocks without
 * depending on pg.Pool.connect() (which pglite doesn't expose). Service code
 * that needs transactions should use `pool.transaction(async tx => {...})`
 * rather than `pool.connect()`, so the same code works in both environments.
 */
export interface TxClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  _isPg?: boolean;
}

export interface TestPool {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

let _instance: PGlite | null = null;

function getInstance(): PGlite {
  if (_instance) return _instance;
  _instance = new PGliteImpl();
  return _instance;
}

function wrapTx(tx: Transaction): TxClient {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await tx.query<T>(sql, params);
      const rows = r.rows as T[];
      const rowCount = sql.trim().toUpperCase().startsWith('SELECT')
        ? rows.length
        : (r.affectedRows ?? rows.length);
      return { rows, rowCount };
    },
  };
}

function adaptPool(db: PGlite): TestPool {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await db.query<T>(sql, params);
      const rows = result.rows as T[];
      // pglite returns affectedRows for INSERT/UPDATE/DELETE (e.g. 1) but
      // undefined or 0 for SELECT. We use rows.length as the authoritative
      // source for SELECT and fall back to affectedRows for write queries.
      const rowCount = sql.trim().toUpperCase().startsWith('SELECT')
        ? rows.length
        : (result.affectedRows ?? rows.length);
      return { rows, rowCount };
    },
    async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
      return db.transaction(async tx => fn(wrapTx(tx)));
    },
    async end() {
      if (_instance) {
        await _instance.close();
        _instance = null;
      }
    },
  };
}

export const testPool: TestPool = adaptPool(getInstance());

export async function resetSchema(): Promise<void> {
  const db = getInstance();
  await db.exec('DROP SCHEMA public CASCADE');
  await db.exec('CREATE SCHEMA public');
}

export async function runMigrations(): Promise<void> {
  const dir = join(__dirname, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const db = getInstance();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    if (sql.trim().startsWith('-- v2')) continue; // skip placeholder
    await db.exec(sql);
  }
}