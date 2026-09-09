// Relative paths were wrong (`../db/...` from `cli/lib/` resolves to
// `cli/db/...`, which doesn't exist). The actual location is one level
// up from `lib/`, so the correct specifier is `../../db/...`. The
// `@ts-expect-error` suppressions were hiding the wrong path; they are
// no longer needed once the specifier resolves to a real file.
import { runMigrations } from '../../db/migrate.js';
import { pool } from '../../db/pool.js';

const dryRun = process.env.GENWORK_MIGRATE_DRY_RUN === '1';

export async function runMigrationsOnce(): Promise<void> {
  if (dryRun) {
    // Touch the pool so a bad DATABASE_URL surfaces now, but do not write.
    await pool.query('SELECT 1');
    console.log('[migrate] dry-run: connection ok, would run migrations without applying');
    return;
  }
  await runMigrations();
}
