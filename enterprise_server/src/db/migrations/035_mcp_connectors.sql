-- Migration 035: MCP connector subsystem (replaces role-based marketplace).
-- Org-scoped connectors with 6-mode auth, dept+member scope, draft, tools,
-- versions, and a member submission (review) queue. Best-effort migration of
-- existing mcp_marketplace_servers rows that carry a server_url.
--
-- Legacy org_id: the old mcp_marketplace_servers table has no org_id, and this
-- repo seeds no fixed org (the first org is created at setup time with a
-- random `org-<8hex>` id). The migration therefore targets the org that
-- exists at apply time (oldest first; V1 is single-tenant, one org per
-- deployment). If no org exists yet (fresh install, pre-setup) the
-- CROSS JOIN yields zero rows and the migration is a clean no-op.
--
-- mcp_connector_submissions."desc" is quoted on purpose: DESC is a reserved
-- word in the column-definition context, so the bare name is a syntax error
-- (verified against pglite's PostgreSQL 16.4 and required on any engine).
-- Re-run safe: IF NOT EXISTS + guarded INSERT/UPDATE.

CREATE TABLE IF NOT EXISTS mcp_connectors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  server_key TEXT NOT NULL,
  name_en TEXT,
  name_zh TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  category_id TEXT,
  description TEXT,
  connector_type TEXT NOT NULL DEFAULT 'mcp',
  url TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'http',
  auth_mode TEXT NOT NULL DEFAULT 'none',
  auth_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_meta JSONB,
  auth_status TEXT NOT NULL DEFAULT 'configured',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  scope JSONB NOT NULL DEFAULT '{"allCompany":false,"deptIds":[],"userIds":[]}'::jsonb,
  tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  draft JSONB,
  last_test_at TIMESTAMPTZ,
  last_test_status TEXT,
  last_latency_ms INTEGER,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, server_key)
);

CREATE INDEX IF NOT EXISTS mcp_connectors_org_idx ON mcp_connectors (org_id);
CREATE INDEX IF NOT EXISTS mcp_connectors_org_cat_idx ON mcp_connectors (org_id, category_id);

CREATE TABLE IF NOT EXISTS mcp_connector_versions (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES mcp_connectors(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  date TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  current BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_connector_versions_conn_idx ON mcp_connector_versions (connector_id);

CREATE TABLE IF NOT EXISTS mcp_connector_submissions (
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
  approved_connector_id TEXT
);
CREATE INDEX IF NOT EXISTS mcp_connector_submissions_org_idx ON mcp_connector_submissions (org_id, status);

CREATE TABLE IF NOT EXISTS mcp_connector_categories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS members_can_submit_connectors BOOLEAN NOT NULL DEFAULT TRUE;

-- Best-effort migration: existing marketplace servers WITH a URL become
-- connectors scoped to the whole company. stdio/legacy (no URL) rows are left
-- in the old table, unserved (not dropped). Non-destructive.
INSERT INTO mcp_connectors
  (id, org_id, server_key, name_en, name_zh, version, category_id, description,
   connector_type, url, transport, auth_mode, auth_config, secret_meta, auth_status,
   enabled, scope, tools, draft, created_by, created_at, updated_at)
SELECT
  s.server_id, o.id,
  COALESCE(NULLIF(s.name, ''), s.server_id), s.name, s.name_zh, '1.0.0',
  NULLIF(s.category_id, 'uncategorized'), COALESCE(s.description_zh, s.description_en),
  'mcp', s.server_url, s.transport_type,
  CASE WHEN s.auth_method IN ('bearer','api-key') THEN 'shared-key'
       WHEN s.auth_method = 'oauth' THEN 'user-oauth' ELSE 'none' END,
  '{}'::jsonb, NULL, 'configured', s.enabled,
  '{"allCompany":true,"deptIds":[],"userIds":[]}'::jsonb, '[]'::jsonb, NULL,
  'system', now(), now()
FROM mcp_marketplace_servers s
CROSS JOIN (
  SELECT id FROM orgs ORDER BY created_at, id LIMIT 1
) o
WHERE s.server_url IS NOT NULL AND s.transport_type <> 'stdio'
ON CONFLICT (org_id, server_key) DO NOTHING;
