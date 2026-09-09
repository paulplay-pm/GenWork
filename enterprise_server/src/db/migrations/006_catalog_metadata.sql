-- Migration 006: add capability metadata so the admin console can store
-- per-model runtime hints (image/video/thinking/context window) and per-provider
-- region/website/default URL hints. The desktop `GET /admin/catalog` endpoint
-- surfaces these so the desktop no longer needs its own hardcoded catalog.
--
-- Every ADD COLUMN is `IF NOT EXISTS` so the migration is idempotent. An earlier
-- run could have applied a prefix of these columns and then crashed before the
-- ledger row was written; without idempotency the next boot would re-run the file
-- and die on "column already exists" (SQLSTATE 42701), never binding a port.

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS region TEXT,
  ADD COLUMN IF NOT EXISTS default_base_url TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT;

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS supports_image BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supports_video BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supports_thinking BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS context_window INTEGER,
  ADD COLUMN IF NOT EXISTS max_tokens INTEGER;
