-- v1
-- Skill marketplace catalog (mirrors 012/018 MCP marketplace).
-- One file: catalog tables + seed + permission-code backfill + old-table drop.

CREATE TABLE IF NOT EXISTS skill_marketplace_categories (
  category_id   TEXT PRIMARY KEY,
  name_zh       TEXT NOT NULL,
  name_en       TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skill_marketplace_skills (
  skill_id         TEXT PRIMARY KEY,
  name_en          TEXT NOT NULL,
  name_zh          TEXT,
  description_en   TEXT NOT NULL,
  description_zh   TEXT,
  icon             TEXT,
  version          TEXT,
  category_id      TEXT NOT NULL
                   REFERENCES skill_marketplace_categories(category_id),
  source_json      JSONB,
  allowed_roles    JSONB NOT NULL DEFAULT '["org_admin"]'::jsonb,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS skill_marketplace_skills_category_idx
  ON skill_marketplace_skills (category_id, enabled);

-- Reserved bucket. Always present so skills always have a valid category to
-- assign; deleting any other category re-homes its skills here.
-- ON CONFLICT without a column target (not (category_id)): 038 re-keys this
-- table to UNIQUE (org_id, category_id), so a column target would no longer
-- match once the full chain is re-run against a post-038 schema. The target
-- is a no-op on first apply (the table is empty either way) and DO NOTHING
-- matches the same conflict on both shapes.
INSERT INTO skill_marketplace_categories (category_id, name_zh, name_en, display_order)
VALUES ('uncategorized', '未分类', 'Uncategorized', 0)
ON CONFLICT DO NOTHING;

-- Rename the permission code for already-deployed DBs (019 is edited directly
-- for fresh DBs). Guarded by `?` so it is a no-op once migrated. The codes are
-- matched/emitted as JSON *string* literals ("...")::jsonb -- a bare dotted
-- token like policies.manage is not valid JSON and would fail the jsonb cast.
UPDATE roles
   SET permissions = (
       SELECT jsonb_agg(
                CASE WHEN el = '"policies.manage"'::jsonb THEN '"skills.manage"'::jsonb ELSE el END
              )
       FROM jsonb_array_elements(permissions) el
     )
 WHERE permissions ? 'policies.manage';

-- Delete the old free-text skill-policies feature (decision: delete, not merge).
DROP TABLE IF EXISTS skill_policies;
