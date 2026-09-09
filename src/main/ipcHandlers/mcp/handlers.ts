import { BrowserWindow, ipcMain } from 'electron';

import { type ConnectorSubmitRequest, McpAuthStatus, McpIpcChannel } from '../../../shared/mcp/constants';
import { normalizeMcpServerUrlInput } from '../../../shared/mcp/url';
import { enterpriseClient } from '../../auth/enterpriseClient';
import { loginGate } from '../../auth/loginGate';
import { OpenClawConfigImpact } from '../../libs/openclawConfigImpact';
import { probeOnly, saveCredential, type SaveCredentialPayload } from '../../mcp/mcpAuthFlows';
import type { McpRuntime } from '../../mcp/mcpRuntime';
import type { McpServerFormData, McpServerRecord } from '../../mcp/mcpStore';
import { startQichachaMcpApiKeyLogin } from '../../mcp/qichachaMcpAuth';

export interface McpHandlerDeps {
  getMcpRuntime: () => McpRuntime;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
    expectedImpact?: OpenClawConfigImpact;
  }) => Promise<{ success: boolean; changed: boolean }>;
}

function syncMcpConfig(
  syncOpenClawConfig: McpHandlerDeps['syncOpenClawConfig'],
  reason: string,
): void {
  syncOpenClawConfig({
    reason,
    expectedImpact: OpenClawConfigImpact.Restart,
  }).catch(err =>
    console.error('[MCP] config sync error:', err),
  );
}

function normalizeMcpServerInput(data: Partial<McpServerFormData>): Partial<McpServerFormData> {
  if (
    (data.transportType === 'sse' || data.transportType === 'http')
    && data.url !== undefined
  ) {
    const normalized = normalizeMcpServerUrlInput(data.url);
    if (!normalized.ok) {
      throw new Error('MCP server URL must be an absolute HTTP or HTTPS URL.');
    }
    return { ...data, url: normalized.url };
  }
  return data;
}

const QICHACHA_REGISTRY_ID = 'qichacha';

const QICHACHA_MCP_SERVERS: Array<{
  name: string;
  description: string;
  url: string;
}> = [
  {
    name: 'qcc-company',
    description: 'Qichacha company data MCP server',
    url: 'https://agent.qcc.com/mcp/company/stream',
  },
  {
    name: 'qcc-risk',
    description: 'Qichacha risk data MCP server',
    url: 'https://agent.qcc.com/mcp/risk/stream',
  },
  {
    name: 'qcc-ipr',
    description: 'Qichacha intellectual property data MCP server',
    url: 'https://agent.qcc.com/mcp/ipr/stream',
  },
  {
    name: 'qcc-operation',
    description: 'Qichacha operation data MCP server',
    url: 'https://agent.qcc.com/mcp/operation/stream',
  },
  {
    name: 'qcc-executive',
    description: 'Qichacha executive data MCP server',
    url: 'https://agent.qcc.com/mcp/executive/stream',
  },
  {
    name: 'qcc-history',
    description: 'Qichacha historical archive data MCP server',
    url: 'https://agent.qcc.com/mcp/history/stream',
  },
];

function buildQichachaServerData(
  server: typeof QICHACHA_MCP_SERVERS[number],
  apiKey: string,
): McpServerFormData {
  return {
    name: server.name,
    description: server.description,
    transportType: 'http',
    url: server.url,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    isBuiltIn: true,
    registryId: QICHACHA_REGISTRY_ID,
  };
}

