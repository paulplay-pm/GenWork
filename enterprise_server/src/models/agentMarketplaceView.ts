/** Single source of the SELECT column list used by both the public catalog
 *  route and the admin list route. Keep in sync with migrations 025/026/027. */
export const AGENT_COLUMNS = `agent_id, name, description, identity, system_prompt,
  model, thinking_level, icon, skill_ids, subagent_allow_agent_ids,
  allowed_roles, enabled, about_you, icon_color, im_channels`;

/** DB row shape for a marketplace agent (post-027). */
export interface AgentRow {
  agent_id: string;
  name: string;
  description: string;
  identity: string;
  system_prompt: string;
  model: string;
  thinking_level: string;
  icon: string;
  skill_ids: string[] | null;
  subagent_allow_agent_ids: string[] | null;
  allowed_roles: string[];
  enabled: boolean;
  about_you: string;
  icon_color: number;
  im_channels: string[] | null;
}

/** Wire shape returned by both the public catalog and the admin list. */
export interface AgentMarketplaceView {
  agentId: string;
  name: string;
  description: string;
  identity: string;
  systemPrompt: string;
  model: string;
  thinkingLevel: string;
  icon: string;
  skillIds: string[];
  subagentAllowAgentIds: string[];
  allowedRoles: string[];
  enabled: boolean;
  aboutYou: string;
  iconColor: number;
  imChannels: string[];
}

export function mapAgent(row: AgentRow): AgentMarketplaceView {
  return {
    agentId: row.agent_id,
    name: row.name,
    description: row.description,
    identity: row.identity,
    systemPrompt: row.system_prompt,
    model: row.model,
    thinkingLevel: row.thinking_level,
    icon: row.icon,
    skillIds: row.skill_ids ?? [],
    subagentAllowAgentIds: row.subagent_allow_agent_ids ?? [],
    allowedRoles: row.allowed_roles,
    enabled: row.enabled,
    aboutYou: row.about_you ?? '',
    iconColor: row.icon_color ?? 0,
    imChannels: row.im_channels ?? [],
  };
}
