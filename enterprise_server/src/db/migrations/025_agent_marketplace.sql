-- v1
-- Enterprise agent catalog (flat card list; mirrors 023 skills / 018 MCP).
-- Single file: catalog table + index + agent_admin role seed.

CREATE TABLE IF NOT EXISTS agent_marketplace_agents (
  agent_id                 TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  identity                 TEXT NOT NULL DEFAULT '',
  system_prompt            TEXT NOT NULL DEFAULT '',
  model                    TEXT NOT NULL DEFAULT '',
  thinking_level           TEXT NOT NULL DEFAULT '',
  icon                     TEXT NOT NULL DEFAULT '',
  skill_ids                JSONB NOT NULL DEFAULT '[]'::jsonb,
  subagent_allow_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_roles            JSONB NOT NULL DEFAULT '["org_admin"]'::jsonb,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_marketplace_agents_enabled_idx
  ON agent_marketplace_agents (enabled);

-- agent_admin: enterprise agent catalog authoring. Server-gated on
-- `agents.manage`. Idempotent.
INSERT INTO roles (id, name, description, permissions)
  VALUES (gen_random_uuid(), 'agent_admin', 'Manages enterprise agent templates', '["agents.manage"]'::jsonb)
  ON CONFLICT (name) DO NOTHING;
