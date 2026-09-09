import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './pool';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Split a migration file's SQL into single statements the way production executes them. */
export function splitStatements(sql: string): string[] {
  const padded = sql.endsWith('\n') ? sql : sql + '\n';
  // Strip line comments before deciding whether a chunk is empty, so
  // single-statement migrations prefixed by `--` comments (like 008 and
  // 009) are still executed. The previous `s.startsWith('--')` check
  // would drop the whole chunk if the first non-blank line was a
  // comment, even when valid SQL followed.
  return padded
    .split(/;\s*(?:\n|$)/)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((s) => s.length > 0);
}

/**
 * Run all SQL migrations in order, idempotently.
 *
 * Each migration file may contain multiple statements. We split on `;` and
 * execute one statement per call so the pg driver returns a single result
 * per call (multi-statement simple queries can return `rows: undefined`,
 * which the pool adapter cannot safely interpret).
 *
 * Idempotency: the `000_ledger.sql` migration establishes a `_migrations`
 * ledger; subsequent runs skip files already recorded in it.
 */
export async function runMigrations(): Promise<void> {
  const dir = join(__dirname, 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  // Make sure the ledger table exists before we consult it. CREATE TABLE
  // IF NOT EXISTS is itself idempotent and cheap.
  for (const stmt of [
    `CREATE TABLE IF NOT EXISTS _migrations (file TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  ]) {
    await pool.query(stmt);
  }
  const ledger = await pool.query<{ file: string }>(`SELECT file FROM _migrations`);
  const applied = new Set(ledger.rows.map((r) => r.file));
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    if (sql.trim().startsWith('-- v2')) {
      // v2 placeholders are tracked but never applied
      await pool.query(`INSERT INTO _migrations(file) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
      continue;
    }
    // Execute each statement individually (see splitStatements).
    const statements = splitStatements(sql);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    await pool.query(`INSERT INTO _migrations(file) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
  }
}