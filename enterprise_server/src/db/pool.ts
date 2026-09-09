import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { TxClient } from './testDb';

/**
 * Production Postgres pool. Used at runtime against DATABASE_URL.
 * Tests use `testPool` from `./testDb.ts` (pglite-backed) instead.
 *
 * Service code that needs a transaction should call `pool.transaction(async tx => {...})`
 * so the same code works against both this real pool and the test pool — both
 * expose the same `TxClient` query surface inside the callback.
 */
export interface ProductionPool {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

function wrapClient(client: PoolClient): TxClient {
  return {
    _isPg: true,
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await client.query<T extends QueryResultRow ? T : QueryResultRow>(
        sql,
        params as unknown[]
      );
      const rows = (r.rows ?? []) as T[];
      return { rows, rowCount: r.rowCount ?? rows.length };
    },
  };
}

const _pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
});

export const pool: ProductionPool = {
  async query<T>(sql: string, params: unknown[] = []) {
    const r = await _pgPool.query<T extends QueryResultRow ? T : QueryResultRow>(
      sql,
      params as unknown[]
    );
    const rows = (r.rows ?? []) as T[];
    return { rows, rowCount: r.rowCount ?? rows.length };
  },
  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    const client = await _pgPool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(wrapClient(client));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
  end() {
    return _pgPool.end();
  },
};