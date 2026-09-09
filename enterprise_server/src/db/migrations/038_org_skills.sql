-- Migration 038: org-scoped skill marketplace (replaces role-based visibility).
-- In-place upgrade of the 023 tables (D2): add org_id + scope + zip metadata +
-- usage + actor columns to skill_marketplace_skills, drop allowed_roles;
-- make categories org-scoped; add the member-submission (review) queue; add
-- the org "members can submit skills" switch; best-effort backfill existing
-- rows.
--
-- The 023 skill->category FK (skill_marketplace_skills_category_id_fkey) is
-- dropped BEFORE the categories PK re-key (PostgreSQL refuses to drop a PK
-- that a FK depends on) and is deliberately NOT re-added: category
-- org-scoping is enforced in the route layer, matching 035's
-- mcp_connectors.category_id precedent.
--
-- Re-run safe (the test harness re-runs every file with no ledger check):
-- every ADD/DROP COLUMN uses IF NOT EXISTS / IF EXISTS; the unique re-key is
-- DROP + ADD (PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS); the reserved-
-- bucket seed is INSERT ... SELECT with ON CONFLICT (org_id, category_id)
-- DO NOTHING.
--
-- skill_submissions."desc" is quoted on purpose: DESC is a reserved word in
-- the column-definition context (same as 035's mcp_connector_submissions).

-- 1) Skills: org + scope + zip metadata + usage + actor; drop allowed_roles.
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT '';
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS scope JSONB NOT NULL
  DEFAULT '{"allCompany":false,"deptIds":[],"userIds":[]}'::jsonb;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS zip_file_name TEXT;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS zip_file_size INTEGER;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS zip_sha256 TEXT;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS use_count_30d INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS updated_by TEXT;
CREATE INDEX IF NOT EXISTS skill_marketplace_skills_org_idx ON skill_marketplace_skills (org_id);
CREATE INDEX IF NOT EXISTS skill_marketplace_skills_org_cat_idx ON skill_marketplace_skills (org_id, category_id);
ALTER TABLE skill_marketplace_skills DROP COLUMN IF EXISTS allowed_roles;

-- Drop the 023 FK before re-keying the categories PK. NOT re-added on purpose
-- (see header).
ALTER TABLE skill_marketplace_skills DROP CONSTRAINT IF EXISTS skill_marketplace_skills_category_id_fkey;

-- 2) Categories: org-scoped; PK(category_id) -> UNIQUE(org_id, category_id).
ALTER TABLE skill_marketplace_categories ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT '';
ALTER TABLE skill_marketplace_categories DROP CONSTRAINT IF EXISTS skill_marketplace_categories_pkey;
ALTER TABLE skill_marketplace_categories DROP CONSTRAINT IF EXISTS skill_marketplace_categories_org_key;
ALTER TABLE skill_marketplace_categories ADD CONSTRAINT skill_marketplace_categories_org_key UNIQUE (org_id, category_id);

-- 3) Member-submission (review) queue (mirrors mcp_connector_submissions).
CREATE TABLE IF NOT EXISTS skill_submissions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  "desc" TEXT,
  author_id TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  cfg JSONB NOT NULL,
  approved_skill_id TEXT
);
CREATE INDEX IF NOT EXISTS skill_submissions_org_idx ON skill_submissions (org_id, status);

-- 4) Org switch (default OFF — submissions gated until an admin enables it).
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS members_can_submit_skills BOOLEAN NOT NULL DEFAULT FALSE;

-- 5) Best-effort backfill: existing skills/categories -> oldest org,
-- non-destructive.
UPDATE skill_marketplace_skills
   SET org_id = (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1)
 WHERE org_id = '' AND (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1) IS NOT NULL;
UPDATE skill_marketplace_categories
   SET org_id = (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1)
 WHERE org_id = ''
   AND (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1) IS NOT NULL
   AND NOT EXISTS (
     -- Guard against a full-chain re-run in an org-present context, where 023
     -- would have re-seeded a global row: re-homing it onto an existing
     -- (org, category) would violate the new unique constraint.
     SELECT 1 FROM skill_marketplace_categories k
      WHERE k.org_id = (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1)
        AND k.category_id = skill_marketplace_categories.category_id
   );

-- Per-org reserved bucket: seed one for every org that already carries a
-- scoped category. Fresh installs have no org yet at apply time; the trigger
-- below covers those.
INSERT INTO skill_marketplace_categories (category_id, name_zh, name_en, display_order, org_id)
SELECT 'uncategorized', '未分类', 'Uncategorized', 0, o.id
FROM (SELECT DISTINCT org_id AS id FROM skill_marketplace_categories WHERE org_id <> '') o
ON CONFLICT (org_id, category_id) DO NOTHING;

-- A global (org_id = '') reserved row only survives when no org exists at
-- apply time (fresh install, pre-setup); it would be dangling, so remove it.
-- The trigger below re-creates a per-org bucket at org-creation time. No-op
-- on live deployments (the backfill above re-homed every '' row).
DELETE FROM skill_marketplace_categories WHERE org_id = '';

-- 6) Auto-seed the reserved bucket for orgs created after this migration.
-- Single-quoted plpgsql body (no dollar-quoting) so splitStatements keeps the
-- whole CREATE FUNCTION as one statement on the production path.
CREATE OR REPLACE FUNCTION skill_marketplace_ensure_bucket()
  RETURNS trigger
  LANGUAGE plpgsql
  AS 'BEGIN INSERT INTO skill_marketplace_categories (category_id, name_zh, name_en, display_order, org_id) VALUES (''uncategorized'', ''未分类'', ''Uncategorized'', 0, NEW.id) ON CONFLICT (org_id, category_id) DO NOTHING; RETURN NULL; END;';
DROP TRIGGER IF EXISTS skill_marketplace_org_bucket ON orgs;
CREATE TRIGGER skill_marketplace_org_bucket
  AFTER INSERT ON orgs
  FOR EACH ROW
  EXECUTE FUNCTION skill_marketplace_ensure_bucket();
