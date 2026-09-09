import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../src/main/policies/policyResolver', () => ({
  policyResolver: {
    resolveMcpList: vi.fn((a, u) => u),
    resolveSkillList: vi.fn((a, u) => u),
    resolveModelList: vi.fn((a, u) => u),
  },
}));

import { buildProviderConfig, resolvePolicies } from '../../../src/main/libs/openclawProviderConfig';

describe('main/libs/openclawProviderConfig', () => {
  test('provider 段只写 endpoint 不含 key', () => {
    const cfg = buildProviderConfig(
      { userId: 'u1', orgId: 'o1', roles: ['user'] },
      [{ id: 'm1', provider: 'openai', model: 'gpt-4o', endpoint: 'https://ent/proxy/openai' }]
    );
    expect(cfg).not.toHaveProperty('api_key');
    expect(cfg.openai.endpoint).toBe('https://ent/proxy/openai');
    expect(cfg.openai.model).toBe('gpt-4o');
  });

  test('resolvePolicies 透传到 policyResolver', () => {
    const ctx = { userId: 'u1', orgId: 'o1', roles: ['user'], departmentPath: '/root' };
    const out = resolvePolicies(
      ctx,
      {
        mcp: [{ id: 'm1', disabled: false, scope: 'org-wide' }],
        skill: [],
        model: [{ id: 'mo1', disabled: true, scope: 'org-wide' }],
      },
      { mcp: [{ id: 'm1' }], skill: [], model: [{ id: 'mo1' }] }
    );
    expect(out.mcp).toEqual([{ id: 'm1' }]);
    expect(out.model).toEqual([{ id: 'mo1' }]);
  });
});