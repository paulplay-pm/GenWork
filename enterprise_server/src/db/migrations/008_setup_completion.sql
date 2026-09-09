-- Migration 008: per-org setup completion flag.
-- The /api/setup/* surface is hard-closed (HTTP 410) once any org has
-- `setup_completed_at` set. The flag is written inside the same transaction
-- as the first super-admin INSERT in invitationService.redeem(), so a
-- successful redeem atomically marks the org as fully bootstrapped.
--
-- A row with `setup_completed_at IS NULL` is in the setup phase; a non-NULL
-- value means setup is done and the org is operational. `npm run reinit`
-- can clear the flag back to NULL; the SPA then re-opens the wizard.
--
-- Idempotent for pglite test replay (ADD COLUMN IF NOT EXISTS).

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS setup_completed_at TIMESTAMPTZ;
