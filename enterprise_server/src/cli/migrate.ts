import { pool } from '../db/pool';
import { runMigrationsOnce } from './lib/runMigrations';

export async function run(): Promise<void> {
  if (process.env.GENWORK_MIGRATE_DRY_RUN === '1') {
    console.log('[migrate] GENWORK_MIGRATE_DRY_RUN=1 — running in dry-run mode');
  }
  await runMigrationsOnce();
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
