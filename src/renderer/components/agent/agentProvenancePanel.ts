/**
 * Provenance partitioning for enterprise (server-owned) agents.
 *
 * Splits the effective (server baseline + local overlay) id sets into the
 * locked baseline part (owned by the server, not removable) and the locally
 * added part (removable by the user).
 */

export interface SkillPartition {
  lockedSkillIds: string[];
  removableSkillIds: string[];
}

export function partitionSkills(input: {
  effectiveSkillIds: string[];
  baselineSkillIds: string[];
}): SkillPartition {
  const lockedSkillIds = input.effectiveSkillIds.filter((id) => input.baselineSkillIds.includes(id));
  const removableSkillIds = input.effectiveSkillIds.filter((id) => !input.baselineSkillIds.includes(id));
  return { lockedSkillIds, removableSkillIds };
}

export function partitionSubagents(input: {
  effectiveSubagentIds: string[];
  baselineSubagentIds: string[];
}): SkillPartition {
  const locked = input.effectiveSubagentIds.filter((id) => input.baselineSubagentIds.includes(id));
  const removable = input.effectiveSubagentIds.filter((id) => !input.baselineSubagentIds.includes(id));
  return { lockedSkillIds: locked, removableSkillIds: removable };
}

export interface SubagentBaselineCandidate {
  id: string;
  name: string;
}

/**
 * Locked baseline candidate rows for the Collaboration tab of an
 * enterprise (server-owned) agent.
 *
 * - Resolved local ids (the server collaborator has a local mirror row) are
 *   rendered from the local agent when that row exists, else by the raw id.
 * - Raw server ids with NO local mirror row (unresolvable baseline) render
 *   by the raw id (spec decision 3) so a baseline collaborator is never
 *   silently dropped. A raw id is unresolvable when no agent row carries
 *   it as `enterpriseAgentId` (the mirror check) and it does not coincide
 *   with a resolved local id — so each server collaborator yields exactly
 *   one row.
 */
export function buildBaselineSubagentCandidates(input: {
  baselineLocalIds: string[];
  serverRawIds: string[];
  agents: Array<{ id: string; name: string; enterpriseAgentId?: string }>;
}): SubagentBaselineCandidate[] {
  const { baselineLocalIds, serverRawIds, agents } = input;
  const resolved = baselineLocalIds.map((localId) => {
    const local = agents.find((agent) => agent.id === localId);
    return local ? { id: local.id, name: local.name } : { id: localId, name: localId };
  });
  const unresolvable = serverRawIds
    .filter(
      (rawId) => (
        !baselineLocalIds.includes(rawId)
        && !agents.some((agent) => agent.enterpriseAgentId === rawId)
      ),
    )
    .map((rawId) => ({ id: rawId, name: rawId }));
  return [...resolved, ...unresolvable];
}
