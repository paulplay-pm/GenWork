-- Migration 012: MCP marketplace.
-- The desktop pulls this catalog at startup via GET /api/mcp-marketplace
-- and renders the entries in McpManager. Server rows that are enabled = false
-- are filtered out. The DB columns map to wire fields 1:1 with two renames:
--   category_id -> "category" (wire field is just the slug)
--   kind defaults to 'single' and is omitted on the wire when not 'bundle'.

CREATE TABLE IF NOT EXISTS mcp_marketplace_categories (
  category_id    TEXT PRIMARY KEY,
  name_zh        TEXT NOT NULL,
  name_en        TEXT NOT NULL,
  display_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mcp_marketplace_servers (
  server_id         TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  name_zh           TEXT,
  description_en    TEXT NOT NULL,
  description_zh    TEXT,
  icon              TEXT,
  category_id       TEXT NOT NULL REFERENCES mcp_marketplace_categories(category_id),
  transport_type    TEXT NOT NULL CHECK (transport_type IN ('stdio','sse','http')),
  command           TEXT NOT NULL,
  default_args      JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_env_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  optional_env_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  kind              TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single','bundle')),
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mcp_marketplace_servers_category_idx
  ON mcp_marketplace_servers (category_id, enabled);

-- Seeds are idempotent (ON CONFLICT DO NOTHING) so a re-run of the migration
-- files (the test harness re-executes every file with no ledger check) does
-- not trip the primary-key constraints.
INSERT INTO mcp_marketplace_categories (category_id, name_zh, name_en, display_order) VALUES
  ('search',   '搜索',     'Search',     1),
  ('data-api', '数据 API', 'Data API', 2)
  ON CONFLICT (category_id) DO NOTHING;

INSERT INTO mcp_marketplace_servers
  (server_id, name, name_zh, description_en, description_zh, category_id, transport_type, command, default_args, kind)
VALUES
  ('qichacha',
   'Qichacha', '企查查',
   'Enterprise info lookup MCP.', '企业信息查询 MCP。',
   'data-api', 'http', 'https://agent.qcc.com/mcp', '["6 servers"]'::jsonb, 'bundle'),
  ('exa-search',
   'Exa Search', 'Exa 搜索',
   'Neural web search MCP.', '神经网络网页搜索 MCP。',
   'search', 'http', 'https://mcp.exa.ai/mcp', '[]'::jsonb, 'single'),
  ('tavily-search',
   'Tavily Search', 'Tavily 搜索',
   'Research-focused web search MCP.', '面向研究的网页搜索 MCP。',
   'search', 'http', 'https://mcp.tavily.com/mcp', '[]'::jsonb, 'single')
  ON CONFLICT (server_id) DO NOTHING;
