import { describe, expect, test } from 'vitest';

import { deriveProvenance } from './agentProvenance';

const resolveSkill = (id: string) => (id === 'missing' ? null : 'local_' + id);
const resolveSub = (id: string) => (id === 'ghost' ? null : 'localagent_' + id);

describe('deriveProvenance', () => {
  test('partitions skills into baseline and added', () => {
    const p = deriveProvenance(
      { skillIds: ['local_s1', 'local_s2', 'local_extra'], subagentAllowAgentIds: [], serverSkillIds: ['s1', 's2'], serverSubagentAllowAgentIds: [], serverImChannels: [] },
      resolveSkill, resolveSub,
    );
    expect(p.baselineSkillIds).toEqual(['local_s1', 'local_s2']);
    expect(p.addedSkillIds).toEqual(['local_extra']);
  });

  test('unresolvable server skill ids are excluded from baseline', () => {
    const p = deriveProvenance(
      { skillIds: ['local_missing'], subagentAllowAgentIds: [], serverSkillIds: ['missing', 's1'], serverSubagentAllowAgentIds: [], serverImChannels: [] },
      resolveSkill, resolveSub,
    );
    expect(p.baselineSkillIds).toEqual(['local_s1']);
    expect(p.addedSkillIds).toEqual(['local_missing']);
  });

  test('partitions subagents and drops unresolvable server refs', () => {
    const p = deriveProvenance(
      { skillIds: [], subagentAllowAgentIds: ['localagent_x', 'localagent_mine'], serverSkillIds: [], serverSubagentAllowAgentIds: ['x', 'ghost'], serverImChannels: [] },
      resolveSkill, resolveSub,
    );
    expect(p.baselineSubagentIds).toEqual(['localagent_x']);
    expect(p.addedSubagentIds).toEqual(['localagent_mine']);
  });

  test('imChannels is the verbatim server set', () => {
    const p = deriveProvenance(
      { skillIds: [], subagentAllowAgentIds: [], serverSkillIds: [], serverSubagentAllowAgentIds: [], serverImChannels: ['feishu', 'dingtalk'] },
      resolveSkill, resolveSub,
    );
    expect(p.imChannels).toEqual(['feishu', 'dingtalk']);
  });
});