export function registerMcpHandlers(deps: McpHandlerDeps): void {
  const { getMcpRuntime, syncOpenClawConfig } = deps;

  ipcMain.handle(McpIpcChannel.List, () => {
    try {
      const servers = getMcpRuntime().getStore().listServers();
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list MCP servers',
      };
    }
  });

  ipcMain.handle(
    McpIpcChannel.Create,
    async (
      _event,
      data: {
        name: string;
        description: string;
        transportType: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
      },
    ) => {
      try {
        const mcpRuntime = getMcpRuntime();
        const normalizedData = normalizeMcpServerInput(data as McpServerFormData) as McpServerFormData;
        const server = mcpRuntime.getStore().createServer(normalizedData);
        if (server.enabled) {
          mcpRuntime.ensureLaunchResolution(server.id, 'mcp-server-created');
        }
        const servers = mcpRuntime.getStore().listServers();
        syncMcpConfig(syncOpenClawConfig, 'mcp-server-created');
        return { success: true, servers };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create MCP server',
        };
      }
    },
  );

  ipcMain.handle(
    McpIpcChannel.Update,
    async (
      _event,
      id: string,
      data: {
        name?: string;
        description?: string;
        transportType?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
      },
    ) => {
      try {
        const mcpRuntime = getMcpRuntime();
        const normalizedData = normalizeMcpServerInput(data as Partial<McpServerFormData>);
        const server = mcpRuntime.getStore().updateServer(id, normalizedData);
        if (server?.enabled) {
          mcpRuntime.ensureLaunchResolution(server.id, 'mcp-server-updated');
        }
        const servers = mcpRuntime.getStore().listServers();
        syncMcpConfig(syncOpenClawConfig, 'mcp-server-updated');
        return { success: true, servers };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update MCP server',
        };
      }
    },
  );

  ipcMain.handle(McpIpcChannel.Delete, async (_event, id: string) => {
    try {
      const mcpRuntime = getMcpRuntime();
      mcpRuntime.getStore().deleteServer(id);
      const servers = mcpRuntime.getStore().listServers();
      syncMcpConfig(syncOpenClawConfig, 'mcp-server-deleted');
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete MCP server',
      };
    }
  });

  ipcMain.handle(McpIpcChannel.DeleteByRegistryId, async (_event, registryId: string) => {
    try {
      const normalizedRegistryId = registryId.trim();
      if (!normalizedRegistryId) {
        throw new Error('MCP registry id is required');
      }
      const mcpRuntime = getMcpRuntime();
      const store = mcpRuntime.getStore();
      const matchingServers = store
        .listServers()
        .filter(server => server.registryId === normalizedRegistryId);
      for (const server of matchingServers) {
        store.deleteServer(server.id);
      }
      const servers = store.listServers();
      syncMcpConfig(syncOpenClawConfig, 'mcp-registry-deleted');
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete MCP registry servers',
      };
    }
  });

  ipcMain.handle(McpIpcChannel.SetEnabled, async (event, options: { id: string; enabled: boolean }) => {
    try {
      const mcpRuntime = getMcpRuntime();
      const store = mcpRuntime.getStore();
      const record = store.getServer(options.id);

      if (options.enabled && record && (record.authStatus === McpAuthStatus.NeedsAuth || record.authStatus === McpAuthStatus.AuthError)) {
        // Gate: silently auto-open the auth flow.
        try {
          event.sender.send(McpIpcChannel.AuthFlowRequested, { id: options.id });
        } catch (err) {
          console.error('[MCP] failed to push auth flow request:', err);
        }
        const servers = store.listServers();
        return { success: true, enabled: false, startedAuth: true, server: record, servers };
      }

      store.setEnabled(options.id, options.enabled);
      if (options.enabled) {
        mcpRuntime.ensureLaunchResolution(options.id, 'mcp-server-enabled');
      }
      const servers = store.listServers();
      syncMcpConfig(syncOpenClawConfig, 'mcp-server-toggled');
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update MCP server',
      };
    }
  });

  ipcMain.handle(
    McpIpcChannel.SetEnabledByRegistryId,
    async (event, options: { registryId: string; enabled: boolean }) => {
      try {
        const normalizedRegistryId = options.registryId.trim();
        if (!normalizedRegistryId) {
          throw new Error('MCP registry id is required');
        }
        const mcpRuntime = getMcpRuntime();
        const store = mcpRuntime.getStore();
        const matchingServers = store
          .listServers()
          .filter(server => server.registryId === normalizedRegistryId);
        const gatedServers: McpServerRecord[] = [];
        for (const server of matchingServers) {
          if (options.enabled && (server.authStatus === McpAuthStatus.NeedsAuth || server.authStatus === McpAuthStatus.AuthError)) {
            gatedServers.push(server);
            try {
              event.sender.send(McpIpcChannel.AuthFlowRequested, { id: server.id });
            } catch (err) {
              console.error('[MCP] failed to push auth flow request:', err);
            }
            continue;
          }
          store.setEnabled(server.id, options.enabled);
          if (options.enabled) {
            mcpRuntime.ensureLaunchResolution(server.id, 'mcp-registry-enabled');
          }
        }
        const servers = store.listServers();
        syncMcpConfig(syncOpenClawConfig, 'mcp-registry-toggled');
        if (gatedServers.length > 0) {
          return { success: true, enabled: false, startedAuth: true, gatedServers, servers };
        }
        return { success: true, servers };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update MCP registry servers',
        };
      }
    },
  );

  ipcMain.handle(McpIpcChannel.RetryLaunchResolution, async (_event, id: string) => {
    try {
      const mcpRuntime = getMcpRuntime();
      await mcpRuntime.getLaunchResolverManager().retry(id);
      const servers = mcpRuntime.getStore().listServers();
      syncMcpConfig(syncOpenClawConfig, 'mcp-launch-manual-retry');
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to retry MCP launch resolution',
      };
    }
  });

  ipcMain.handle(McpIpcChannel.ConnectQichacha, async (event) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const apiKey = await startQichachaMcpApiKeyLogin(ownerWindow);
      const mcpRuntime = getMcpRuntime();
      const store = mcpRuntime.getStore();
      const existingServers = store.listServers();

      for (const qichachaServer of QICHACHA_MCP_SERVERS) {
        const data = buildQichachaServerData(qichachaServer, apiKey);
        const existing = existingServers.find(server =>
          server.registryId === QICHACHA_REGISTRY_ID
          && server.name === qichachaServer.name,
        );
        if (existing) {
          store.updateServer(existing.id, data);
        } else {
          store.createServer(data);
        }
      }

      const servers = store.listServers();
      syncMcpConfig(syncOpenClawConfig, 'qichacha-mcp-connected');
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to connect Qichacha MCP',
      };
    }
  });

  ipcMain.handle(McpIpcChannel.StartAuth, async (_event, options: { id: string }) => {
    try {
      const mcpRuntime = getMcpRuntime();
      const record = mcpRuntime.getStore().getServer(options.id);
      if (!record) return { success: false, error: 'server not found' };
      // The dispatcher itself returns void — the renderer opens its modal on
      // its own when it receives the mcp:startAuth push from setEnabled
      // (Task 5). For explicit re-authorize, we hand the authMethod back so
      // the renderer can render the right modal.
      return { success: true, authMethod: record.authMethod };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'start auth failed' };
    }
  });
  ipcMain.handle(McpIpcChannel.SaveCredential, async (event, options: { id: string; payload: SaveCredentialPayload }) => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const mcpRuntime = getMcpRuntime();
      const store = mcpRuntime.getStore();
      const res = await saveCredential(ownerWindow, options.id, options.payload, { store });
      const servers = store.listServers();
      if (res.ok === true) {
        syncMcpConfig(syncOpenClawConfig, 'mcp-auth-saved');
        return { success: true, servers, result: res.result };
      }
      return { success: false, error: res.reason };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'save credential failed' };
    }
  });

  ipcMain.handle(McpIpcChannel.ProbeAuthorization, async (_event, options: { id: string }) => {
    try {
      const mcpRuntime = getMcpRuntime();
      const store = mcpRuntime.getStore();
      const result = await probeOnly(options.id, { store });
      const servers = store.listServers();
      syncMcpConfig(syncOpenClawConfig, 'mcp-auth-probed');
      return { success: true, result, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'probe failed' };
    }
  });

  ipcMain.handle(McpIpcChannel.FetchEnterpriseMarketplace, async () => {
    try {
      loginGate.requireEnterprise();
      const data = await enterpriseClient.listEnterpriseMcps();
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch enterprise marketplace',
      };
    }
  });

  // A member's connector submission to the org review queue. The server
  // enforces the org's `members_can_submit_connectors` toggle (403
  // `submission_disabled`) and re-runs the create guards. The cfg may carry
  // an auth secret — keep it out of the logs; the error message only.
  ipcMain.handle(McpIpcChannel.SubmitConnectorRequest, async (_event, cfg: ConnectorSubmitRequest) => {
    try {
      loginGate.requireEnterprise();
      const data = await enterpriseClient.submitConnectorRequest(cfg);
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to submit connector request',
      };
    }
  });
}
