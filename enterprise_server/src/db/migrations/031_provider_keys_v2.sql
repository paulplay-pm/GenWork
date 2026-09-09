-- provider_keys v2: built-in vs custom flag + explicit API protocol.
-- Plain SQL only (no DO blocks): the production runner executes one
-- `;`-delimited statement at a time (src/db/migrate.ts splitStatements).

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'openai'
    CHECK (protocol IN ('openai', 'anthropic'));

-- A keyless, system-seeded built-in has no key and no creating user; both
-- columns must be nullable for the seed to insert (see 032/Task 3).
ALTER TABLE provider_keys ALTER COLUMN api_key_encrypted DROP NOT NULL;
ALTER TABLE provider_keys ALTER COLUMN created_by DROP NOT NULL;

-- Built-ins are unique per (org, provider) so seeding is idempotent and an
-- admin can't add a second builtin of the same slug. Custom providers are
-- excluded from the constraint (they may repeat a slug, e.g. two vllm endpoints).
CREATE UNIQUE INDEX IF NOT EXISTS provider_keys_org_provider_builtin
  ON provider_keys (org_id, provider) WHERE is_builtin;
