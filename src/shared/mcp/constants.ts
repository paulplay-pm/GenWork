export const McpIpcChannel = {
  List: 'mcp:list',
  Create: 'mcp:create',
  Update: 'mcp:update',
  Delete: 'mcp:delete',
  DeleteByRegistryId: 'mcp:deleteByRegistryId',
  SetEnabled: 'mcp:setEnabled',
  SetEnabledByRegistryId: 'mcp:setEnabledByRegistryId',
  RetryLaunchResolution: 'mcp:retryLaunchResolution',
  ConnectQichacha: 'mcp:qichachaConnect',
  Changed: 'mcp:changed',
  FetchEnterpriseMarketplace: 'mcp:fetchEnterpriseMarketplace',
  SubmitConnectorRequest: 'mcp:submitConnectorRequest',
  StartAuth: 'mcp:startAuth',
  SaveCredential: 'mcp:saveCredential',
  ProbeAuthorization: 'mcp:probeAuthorization',
  AuthFlowRequested: 'mcp:authFlowRequested',
} as const;
export type McpIpcChannel = typeof McpIpcChannel[keyof typeof McpIpcChannel];

/**
 * The connector config a member submits to the org review queue
 * (enterprise_server `connectorCfgSchema` — the connector body WITHOUT
 * `orgId`; the org comes from the caller's token). Mirrors the zod schema in
 * `enterprise_server/src/routes/mcpConnectors.ts`. The server re-runs the
 * create guards on submit (sse+oauth → 400, per-mode required secret → 400
 * `missing_auth_field`, serverKey `^[a-z0-9-]+$`).
 */
export interface ConnectorSubmitRequest {
  serverKey: string;
  url: string;
  nameEn?: string;
  nameZh?: string;
  version?: string;
  categoryId?: string | null;
  description?: string;
  transport?: 'http' | 'sse';
  authMode?: 'none' | 'shared-key' | 'user-key' | 'user-oauth' | 'client-creds' | 'sso';
  authConfig?: Record<string, unknown>;
  scope?: { allCompany?: boolean; deptIds?: string[]; userIds?: string[] };
}

export const McpAuthMethod = {
  None: 'none',
  Bearer: 'bearer',
  ApiKey: 'api-key',
  OAuth: 'oauth',
} as const;
export type McpAuthMethod = typeof McpAuthMethod[keyof typeof McpAuthMethod];

export const McpAuthStatus = {
  Authenticated: 'authenticated',
  NeedsAuth: 'needs-auth',
  AuthError: 'auth-error',
} as const;
export type McpAuthStatus = typeof McpAuthStatus[keyof typeof McpAuthStatus];
