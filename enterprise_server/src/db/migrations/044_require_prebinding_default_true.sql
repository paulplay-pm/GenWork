-- enterprise_server/src/db/migrations/044_require_prebinding_default_true.sql
-- Flip sso_connections.require_prebinding default to true.
--
-- Policy: a new SSO connection is created in strict mode by default
-- (require_prebinding=true). Operators who want the legacy "JIT
-- provisions on first login" behavior must explicitly opt out by
-- setting require_prebinding=false on the new connection.
--
-- This migration changes ONLY the column default. It does NOT backfill
-- existing rows: every sso_connections row that was created with
-- require_prebinding=false stays false. Existing orgs see no change to
-- their login flow until they create a new connection (or manually
-- flip the existing one in the admin drawer).
--
-- The "change the default without backfilling" shape is intentional:
-- the previous default of false was set in migration 043 with the same
-- policy ("flipping it on is a deliberate admin decision — see spec
-- §4.2"). Flipping the default to true reverses the opt-in direction:
-- future connections are strict by default; existing ones keep their
-- stored value. Operators that want a uniform rollout can issue
-- `UPDATE sso_connections SET require_prebinding = true` themselves.
--
-- This migration is safe to roll forward and back. A rollback would
-- `ALTER TABLE sso_connections ALTER COLUMN require_prebinding SET
-- DEFAULT false`, which is non-destructive.

ALTER TABLE sso_connections
  ALTER COLUMN require_prebinding SET DEFAULT true;
