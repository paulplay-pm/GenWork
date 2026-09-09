import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { agentMarketplaceApi } from '../../src/api/agentMarketplace';
import { apiClient } from '../../src/api/client';

beforeEach(() => {
  fetchMock.mockReset();
  apiClient.setBaseUrl('http://server');
  apiClient.setTokenProvider(() => 'tok');
});

describe('agentMarketplaceApi', () => {
  test('listRoleOptions hits the picker route', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ roles: ['super_admin', 'org_admin', 'agent_admin'] }), { status: 200 }));
    const res = await agentMarketplaceApi.listRoleOptions();
    expect(res.roles).toContain('agent_admin');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://server/api/agent-marketplace/role-options');
  });

  test('createAgent posts the body with required allowed_roles', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ agent_id: 'agent_1' }), { status: 200 }));
    const out = await agentMarketplaceApi.createAgent({ name: 'X', allowed_roles: ['org_admin'] });
    expect(out.agent_id).toBe('agent_1');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ name: 'X', allowed_roles: ['org_admin'] });
  });

  test('getReferences returns the affected agents', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ids: ['b'], names: ['B'] }), { status: 200 }));
    const out = await agentMarketplaceApi.getReferences('a');
    expect(out.ids).toEqual(['b']);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://server/api/admin/agent-marketplace/agents/a/references');
  });
});
