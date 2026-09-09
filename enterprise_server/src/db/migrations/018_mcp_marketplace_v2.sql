-- Migration 018: MCP marketplace v2 (remote-server model + role permissions).
-- Adds URL/auth/credential/timeout/allowed_roles/health columns, relaxes
-- `command` (only needed for stdio), seeds the reserved 未分类 category, and
-- backfills allowed_roles so pre-existing servers stay reachable to admins.
--
-- Re-run safe (the test harness re-runs every file with no ledger check):
-- every ADD COLUMN uses IF NOT EXISTS; the seed and backfill are guarded.

ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS server_url        TEXT;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS auth_method       TEXT NOT NULL DEFAULT 'none';
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS credential_cipher TEXT;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS api_key_header    TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS timeout_seconds   INTEGER NOT NULL DEFAULT 30;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS allowed_roles     JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS last_status       TEXT;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS last_latency_ms   INTEGER;
ALTER TABLE mcp_marketplace_servers ADD COLUMN IF NOT EXISTS last_tested_at    TIMESTAMPTZ;

-- Relax `command`: make nullable (was NOT NULL).
ALTER TABLE mcp_marketplace_servers ALTER COLUMN command DROP NOT NULL;

-- Reserved 未分类 (Uncategorized) category: the target for delete-migration.
INSERT INTO mcp_marketplace_categories (category_id, name_zh, name_en, display_order)
VALUES ('uncategorized', '未分类', 'Uncategorized', 9999)
ON CONFLICT (category_id) DO NOTHING;

-- Backfill: pre-existing servers were un-gated; give them super_admin so
-- admins can still reach them. Only touch rows that have no roles yet.
UPDATE mcp_marketplace_servers
SET allowed_roles = '["super_admin"]'::jsonb
WHERE allowed_roles = '[]'::jsonb;

-- Guard the new CHECK on auth_method (idempotent drop-then-add; splitter-safe:
-- no dollar-quoted DO block, since the production runner splits on ';').
ALTER TABLE mcp_marketplace_servers DROP CONSTRAINT IF EXISTS mcp_servers_auth_method_check;
ALTER TABLE mcp_marketplace_servers ADD CONSTRAINT mcp_servers_auth_method_check CHECK (auth_method IN ('none','bearer','api-key','oauth'));
