-- v1 idempotency ledger. Records each migration file applied; runMigrations
-- skips files that are already in the ledger, so rerunning on a populated
-- DB does not blow up on CREATE TABLE.
CREATE TABLE IF NOT EXISTS _migrations (
  file TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO _migrations(file) VALUES ('000_ledger.sql')
ON CONFLICT (file) DO NOTHING;