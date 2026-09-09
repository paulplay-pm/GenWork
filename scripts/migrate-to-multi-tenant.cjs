'use strict';

/**
 * Multi-tenant workspace migration.
 *
 * Pre-multi-tenant path: %APPDATA%/GenWork/openclaw/state/workspace-main
 * Post-multi-tenant path: %APPDATA%/GenWork/openclaw/state/<orgId>/<userId>/workspace-main
 *
 * Provider config that lived in the local SQLite providers table is NOT
 * migrated. Per spec §7.1, providers move to enterprise_server's
 * provider_keys table; the desktop drops its own key storage.
 *
 * On startup the caller invokes `migrateToMultiTenant({ userData, enterpriseLogin })`
 * where `enterpriseLogin` returns the freshly-issued enterprise userId
 * after the user redeems an invitation code. This script is intentionally
 * idempotent — running it twice is a no-op the second time.
 */

const fs = require('node:fs');
const path = require('node:path');

async function migrateToMultiTenant({ userData, enterpriseLogin }) {
  const userId = await enterpriseLogin();
  if (!userId) throw new Error('enterpriseLogin returned no userId');

  const orgId = process.env.GENWORK_DEFAULT_ORG_ID ?? 'default-org';

  const oldWs = path.join(userData, 'openclaw', 'state', 'workspace-main');
  const newWs = path.join(
    userData,
    'openclaw',
    'state',
    orgId,
    userId,
    'workspace-main'
  );

  if (fs.existsSync(oldWs) && !fs.existsSync(newWs)) {
    fs.mkdirSync(path.dirname(newWs), { recursive: true });
    fs.renameSync(oldWs, newWs);
    console.log(`[migrate] moved ${oldWs} → ${newWs}`);
  } else {
    console.log(`[migrate] no move required (old=${fs.existsSync(oldWs)} new=${fs.existsSync(newWs)})`);
  }

  // Drop the local SQLite `users` table (old auth model).
  // The new auth flow uses enterprise_session stored in `kv` (see sessionStorage.ts).
  const dbPath = path.join(userData, 'genwork.sqlite');
  if (fs.existsSync(dbPath)) {
    try {
      // Prefer Node's built-in node:sqlite (Node 22+, no native binding).
      const nodeSqlite = require('node:sqlite');
      const db = new nodeSqlite.DatabaseSync(dbPath);
      const hasUsers = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='users'`
        )
        .get();
      if (hasUsers) {
        db.exec(`DROP TABLE users`);
        console.log('[migrate] dropped legacy users table');
      }
      const hasProviders = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`
        )
        .get();
      if (hasProviders) {
        db.exec(`DROP TABLE providers`);
        console.log('[migrate] dropped legacy providers table');
      }
      db.close();
    } catch (e) {
      console.warn('[migrate] SQLite cleanup skipped:', e.message);
    }
  }
}

module.exports = { migrateToMultiTenant };