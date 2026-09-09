import { beforeEach, describe, expect, test, vi } from 'vitest';

const { senderSends, registeredHandlers } = vi.hoisted(() => ({
  senderSends: [] as Array<{ channel: string; payload: unknown }>,
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../auth/enterpriseClient', () => ({
  enterpriseClient: {
    listEnterpriseMcps: vi.fn(),
    submitConnectorRequest: vi.fn(),
  },
}));

vi.mock('../../auth/loginGate', () => ({
  loginGate: { requireEnterprise: () => ({ sub: 'u', orgId: 'o', roles: [] }) },
}));

import { McpAuthStatus, McpIpcChannel } from '../../../shared/mcp/constants';
import { enterpriseClient } from '../../auth/enterpriseClient';
import { registerMcpHandlers } from './handlers';

describe('McpIpcChannel.FetchEnterpriseMarketplace handler', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    registerMcpHandlers({
      getMcpRuntime: () => ({}) as never,
      syncOpenClawConfig: async () => ({ success: true, changed: false }),
    });
    vi.mocked(enterpriseClient.listEnterpriseMcps).mockReset();
  });

  test('returns { success: true, data } on a successful fetch', async () => {
    const body = {
      categories: [{ id: 'search', name_zh: '搜索', name_en: 'Search' }],
      servers: [
        {
          id: 'x',
          serverKey: 'x',
          name: 'X',
          nameZh: null,
          description: 'd',
          category: 'search',
          version: '1.0.0',
          connectorType: 'mcp' as const,
          url: 'https://x.test',
          transport: 'http' as const,
          authMode: 'none' as const,
          authStatus: 'configured' as const,
          scopeSummary: 'all',
          hasDraft: false,
          enabled: true,
          toolCount: 3,
        },
      ],
    };
    vi.mocked(enterpriseClient.listEnterpriseMcps).mockResolvedValue(body);

    const handler = registeredHandlers.get(McpIpcChannel.FetchEnterpriseMarketplace);
    expect(handler).toBeDefined();
    const result = await handler!();
    expect(result).toEqual({ success: true, data: body });
  });

  test('returns { success: false, error } when listEnterpriseMcps throws', async () => {
    vi.mocked(enterpriseClient.listEnterpriseMcps).mockRejectedValue(new Error('http 401'));
    const handler = registeredHandlers.get(McpIpcChannel.FetchEnterpriseMarketplace)!;
    const result = await handler!();
    expect(result).toEqual({ success: false, error: 'http 401' });
  });
});

describe('McpIpcChannel.SubmitConnectorRequest handler', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    registerMcpHandlers({
      getMcpRuntime: () => ({}) as never,
      syncOpenClawConfig: async () => ({ success: true, changed: false }),
    });
    vi.mocked(enterpriseClient.submitConnectorRequest).mockReset();
  });

  test('forwards the cfg to submitConnectorRequest and returns the submission id', async () => {
    vi.mocked(enterpriseClient.submitConnectorRequest).mockResolvedValue({ id: 'sub-1' });
    const handler = registeredHandlers.get(McpIpcChannel.SubmitConnectorRequest);
    expect(handler).toBeDefined();

    const cfg = {
      serverKey: 'my-data',
      url: 'https://mcp.example.com/sse',
      authMode: 'shared-key' as const,
      authConfig: { apiKey: 'sk-member-secret' },
    };
    const result = await handler!({}, cfg);
    expect(enterpriseClient.submitConnectorRequest).toHaveBeenCalledWith(cfg);
    expect(result).toEqual({ success: true, data: { id: 'sub-1' } });
  });

  test('returns { success: false, error } when the submit throws (e.g. 403 submission_disabled)', async () => {
    vi.mocked(enterpriseClient.submitConnectorRequest).mockRejectedValue(new Error('http 403'));
    const handler = registeredHandlers.get(McpIpcChannel.SubmitConnectorRequest)!;
    const result = await handler!({}, { serverKey: 'x', url: 'https://x.test' });
    expect(result).toEqual({ success: false, error: 'http 403' });
  });
});

