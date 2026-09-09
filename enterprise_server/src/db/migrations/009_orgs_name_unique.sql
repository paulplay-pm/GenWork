-- Migration 009: org name is the user-visible identity.
-- Operators sign in with the org NAME (e.g. "Acme Corp"), not a random
-- org_id. To make name-based login unambiguous, every org must have a
-- unique name.
--
-- A blank name is rejected at /api/setup/start (1-64 chars check). A new
-- org row with a duplicate name fails the index at INSERT time, so the
-- SPA can surface a friendly "name already taken" error.
--
-- Idempotent for pglite test replay (CREATE UNIQUE INDEX IF NOT EXISTS).

CREATE UNIQUE INDEX IF NOT EXISTS orgs_name_unique
  ON orgs (name);
