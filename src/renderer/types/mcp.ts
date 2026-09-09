// MCP Server type definitions
import type { McpAuthMethod, McpAuthStatus } from '../../shared/mcp/constants';

export type { McpAuthMethod, McpAuthStatus };

export type McpTransportType = 'stdio' | 'sse' | 'http';

export const McpRegistryEntryKind = {
  Server: 'server',
  Bundle: 'bundle',
} as const;
export type McpRegistryEntryKind = typeof McpRegistryEntryKind[keyof typeof McpRegistryEntryKind];

/** Non-secret per-connector OAuth endpoint config for `user-oauth`
 * enterprise connectors. Mirrors the server public view's `oauth` shape
 * (connectorView.ts) and the desktop store's McpOAuthEndpoint — keep in
 * sync. No `clientSecret`: the store never holds org secrets. */
export interface McpOAuthEndpoint {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
}

export interface McpServerConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transportType: McpTransportType;
  command?: string;              // stdio
  args?: string[];               // stdio
  env?: Record<string, string>;  // stdio
  url?: string;                  // sse / http
  headers?: Record<string, string>; // sse / http
  isBuiltIn: boolean;            // installed from built-in registry
  githubUrl?: string;            // GitHub repository URL
  registryId?: string;           // matching registry entry ID
  launchResolution?: McpLaunchResolution;
  authMethod: McpAuthMethod;
  authStatus: McpAuthStatus;
  serverKey?: string;
  oauthConfig?: McpOAuthEndpoint;
  /** user-key: header name the connector's API key is injected under (absent → desktop defaults to X-Api-Key). */
  apiKeyHeaderName?: string;
  createdAt: number;
  updatedAt: number;
}

export interface McpLaunchResolution {
  serverId: string;
  resolverKind: 'npx' | 'uvx' | 'python' | 'raw';
  sourceFingerprint: string;
  status: 'pending' | 'installing' | 'ready' | 'failed' | 'unsupported';
  packageName?: string;
  requestedVersion?: string;
  resolvedVersion?: string;
  installDir?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  error?: string;
  installedAt?: number;
  resolvedAt?: number;
  lastProbeAt?: number;
  lastProbeStatus?: string;
  updatedAt: number;
}

export interface McpServerFormData {
  name: string;
  description: string;
  transportType: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isBuiltIn?: boolean;
  githubUrl?: string;
  registryId?: string;
  authMethod?: McpAuthMethod;
  serverKey?: string;
  oauthConfig?: McpOAuthEndpoint;
  apiKeyHeaderName?: string;
}

// Built-in MCP registry entry (pure frontend definition)
export interface McpRegistryEntry {
  id: string;                    // unique identifier, e.g. 'filesystem'
  name: string;                  // display name, English; also the zh fallback
  name_zh?: string;              // Chinese display name (remote data)
  icon?: string;                 // icon URL (remote data); falls back to the default glyph
  descriptionKey: string;        // i18n translation key for description
  description_zh?: string;       // Chinese description (remote data)
  description_en?: string;       // English description (remote data)
  category: McpCategory;         // category tag
  categoryKey: string;           // i18n translation key for category
  transportType: McpTransportType;
  command: string;               // default command, e.g. 'npx'
  defaultArgs: string[];         // default arguments
  requiredEnvKeys?: string[];    // env vars the user must fill
  optionalEnvKeys?: string[];    // optional env vars
  argPlaceholders?: string[];    // placeholder hints for args (e.g. path)
  oauthProvider?: 'qichacha';    // special app-managed OAuth/API key flow
  kind?: McpRegistryEntryKind;   // defaults to a single-server registry entry
  marketplacePosition?: number;  // 1-based preferred position; clamps to the available list
}

// Remote marketplace server entry
export interface McpMarketplaceServer {
  id: string;
  name: string;
  name_zh?: string;
  icon?: string;
  description_zh?: string;
  description_en?: string;
  category: string;
  transportType: string;
  command: string;
  defaultArgs: string[];
  requiredEnvKeys?: string[];
  optionalEnvKeys?: string[];
  kind?: McpRegistryEntryKind;
}

// Dynamic marketplace category from remote
export interface McpMarketplaceCategoryInfo {
  id: string;
  name_zh: string;
  name_en: string;
}

export type McpCategory =
  | 'search'
  | 'browser'
  | 'developer'
  | 'productivity'
  | 'design'
  | 'data-api';

/**
 * Server-returned shape for an enterprise marketplace MCP (post-018): the
 * public connector view. `category` is the raw `mcp_connector_categories.id`
 * row id (or '' when uncategorized), not a display name — join against the
 * `categories` array to render one. No secrets cross the wire, and the
 * desktop applies no scope filtering of its own (the server returns the list
 * already filtered for the caller).
 */
export interface McpEnterpriseMarketServer {
  id: string;
  serverKey: string;
  name: string;
  nameZh: string | null;
  description: string;
  category: string;
  version: string;
  connectorType: 'mcp' | 'app';
  url: string;
  transport: 'http' | 'sse';
  authMode: 'none' | 'shared-key' | 'user-key' | 'user-oauth' | 'client-creds' | 'sso';
  authStatus: 'configured' | 'pending';
  scopeSummary: string;
  hasDraft: boolean;
  enabled: boolean;
  toolCount: number;
  /** Present only for `user-oauth` with complete endpoints (non-secret). */
  oauth?: McpOAuthEndpoint;
  /** Present only for `user-key` with a header name set (non-secret). */
  apiKeyHeaderName?: string;
}

export interface McpEnterpriseMarketCategory {
  id: string;
  name_zh: string;
  name_en: string;
}
