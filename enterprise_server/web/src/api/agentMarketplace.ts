import { apiClient } from './client';

export interface AgentMarketplaceItem {
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

export interface AgentInput {
  name: string;
  description?: string;
  identity?: string;
  system_prompt?: string;
  model?: string;
  thinking_level?: string;
  icon?: string;
  skill_ids?: string[];
  subagent_allow_agent_ids?: string[];
  allowed_roles: string[];
  enabled?: boolean;
  about_you?: string;
  icon_color?: number;
  im_channels?: string[];
}

export type AgentPatch = Partial<AgentInput>;

export const agentMarketplaceApi = {
  // Public (role-filtered) catalog — used by the agent picker on cross-references.
  listPublic: () => apiClient.get<{ agents: AgentMarketplaceItem[] }>('/api/agent-marketplace'),
  listRoleOptions: () => apiClient.get<{ roles: string[] }>('/api/agent-marketplace/role-options'),

  // Admin CRUD
  list: () => apiClient.get<AgentMarketplaceItem[]>('/api/admin/agent-marketplace/agents'),
  createAgent: (input: AgentInput) =>
    apiClient.post<{ agent_id: string }>('/api/admin/agent-marketplace/agents', input),
  update: (id: string, patch: AgentPatch) =>
    apiClient.put<void>(`/api/admin/agent-marketplace/agents/${id}`, patch),
  remove: (id: string) => apiClient.delete(`/api/admin/agent-marketplace/agents/${id}`),
  getReferences: (id: string) =>
    apiClient.get<{ ids: string[]; names: string[] }>(`/api/admin/agent-marketplace/agents/${id}/references`),

  // Cross-pickers (reuse the existing skill marketplace admin list)
  listSkillsForPicker: () =>
    apiClient.get<Array<{ id: string; name: string; name_zh: string | null; enabled?: boolean }>>('/api/admin/skill-marketplace/skills'),
};