describe('McpIpcChannel.SetEnabled handler (gated by authStatus)', () => {
  let mcpStoreStub: {
    getServer: ReturnType<typeof vi.fn>;
    setEnabled: ReturnType<typeof vi.fn>;
    listServers: ReturnType<typeof vi.fn>;
    ensureLaunchResolution: ReturnType<typeof vi.fn>;
  };
  let event: { sender: { send: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    senderSends.length = 0;
    registeredHandlers.clear();
    mcpStoreStub = {
      getServer: vi.fn(),
      setEnabled: vi.fn(),
      listServers: vi.fn().mockReturnValue([]),
      ensureLaunchResolution: vi.fn(),
    };
    event = {
      sender: {
        send: vi.fn((channel: string, payload: unknown) => {
          senderSends.push({ channel, payload });
        }),
      },
    };
    registerMcpHandlers({
      getMcpRuntime: () => ({
        getStore: () => mcpStoreStub,
        ensureLaunchResolution: mcpStoreStub.ensureLaunchResolution,
      }) as never,
      syncOpenClawConfig: async () => ({ success: true, changed: false }),
    });
  });

  test('enabled:true on a needs-auth record → returns gated shape, setEnabled NOT called, AuthFlowRequested pushed', async () => {
    const record = {
      id: 's1',
      name: 'A',
      description: '',
      transportType: 'http' as const,
      url: 'https://a.test',
      authMethod: 'bearer' as const,
      authStatus: McpAuthStatus.NeedsAuth,
      enabled: false,
      isBuiltIn: false,
      registryId: null,
      createdAt: 0,
      updatedAt: 0,
    };
    mcpStoreStub.getServer.mockReturnValue(record);

    const handler = registeredHandlers.get(McpIpcChannel.SetEnabled)!;
    const result = await handler!(event, { id: 's1', enabled: true });

    expect(mcpStoreStub.setEnabled).not.toHaveBeenCalled();
    expect(mcpStoreStub.ensureLaunchResolution).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      enabled: false,
      startedAuth: true,
      server: record,
      servers: [],
    });
    expect(senderSends).toEqual([
      { channel: McpIpcChannel.AuthFlowRequested, payload: { id: 's1' } },
    ]);
  });

  test('enabled:true on an authenticated record → returns existing shape, setEnabled called, no IPC push', async () => {
    const record = {
      id: 's2',
      name: 'B',
      description: '',
      transportType: 'http' as const,
      url: 'https://b.test',
      authMethod: 'bearer' as const,
      authStatus: McpAuthStatus.Authenticated,
      enabled: false,
      isBuiltIn: false,
      registryId: null,
      createdAt: 0,
      updatedAt: 0,
    };
    mcpStoreStub.getServer.mockReturnValue(record);

    const handler = registeredHandlers.get(McpIpcChannel.SetEnabled)!;
    const result = await handler!(event, { id: 's2', enabled: true });

    expect(mcpStoreStub.setEnabled).toHaveBeenCalledWith('s2', true);
    expect(mcpStoreStub.ensureLaunchResolution).toHaveBeenCalledWith('s2', 'mcp-server-enabled');
    expect(result).toEqual({ success: true, servers: [] });
    expect(senderSends).toEqual([]);
  });

  test('enabled:false on a needs-auth record → disable is always allowed, setEnabled called, no IPC push', async () => {
    const record = {
      id: 's3',
      name: 'C',
      description: '',
      transportType: 'http' as const,
      url: 'https://c.test',
      authMethod: 'bearer' as const,
      authStatus: McpAuthStatus.NeedsAuth,
      enabled: true,
      isBuiltIn: false,
      registryId: null,
      createdAt: 0,
      updatedAt: 0,
    };
    mcpStoreStub.getServer.mockReturnValue(record);

    const handler = registeredHandlers.get(McpIpcChannel.SetEnabled)!;
    const result = await handler!(event, { id: 's3', enabled: false });

    expect(mcpStoreStub.setEnabled).toHaveBeenCalledWith('s3', false);
    expect(mcpStoreStub.ensureLaunchResolution).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, servers: [] });
    expect(senderSends).toEqual([]);
  });
});

describe('McpIpcChannel.SetEnabledByRegistryId handler (gated by authStatus)', () => {
  let mcpStoreStub: {
    getServer: ReturnType<typeof vi.fn>;
    setEnabled: ReturnType<typeof vi.fn>;
    listServers: ReturnType<typeof vi.fn>;
    ensureLaunchResolution: ReturnType<typeof vi.fn>;
  };
  let event: { sender: { send: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    senderSends.length = 0;
    registeredHandlers.clear();
    mcpStoreStub = {
      getServer: vi.fn(),
      setEnabled: vi.fn(),
      listServers: vi.fn().mockReturnValue([]),
      ensureLaunchResolution: vi.fn(),
    };
    event = {
      sender: {
        send: vi.fn((channel: string, payload: unknown) => {
          senderSends.push({ channel, payload });
        }),
      },
    };
    registerMcpHandlers({
      getMcpRuntime: () => ({
        getStore: () => mcpStoreStub,
        ensureLaunchResolution: mcpStoreStub.ensureLaunchResolution,
      }) as never,
      syncOpenClawConfig: async () => ({ success: true, changed: false }),
    });
  });

  test('mixed registry (one auth, one needs-auth) → only the authenticated one is enabled; gatedServers contains needs-auth; one IPC push', async () => {
    const authed = {
      id: 'r1',
      name: 'Authed',
      description: '',
      transportType: 'http' as const,
      url: 'https://r1.test',
      authMethod: 'bearer' as const,
      authStatus: McpAuthStatus.Authenticated,
      enabled: false,
      isBuiltIn: true,
      registryId: 'qcc-company',
      createdAt: 0,
      updatedAt: 0,
    };
    const needsAuth = {
      id: 'r2',
      name: 'NeedsAuth',
      description: '',
      transportType: 'http' as const,
      url: 'https://r2.test',
      authMethod: 'bearer' as const,
      authStatus: McpAuthStatus.NeedsAuth,
      enabled: false,
      isBuiltIn: true,
      registryId: 'qcc-company',
      createdAt: 0,
      updatedAt: 0,
    };
    mcpStoreStub.listServers.mockReturnValue([authed, needsAuth]);

    const handler = registeredHandlers.get(McpIpcChannel.SetEnabledByRegistryId)!;
    const result = await handler!(event, { registryId: 'qcc-company', enabled: true });

    expect(mcpStoreStub.setEnabled).toHaveBeenCalledTimes(1);
    expect(mcpStoreStub.setEnabled).toHaveBeenCalledWith('r1', true);
    expect(mcpStoreStub.ensureLaunchResolution).toHaveBeenCalledTimes(1);
    expect(mcpStoreStub.ensureLaunchResolution).toHaveBeenCalledWith('r1', 'mcp-registry-enabled');
    expect(result).toMatchObject({
      success: true,
      enabled: false,
      startedAuth: true,
      servers: [authed, needsAuth],
    });
    expect(result).toHaveProperty('gatedServers');
    expect((result as { gatedServers: Array<{ id: string }> }).gatedServers).toEqual([needsAuth]);
    expect(senderSends).toEqual([
      { channel: McpIpcChannel.AuthFlowRequested, payload: { id: 'r2' } },
    ]);
  });
});