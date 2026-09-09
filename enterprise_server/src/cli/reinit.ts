import { pool } from '../db/pool';

/**
 * Re-open the /api/setup/* surface for an existing org by clearing
 * `orgs.setup_completed_at`. The next /setup visit will mint a fresh
 * invite code and create a new super-admin (the old admin still exists;
 * reinit does not delete users).
 *
 * Defaults to `default-org` for backwards compatibility with the old
 * `init`-driven flow, but most orgs created by the new SPA bootstrap
 * will have an `org-<8 hex>` id — pass it via ORG_ID env or
 * look it up by name in psql.
 */
async function main(): Promise<void> {
  const orgId = process.env.ORG_ID ?? 'default-org';
  const exists = await pool.query<{ id: string }>(
    `SELECT id FROM orgs WHERE id = $1`,
    [orgId]
  );
  if (exists.rowCount === 0) {
    console.error(`Org ${orgId} not found.`);
    process.exit(1);
  }
  const r = await pool.query(
    `UPDATE orgs SET setup_completed_at = NULL WHERE id = $1`,
    [orgId]
  );
  if (r.rowCount === 0) {
    // Org exists but was already not completed; that's fine, idempotent.
    console.log(`Org ${orgId} is already open for setup.`);
  } else {
    console.log(`Re-opened setup for ${orgId}.`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
