import type { AgentInput, AgentMarketplaceItem } from '../../../api/agentMarketplace';

export interface AgentDraft {
  agentId: string | null;
  name: string; description: string; icon: string; iconColor: number;
  model: string; thinkingLevel: string; enabled: boolean;
  identity: string; systemPrompt: string; aboutYou: string;
  skillIds: string[]; subagentAllowAgentIds: string[]; allowedRoles: string[];
  imChannels: string[];
}

export function emptyDraft(): AgentDraft {
  // No default role: a new agent is only visible once the admin explicitly
  // picks at least one role in the 可见范围 tab (validateDraft enforces it).
  return { agentId: null, name: '', description: '', icon: 'bot', iconColor: 0,
    model: '', thinkingLevel: 'medium', enabled: true, identity: '', systemPrompt: '',
    aboutYou: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: [], imChannels: [] };
}

export function draftFromAgent(a: AgentMarketplaceItem): AgentDraft {
  return { agentId: a.agentId, name: a.name, description: a.description, icon: a.icon,
    iconColor: a.iconColor, model: a.model, thinkingLevel: a.thinkingLevel || 'medium',
    enabled: a.enabled, identity: a.identity, systemPrompt: a.systemPrompt, aboutYou: a.aboutYou,
    skillIds: [...a.skillIds], subagentAllowAgentIds: [...a.subagentAllowAgentIds],
    allowedRoles: [...a.allowedRoles], imChannels: [...(a.imChannels ?? [])] };
}

export function isDirty(d: AgentDraft, initial: AgentDraft): boolean {
  if (d.agentId === null) return JSON.stringify(d) !== JSON.stringify(emptyDraft());
  return JSON.stringify(d) !== JSON.stringify(initial);
}

export function validateDraft(d: AgentDraft): { name?: string; roles?: string } {
  const errs: { name?: string; roles?: string } = {};
  if (!d.name.trim()) errs.name = 'name';
  if (d.allowedRoles.length === 0) errs.roles = 'roles';
  return errs;
}

export function draftToInput(d: AgentDraft): AgentInput {
  return { name: d.name.trim(), description: d.description, identity: d.identity,
    system_prompt: d.systemPrompt, model: d.model, thinking_level: d.thinkingLevel,
    icon: d.icon, icon_color: d.iconColor, about_you: d.aboutYou,
    skill_ids: d.skillIds, subagent_allow_agent_ids: d.subagentAllowAgentIds,
    allowed_roles: d.allowedRoles, enabled: d.enabled, im_channels: d.imChannels };
}
