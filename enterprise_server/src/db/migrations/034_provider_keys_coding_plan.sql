-- provider_keys v3: per-provider "Coding Plan" flag. When on, the admin UI
-- swaps the Base URL to the provider's coding-specific endpoint (a beta
-- coding-plan API). Plain SQL only (no DO blocks): the production runner
-- executes one `;`-delimited statement at a time (src/db/migrate.ts).
ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS coding_plan BOOLEAN NOT NULL DEFAULT false;
