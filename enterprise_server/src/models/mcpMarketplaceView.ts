import { maskCredential } from '../vault/mask';

export const UNCATEGORIZED = 'uncategorized' as const;

export const TRANSPORT_TYPES = ['stdio', 'sse', 'http'] as const;
export type TransportType = typeof TRANSPORT_TYPES[number];

export const AUTH_METHODS = ['none', 'bearer', 'api-key', 'oauth'] as const;
export type AuthMethod = typeof AUTH_METHODS[number];

/** Single source of the SELECT column list used by the public catalog and
 *  the admin list route. Keep in sync with the 018 schema. */
export const SERVER_COLUMNS = `server_id, name, name_zh, description_en, description_zh, icon,
  category_id, transport_type, command, default_args, required_env_keys,
  optional_env_keys, kind, enabled, server_url, auth_method, credential_cipher,
  api_key_header, timeout_seconds, allowed_roles, last_status, last_latency_ms, last_tested_at`;

/** DB row shape for a marketplace server (post-018). */
export interface ServerRow {
  server_id: string;
  name: string;
  name_zh: string | null;
  description_en: string;
  description_zh: string | null;
  icon: string | null;
  category_id: string;
  transport_type: TransportType;
  command: string | null;
  default_args: unknown;
  required_env_keys: unknown;
  optional_env_keys: unknown;
  kind: 'single' | 'bundle';
  enabled: boolean;
  server_url: string | null;
  auth_method: AuthMethod;
  credential_cipher: string | null;
  api_key_header: string;
  timeout_seconds: number;
  allowed_roles: string[];
  last_status: string | null;
  last_latency_ms: number | null;
  last_tested_at: Date | null;
}

/** Wire shape returned by both the public catalog and the admin list. */
export interface McpServerView {
  id: string;
  name: string;
  name_zh: string | null;
  description: string;
  category: string;
  transportType: TransportType;
  serverUrl: string | null;
  command: string | null;
  authMethod: AuthMethod;
  credentialMasked: string | null;
  timeoutSeconds: number;
  allowedRoles: string[];
  enabled: boolean;
  lastStatus: string | null;
  lastLatencyMs: number | null;
  lastTestedAt: string | null;
}

export interface CategoryRow {
  category_id: string;
  name_zh: string;
  name_en: string;
  display_order: number;
}

export function mapServer(row: ServerRow): McpServerView {
  return {
    id: row.server_id,
    name: row.name,
    name_zh: row.name_zh,
    description: row.description_zh ?? row.description_en,
    category: row.category_id,
    transportType: row.transport_type,
    serverUrl: row.server_url,
    command: row.command,
    authMethod: row.auth_method,
    credentialMasked: maskCredential(row.credential_cipher),
    timeoutSeconds: row.timeout_seconds,
    allowedRoles: row.allowed_roles,
    enabled: row.enabled,
    lastStatus: row.last_status,
    lastLatencyMs: row.last_latency_ms,
    lastTestedAt: row.last_tested_at ? row.last_tested_at.toISOString() : null,
  };
}