-- v1
-- Add `about_you` (the "关于你" field) and `icon_color` (the tint index for
-- the glyph/color picker) to the agent catalog.
ALTER TABLE agent_marketplace_agents
  ADD COLUMN IF NOT EXISTS about_you  TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_marketplace_agents
  ADD COLUMN IF NOT EXISTS icon_color SMALLINT NOT NULL DEFAULT 0;
