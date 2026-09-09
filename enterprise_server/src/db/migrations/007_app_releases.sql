-- Migration 007: desktop app release registry.
-- The admin console stores per-org releases (version + changelog + per-platform
-- download URLs). `is_latest` is a marked pointer (not "max enabled version")
-- so admins can roll back by re-pointing the latest tag. The partial unique
-- index makes that race-safe even under concurrent admin clicks.
--
-- Every DDL here is `IF NOT EXISTS` for forward-compat idempotency.

-- gen_random_uuid() is built into PostgreSQL 13+ and into pglite; no extension
-- needed. Other migrations in this repo use TEXT primary keys and so do not
-- rely on UUID generation; this is the first table that does.

CREATE TABLE IF NOT EXISTS app_releases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  version       TEXT NOT NULL,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_log    JSONB NOT NULL DEFAULT '{}'::jsonb,
  downloads     JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  is_latest     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_releases_one_latest
  ON app_releases (org_id) WHERE is_latest;
