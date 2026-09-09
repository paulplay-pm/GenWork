import { describe, expect, test } from 'vitest';

import agentReducer, { addAgent, setAgents, setEnterpriseSyncReport } from './agentSlice';

describe('agentSlice.isServerOwned', () => {
  test('addAgent with source=enterprise → isServerOwned true', () => {
    const state = agentReducer(undefined, addAgent({
      id: 'l1', name: 'E', description: '', aboutYou: '', icon: '', model: '',
      thinkingLevel: '', workingDirectory: '', enabled: true, pinned: false,
      isDefault: false, source: 'enterprise', skillIds: [], subagentAllowAgentIds: [],
      serverSkillIds: [], serverSubagentAllowAgentIds: [], serverImChannels: [],
      isServerOwned: false,
    }));
    expect(state.agents[0].isServerOwned).toBe(true);
  });

  test('addAgent with source=custom → isServerOwned false', () => {
    const state = agentReducer(undefined, addAgent({
      id: 'l1', name: 'C', description: '', aboutYou: '', icon: '', model: '',
      thinkingLevel: '', workingDirectory: '', enabled: true, pinned: false,
      isDefault: false, source: 'custom', skillIds: [], subagentAllowAgentIds: [],
      serverSkillIds: [], serverSubagentAllowAgentIds: [], serverImChannels: [],
      isServerOwned: false,
    }));
    expect(state.agents[0].isServerOwned).toBe(false);
  });

  test('setAgents stamps isServerOwned based on source for every row', () => {
    const state = agentReducer(undefined, setAgents([
      { id: 'a', name: 'A', description: '', aboutYou: '', icon: '', model: '', thinkingLevel: '',
        workingDirectory: '', enabled: true, pinned: false, isDefault: false,
        source: 'enterprise', skillIds: [], subagentAllowAgentIds: [],
        serverSkillIds: [], serverSubagentAllowAgentIds: [], serverImChannels: [] },
      { id: 'b', name: 'B', description: '', aboutYou: '', icon: '', model: '', thinkingLevel: '',
        workingDirectory: '', enabled: true, pinned: false, isDefault: false,
        source: 'custom', skillIds: [], subagentAllowAgentIds: [],
        serverSkillIds: [], serverSubagentAllowAgentIds: [], serverImChannels: [] },
    ]));
    expect(state.agents.find(a => a.id === 'a')?.isServerOwned).toBe(true);
    expect(state.agents.find(a => a.id === 'b')?.isServerOwned).toBe(false);
  });

  test('setEnterpriseSyncReport stores the report', () => {
    const state = agentReducer(undefined, setEnterpriseSyncReport({ upserted: 2, removed: 1, skipped: 0 }));
    expect(state.lastEnterpriseSyncReport).toEqual({ upserted: 2, removed: 1, skipped: 0 });
  });
});
