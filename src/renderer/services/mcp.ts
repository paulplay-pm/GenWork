import { type ConnectorSubmitRequest } from '../../shared/mcp/constants';
import {
  McpEnterpriseMarketCategory,
  McpEnterpriseMarketServer,
  McpServerConfig,
  McpServerFormData,
} from '../types/mcp';

const ENTERPRISE_MARKETPLACE_CACHE_KEY = 'mcpEnterpriseMarketCache.v1';

interface EnterpriseMarketplaceCachePayload {
  servers: McpEnterpriseMarketServer[];
  categories: McpEnterpriseMarketCategory[];
}

function readEnterpriseMarketplaceCache(): EnterpriseMarketplaceCachePayload | null {
  try {
    const raw = window.localStorage.getItem(ENTERPRISE_MARKETPLACE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EnterpriseMarketplaceCachePayload;
    if (!Array.isArray(parsed?.servers) || !Array.isArray(parsed?.categories)) return null;
    return parsed;
  } catch {
    // localStorage unavailable or the cache is corrupt; fetch will repopulate.
    return null;
  }
}

function writeEnterpriseMarketplaceCache(payload: EnterpriseMarketplaceCachePayload): void {
  try {
    window.localStorage.setItem(ENTERPRISE_MARKETPLACE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Cache is an optimization only; failing to persist must not break fetch.
  }
}

class McpService {
  private servers: McpServerConfig[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadServers();
    this.initialized = true;
  }

  async loadServers(): Promise<McpServerConfig[]> {
    try {
      const result = await window.electron.mcp.list();
      if (result.success && result.servers) {
        this.servers = result.servers;
      } else {
        this.servers = [];
      }
      return this.servers;
    } catch (error) {
      console.error('Failed to load MCP servers:', error);
      this.servers = [];
      return this.servers;
    }
  }

  async createServer(data: McpServerFormData): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.create(data);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create MCP server';
      console.error('Failed to create MCP server:', error);
      return { success: false, error: message };
    }
  }

  async updateServer(id: string, data: Partial<McpServerFormData>): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.update(id, data);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update MCP server';
      console.error('Failed to update MCP server:', error);
      return { success: false, error: message };
    }
  }

  async deleteServer(id: string): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.delete(id);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete MCP server';
      console.error('Failed to delete MCP server:', error);
      return { success: false, error: message };
    }
  }

  async deleteByRegistryId(registryId: string): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.deleteByRegistryId(registryId);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete MCP registry servers';
      console.error('Failed to delete MCP registry servers:', error);
      return { success: false, error: message };
    }
  }

  async setServerEnabled(id: string, enabled: boolean): Promise<McpServerConfig[]> {
    try {
      const previousServer = this.servers.find(server => server.id === id);
      const result = await window.electron.mcp.setEnabled({ id, enabled });
      if (result.success && result.servers) {
        this.servers = result.servers;
        const updatedServer = this.servers.find(server => server.id === id) ?? previousServer;
        if (enabled && previousServer?.enabled !== true && updatedServer) {
          // Telemetry removed.
        }
        return this.servers;
      }
      throw new Error(result.error || 'Failed to update MCP server');
    } catch (error) {
      console.error('Failed to update MCP server:', error);
      throw error;
    }
  }

  async setRegistryEnabled(registryId: string, enabled: boolean): Promise<McpServerConfig[]> {
    try {
      const result = await window.electron.mcp.setEnabledByRegistryId({ registryId, enabled });
      if (result.success && result.servers) {
        this.servers = result.servers;
        return this.servers;
      }
      throw new Error(result.error || 'Failed to update MCP registry servers');
    } catch (error) {
      console.error('Failed to update MCP registry servers:', error);
      throw error;
    }
  }

  async retryLaunchResolution(id: string): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.retryLaunchResolution(id);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to retry MCP launch resolution';
      console.error('Failed to retry MCP launch resolution:', error);
      return { success: false, error: message };
    }
  }

  async connectQichacha(): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.connectQichacha();
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect Qichacha MCP';
      console.error('Failed to connect Qichacha MCP:', error);
      return { success: false, error: message };
    }
  }

  /**
   * Probe-only roundtrip; returns the auth status without saving a credential.
   * Used by the re-authorize / retry buttons in Task 6.
   */
  async startAuth(id: string): Promise<{ ok: boolean; authMethod?: string; error?: string }> {
    try {
      const r = await window.electron.mcp.startAuth({ id });
      return {
        ok: !!r.success,
        authMethod: (r as { authMethod?: string }).authMethod,
        error: r.success ? undefined : (r as { error?: string }).error,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'unknown' };
    }
  }

  /**
   * Persist a credential (bearer / apiKey / env / oauth) for the given
   * server and run the probe. The full result shape is `ProbeResult` from
   * the main process; we keep it loosely typed here because the renderer
   * does not need to discriminate the probe status variants.
   */
  async saveCredential(
    id: string,
    payload: unknown,
  ): Promise<{ ok: boolean; servers?: McpServerConfig[]; result?: unknown; error?: string }> {
    try {
      const r = await window.electron.mcp.saveCredential({ id, payload });
      return {
        ok: !!r.success,
        servers: (r as { servers?: McpServerConfig[] }).servers,
        result: (r as { result?: unknown }).result,
        error: r.success ? undefined : (r as { error?: string }).error,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'unknown' };
    }
  }

  /**
   * Probe without saving. Returns the latest `ProbeResult` plus the refreshed
   * server list (so the caller can update auth status in the UI).
   */
  async probeAuthorization(
    id: string,
  ): Promise<{ ok: boolean; result?: unknown; servers?: McpServerConfig[]; error?: string }> {
    try {
      const r = await window.electron.mcp.probeAuthorization({ id });
      return {
        ok: !!r.success,
        result: (r as { result?: unknown }).result,
        servers: (r as { servers?: McpServerConfig[] }).servers,
        error: r.success ? undefined : (r as { error?: string }).error,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'unknown' };
    }
  }

  onChanged(callback: () => void): () => void {
    return window.electron.mcp.onChanged(callback);
  }

  getServers(): McpServerConfig[] {
    return this.servers;
  }

  getEnabledServers(): McpServerConfig[] {
    return this.servers.filter(s => s.enabled);
  }

  getServerById(id: string): McpServerConfig | undefined {
    return this.servers.find(s => s.id === id);
  }

  /**
   * Enterprise marketplace catalog from the enterprise server. The payload is
   * already in its final shape, so no conversion is needed; the last
   * successful response is cached in localStorage for the first frame.
   */
  async fetchEnterpriseMarketplace(): Promise<{
    servers: McpEnterpriseMarketServer[];
    categories: McpEnterpriseMarketCategory[];
  } | null> {
    try {
      const result = await window.electron.mcp.fetchEnterpriseMarketplace();
      if (result.success && result.data) {
        writeEnterpriseMarketplaceCache(result.data);
        return { servers: result.data.servers, categories: result.data.categories };
      }
      return null;
    } catch (error) {
      console.error('Failed to fetch enterprise MCP marketplace:', error);
      return null;
    }
  }

  /** Cached copy of the last enterprise fetch; null on first run. */
  getCachedEnterpriseMarketplace(): {
    servers: McpEnterpriseMarketServer[];
    categories: McpEnterpriseMarketCategory[];
  } | null {
    return readEnterpriseMarketplaceCache();
  }

  /**
   * Submit a connector config to the enterprise review queue (member
   * self-service). A write — no cache. Resolves with the new submission id;
   * rejects with the server's error message (e.g. `http 403` when the org has
   * member submissions disabled, or a 400 guard violation like
   * `missing_auth_field` / `sse_oauth_not_supported`).
   */
  async submitConnectorRequest(cfg: ConnectorSubmitRequest): Promise<string> {
    const result = await window.electron.mcp.submitConnectorRequest(cfg);
    if (result.success && result.data) {
      return result.data.id;
    }
    throw new Error(result.error || 'submit connector request failed');
  }
}

export const mcpService = new McpService();
