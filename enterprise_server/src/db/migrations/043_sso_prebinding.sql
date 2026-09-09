-- enterprise_server/src/db/migrations/043_sso_prebinding.sql
-- SSO user self-binding: stores (sso_connection_id, sso_external_id) on
-- the users row. Written by the user via the "Bind SSO" profile flow or
-- by the post-SSO "prove with password" page. Read by JIT (strict mode)
-- and by admin (read-only view).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sso_connection_id TEXT REFERENCES sso_connections(id),
  ADD COLUMN IF NOT EXISTS sso_external_id   TEXT;

-- A given (sso_connection_id, sso_external_id) pair maps to at most one user.
-- The partial WHERE clause leaves the (NULL, NULL) rows of unbound users out
-- of the index (no point indexing them; they're the common case pre-rollout).
CREATE UNIQUE INDEX IF NOT EXISTS users_sso_binding_uniq
  ON users (sso_connection_id, sso_external_id)
  WHERE sso_external_id IS NOT NULL;

-- Fast lookup from the JIT path: a single index covers both the strict-mode
-- binding query and the `WHERE sso_connection_id IS NULL` "unbound" report.
CREATE INDEX IF NOT EXISTS users_sso_binding_lookup
  ON users (sso_connection_id, sso_external_id)
  WHERE sso_external_id IS NOT NULL;

-- Per-connection opt-in. Default false preserves v1 behavior; flipping it
-- on is a deliberate admin decision (unbound IdP identities must go
-- through the "prove with password" path — see spec §4.2).
ALTER TABLE sso_connections
  ADD COLUMN IF NOT EXISTS require_prebinding BOOLEAN NOT NULL DEFAULT false;

-- SSO login state machine: after the IdP callback, if the identity is
-- unbound, we keep the state row and set phase='pending_bind' so the
-- /bind-sso page can verify the password and resume.
ALTER TABLE sso_login_states
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'sso_completed';
-- phase values: 'sso_completed' (default, callback can finalize) |
-- 'pending_bind' (callback completed identity check, awaiting password
-- verification at /bind-sso)
CREATE INDEX IF NOT EXISTS sso_login_states_phase
  ON sso_login_states (state) WHERE phase = 'pending_bind';