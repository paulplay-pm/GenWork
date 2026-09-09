import { describe, expect, test } from 'vitest';

import type { AgentMarketplaceItem } from '../../../src/api/agentMarketplace';
import { draftFromAgent, emptyDraft, isDirty, validateDraft } from '../../../src/pages/agentManage/drawer/drawerForm';

const item = (): AgentMarketplaceItem => ({
  agentId: 'a1', name: 'N', description: 'd', identity: 'i', systemPrompt: 'p',
  model: 'gpt-5', thinkingLevel: 'medium', icon: 'bot', iconColor: 2, aboutYou: 'me',
  skillIds: ['s1'], subagentAllowAgentIds: ['a2'], allowedRoles: ['org_admin'], enabled: true,
  imChannels: ['feishu'],
});

describe('drawerForm', () => {
  test('draftFromAgent copies every field', () => {
    const d = draftFromAgent(item());
    expect(d.agentId).toBe('a1');
    expect(d.aboutYou).toBe('me');
    expect(d.iconColor).toBe(2);
    expect(d.thinkingLevel).toBe('medium');
  });
  test('isDirty is false for an unchanged edit draft', () => {
    const base = draftFromAgent(item());
    expect(isDirty(base, base)).toBe(false);
  });
  test('isDirty is true after a field change', () => {
    const base = draftFromAgent(item());
    const changed = { ...base, name: 'M' };
    expect(isDirty(changed, base)).toBe(true);
  });
  test('validateDraft flags empty name and empty roles', () => {
    expect(validateDraft(emptyDraft()).name).toBeTruthy();
    const withName = { ...emptyDraft(), name: 'x' };
    expect(validateDraft(withName).roles).toBeTruthy();
    const ok = { ...withName, allowedRoles: ['org_admin'] };
    expect(validateDraft(ok)).toEqual({});
  });
});
