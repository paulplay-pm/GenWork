-- Migration 040: org-scoped expert-suite (kit) catalog. Mirrors the 023/038
-- skill_marketplace subsystem: a natural-TEXT-key catalog (keyed by slug),
-- org-scoped TEXT-slug categories with a reserved "uncategorized" bucket,
-- scope JSONB ACL, and zip metadata. category_id has NO FK (route-enforced,
-- matching 038's skill category precedent).
--
-- Re-run safe: CREATE TABLE IF NOT EXISTS; reserved bucket seeded via a
-- single-quoted plpgsql trigger (no dollar-quoting) so splitStatements keeps
-- the whole CREATE FUNCTION as one statement.

CREATE TABLE IF NOT EXISTS kit_categories (
  category_id   TEXT NOT NULL,
  name_zh       TEXT NOT NULL,
  name_en       TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_reserved   BOOLEAN NOT NULL DEFAULT false,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, category_id)
);

CREATE TABLE IF NOT EXISTS kit_catalog (
  slug           TEXT NOT NULL,
  org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  category_id    TEXT,
  name_en        TEXT,
  name_zh        TEXT,
  description_en TEXT,
  description_zh TEXT,
  icon_url       TEXT,
  author         TEXT,
  version        TEXT,
  try_asking     JSONB NOT NULL DEFAULT '[]'::jsonb,
  skill_list     JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope          JSONB NOT NULL DEFAULT '{"allCompany":false,"deptIds":[],"userIds":[]}'::jsonb,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  is_builtin     BOOLEAN NOT NULL DEFAULT false,
  zip_file_name  TEXT,
  zip_file_size  BIGINT,
  zip_sha256     TEXT,
  created_by     TEXT,
  updated_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, slug)
);

CREATE INDEX IF NOT EXISTS kit_catalog_org_id ON kit_catalog (org_id);

-- Per-org reserved bucket (mirror of the 038 skill bucket): seeded at
-- org-creation time; the admin delete path also guarantees it as a fallback.
CREATE OR REPLACE FUNCTION kit_ensure_uncategorized()
  RETURNS trigger
  LANGUAGE plpgsql
  AS 'BEGIN INSERT INTO kit_categories (category_id, name_zh, name_en, display_order, is_reserved, org_id) VALUES (''uncategorized'', ''未分类'', ''Uncategorized'', 0, true, NEW.id) ON CONFLICT (org_id, category_id) DO NOTHING; RETURN NULL; END;';
DROP TRIGGER IF EXISTS trg_kit_org_uncategorized ON orgs;
CREATE TRIGGER trg_kit_org_uncategorized
  AFTER INSERT ON orgs
  FOR EACH ROW
  EXECUTE FUNCTION kit_ensure_uncategorized();

-- Idempotently grant the new kit points to org_admin / super_admin (mirror 037).
UPDATE roles
SET permissions = permissions || '["kit:view","kit:create","kit:edit","kit:toggle","kit:delete"]'::jsonb
WHERE name IN ('org_admin','super_admin')
  AND NOT (permissions @> '["kit:view"]'::jsonb);
