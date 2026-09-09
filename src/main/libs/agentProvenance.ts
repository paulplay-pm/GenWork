export interface AgentProvenanceInput {
  skillIds: string[];
  subagentAllowAgentIds: string[];
  serverSkillIds: string[];
  serverSubagentAllowAgentIds: string[];
  serverImChannels: string[];
}

export interface AgentProvenance {
  baselineSkillIds: string[];
  addedSkillIds: string[];
  baselineSubagentIds: string[];
  addedSubagentIds: string[];
  imChannels: string[];
}

export function deriveProvenance(
  input: AgentProvenanceInput,
  resolveSkill: (serverSkillId: string) => string | null,
  resolveSubagent: (serverAgentId: string) => string | null,
): AgentProvenance {
  const baselineSkillIds = input.serverSkillIds
    .map((id) => resolveSkill(id))
    .filter((id): id is string => id !== null);
  const addedSkillIds = input.skillIds.filter((id) => !baselineSkillIds.includes(id));

  const baselineSubagentIds = input.serverSubagentAllowAgentIds
    .map((id) => resolveSubagent(id))
    .filter((id): id is string => id !== null);
  const addedSubagentIds = input.subagentAllowAgentIds.filter((id) => !baselineSubagentIds.includes(id));

  return {
    baselineSkillIds,
    addedSkillIds,
    baselineSubagentIds,
    addedSubagentIds,
    imChannels: input.serverImChannels,
  };
}
