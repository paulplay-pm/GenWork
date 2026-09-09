-- Extended provider_keys with display + connection-test fields.
-- All columns are additive and backward-compatible:
--   - description, api_key_masked, latency_ms, last_test_at are NULLABLE
--   - status defaults to 'unknown' for existing rows
--
-- Column is named `description` (not `desc`) because `desc` is a PostgreSQL
-- reserved word and `ADD COLUMN desc ...` raises a syntax error.
-- See ledger Ruling 1 in .superpowers/sdd/.../progress.md.

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS api_key_masked TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown', 'connected', 'failed')),
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS last_test_at TIMESTAMPTZ;
