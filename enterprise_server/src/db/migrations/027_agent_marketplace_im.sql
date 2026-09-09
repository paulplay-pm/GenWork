-- v1
-- Add `im_channels` (JSONB array of IM platform ids) to the agent catalog.
-- The enterprise admin SPA's "IM 渠道" tab lets an admin choose which channels
-- an agent is enabled for; the desktop honors this as agent metadata. Mirrors
-- the skill_ids / allowed_roles / subagent_allow_agent_ids list fields.
ALTER TABLE agent_marketplace_agents
  ADD COLUMN IF NOT EXISTS im_channels JSONB NOT NULL DEFAULT '[]'::jsonb;
