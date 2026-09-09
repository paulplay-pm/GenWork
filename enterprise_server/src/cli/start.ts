import { pool } from '../db/pool.js';
import { serve } from '../server.js';
import { runMigrationsOnce } from './lib/runMigrations.js';

export async function run(): Promise<void> {
  await runMigrationsOnce();
  // If we are running in dry-run mode, exit before binding the port.
  if (process.env.GENWORK_MIGRATE_DRY_RUN === '1') {
    console.log('[start] dry-run complete; skipping serve()');
    await pool.end();
    return;
  }
  // If the operator left POSTGRES_SUPERUSER_URL in .env (it has no runtime
  // use; only `init` consumes it), log a debug line so the audit trail
  // records the oversight without failing the boot.
  if (process.env.POSTGRES_SUPERUSER_URL) {
    console.debug('[start] POSTGRES_SUPERUSER_URL is set but unused at runtime; consider removing it from .env');
  }
  serve();
  // pool stays open for the lifetime of the server.
}
