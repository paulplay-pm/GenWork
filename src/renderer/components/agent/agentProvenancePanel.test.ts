import { describe, expect, test } from 'vitest';

import { buildBaselineSubagentCandidates, partitionSkills, partitionSubagents } from './agentProvenancePanel';

describe('partitionSkills', () => {
  test('marks baseline skills locked and added skills removable', () => {
    const p = partitionSkills({
      effectiveSkillIds: ['local_s1', 'local_mine'],
      baselineSkillIds: ['local_s1'],
    });
    expect(p.lockedSkillIds).toEqual(['local_s1']);
    expect(p.removableSkillIds).toEqual(['local_mine']);
  });

  test('returns empty partitions when nothing is effective', () => {
    const p = partitionSkills({ effectiveSkillIds: [], baselineSkillIds: ['local_s1'] });
    expect(p.lockedSkillIds).toEqual([]);
    expect(p.removableSkillIds).toEqual([]);
  });

  test('keeps order of the effective set', () => {
    const p = partitionSkills({
      effectiveSkillIds: ['b', 'a', 'c'],
      baselineSkillIds: ['c', 'a'],
    });
    expect(p.lockedSkillIds).toEqual(['a', 'c']);
    expect(p.removableSkillIds).toEqual(['b']);
  });
});

describe('partitionSubagents', () => {
  test('marks baseline subagents locked and added subagents removable', () => {
    const p = partitionSubagents({
      effectiveSubagentIds: ['agent_b', 'agent_mine'],
      baselineSubagentIds: ['agent_b'],
    });
    expect(p.lockedSkillIds).toEqual(['agent_b']);
    expect(p.removableSkillIds).toEqual(['agent_mine']);
  });

  test('returns empty partitions when nothing is effective', () => {
    const p = partitionSubagents({ effectiveSubagentIds: [], baselineSubagentIds: ['agent_b'] });
    expect(p.lockedSkillIds).toEqual([]);
    expect(p.removableSkillIds).toEqual([]);
  });
});

describe('buildBaselineSubagentCandidates', () => {
  // Local mirror rows carry the server id in `enterpriseAgentId` (local ids
  // are name slugs/uuids, a different id-space than raw server ids).
  const agents = [
    { id: 'local_x', name: 'Mirror X', enterpriseAgentId: 'srv_x' },
    { id: 'local_y', name: 'Mirror Y', enterpriseAgentId: 'srv_y' },
  ];

  test('renders resolved local ids by the local agent, one row per server id', () => {
    const candidates = buildBaselineSubagentCandidates({
      baselineLocalIds: ['local_x', 'local_y'],
      serverRawIds: ['srv_x', 'srv_y'],
      agents,
    });
    expect(candidates).toEqual([
      { id: 'local_x', name: 'Mirror X' },
      { id: 'local_y', name: 'Mirror Y' },
    ]);
  });

  test('renders an unresolvable raw server id (no mirror row) by raw id', () => {
    // `srv_z` has no local mirror row (e.g. restricted by allowedRoles): it
    // must still render as a baseline candidate by its raw server id instead
    // of being silently dropped (spec decision 3) — while `srv_x` (mirrored)
    // is NOT duplicated by its raw id.
    const candidates = buildBaselineSubagentCandidates({
      baselineLocalIds: ['local_x'],
      serverRawIds: ['srv_x', 'srv_z'],
      agents,
    });
    expect(candidates).toEqual([
      { id: 'local_x', name: 'Mirror X' },
      { id: 'srv_z', name: 'srv_z' },
    ]);
  });

  test('does not duplicate a raw server id that coincides with a resolved local id', () => {
    const candidates = buildBaselineSubagentCandidates({
      baselineLocalIds: ['srv_x'],
      serverRawIds: ['srv_x'],
      agents: [{ id: 'srv_x', name: 'Same', enterpriseAgentId: 'other' }],
    });
    expect(candidates).toEqual([{ id: 'srv_x', name: 'Same' }]);
  });

  test('a resolved local id without a matching agent row still renders by that id', () => {
    const candidates = buildBaselineSubagentCandidates({
      baselineLocalIds: ['local_gone'],
      serverRawIds: ['srv_gone'],
      agents: [],
    });
    expect(candidates).toEqual([
      { id: 'local_gone', name: 'local_gone' },
      { id: 'srv_gone', name: 'srv_gone' },
    ]);
  });
});
