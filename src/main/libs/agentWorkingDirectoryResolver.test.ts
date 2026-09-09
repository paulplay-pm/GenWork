import { describe, expect, test, vi } from 'vitest';

import type { Agent } from '../genworkStore';
import { type CwdResolverDeps,resolveAgentDefaultWorkingDirectory } from './agentWorkingDirectoryResolver';

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: 'a1',
    name: 'Agent',
    description: '',
    systemPrompt: '',
    identity: '',
    model: '',
    thinkingLevel: '',
    workingDirectory: '',
    icon: '',
    skillIds: [],
    subagentAllowAgentIds: [],
    enabled: true,
    pinned: false,
    isDefault: false,
    source: 'custom',
    presetId: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeDeps(agent: Agent | null, prefsWorkingDirectory = ''): CwdResolverDeps {
  return {
    getAgent: vi.fn((_id: string) => agent),
    getEnterpriseAgentPrefs: vi.fn(() => prefsWorkingDirectory),
    getGlobalDefaultCwd: vi.fn(() => '/global/default'),
  };
}

describe('resolveAgentDefaultWorkingDirectory', () => {
  test('enterprise agent with non-empty prefs returns the prefs value, not the global default', () => {
    const agent = makeAgent({ source: 'enterprise', enterpriseAgentId: 'ent_1', workingDirectory: '' });
    const deps = makeDeps(agent, '/prefs/wd');
    const result = resolveAgentDefaultWorkingDirectory('a1', deps);
    expect(result).toBe('/prefs/wd');
    expect(deps.getEnterpriseAgentPrefs).toHaveBeenCalledWith('ent_1');
    expect(deps.getGlobalDefaultCwd).not.toHaveBeenCalled();
  });

  test('enterprise agent with empty prefs falls back to the global default (row wd is "")', () => {
    const agent = makeAgent({ source: 'enterprise', enterpriseAgentId: 'ent_1', workingDirectory: '' });
    const deps = makeDeps(agent, '   ');
    const result = resolveAgentDefaultWorkingDirectory('a1', deps);
    expect(result).toBe('/global/default');
  });

  test("custom agent with a non-empty row workingDirectory returns the row wd (prefs not consulted)", () => {
    const agent = makeAgent({ source: 'custom', workingDirectory: '/row/wd' });
    const deps = makeDeps(agent, '/prefs/wd');
    const result = resolveAgentDefaultWorkingDirectory('a1', deps);
    expect(result).toBe('/row/wd');
    expect(deps.getEnterpriseAgentPrefs).not.toHaveBeenCalled();
  });

  test('custom agent with empty row workingDirectory returns the global default', () => {
    const agent = makeAgent({ source: 'custom', workingDirectory: '' });
    const deps = makeDeps(agent);
    const result = resolveAgentDefaultWorkingDirectory('a1', deps);
    expect(result).toBe('/global/default');
  });

  test('undefined/blank agentId resolves to "main"', () => {
    const agent = makeAgent({ id: 'main', source: 'custom', workingDirectory: '/main/wd' });
    const deps = makeDeps(agent);
    expect(resolveAgentDefaultWorkingDirectory(undefined, deps)).toBe('/main/wd');
    expect(resolveAgentDefaultWorkingDirectory('   ', deps)).toBe('/main/wd');
    expect(deps.getAgent).toHaveBeenCalledWith('main');
  });
});
