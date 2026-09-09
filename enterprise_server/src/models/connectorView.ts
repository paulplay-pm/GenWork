import { maskConnectorSecrets } from '../vault/connectorSecret';

export const AUTH_MODES = [
  'none',
  'shared-key',
  'user-key',
  'user-oauth',
  'client-creds',
  'sso',
] as const;
export type AuthMode6 = (typeof AUTH_MODES)[number];
export const TRANSPORTS = ['http', 'sse'] as const;
export type Transport2 = (typeof TRANSPORTS)[number];
export const CONNECTOR_TYPES = ['mcp', 'app'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export interface ConnectorScope {
  allCompany: boolean;
  deptIds: string[];
  userIds: string[];
}
export interface ToolEntry {
  name: string;
  desc?: string;
  enabled: boolean;
  syncedAt?: string;
  removed?: boolean;
}
export interface ConnectorDraft {
  [k: string]: unknown;
}

/** DB row shape (pg driver: timestamptz -> Date, jsonb -> parsed values). */
export interface ConnectorRow {
  id: string;
  org_id: string;
  server_key: string;
  name_en: string | null;
  name_zh: string | null;
  version: string;
  category_id: string | null;
  description: string | null;
  connector_type: ConnectorType;
  url: string;
  transport: Transport2;
  auth_mode: AuthMode6;
  auth_config: Record<string, unknown>;
  secret_meta: { lastUpdatedAt?: string; lastUpdatedBy?: string } | null;
  auth_status: 'configured' | 'pending';
  enabled: boolean;
  scope: ConnectorScope;
  tools: ToolEntry[];
  draft: ConnectorDraft | null;
  last_test_at: Date | null;
  last_test_status: string | null;
  last_latency_ms: number | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Admin list/detail wire. Secrets are masked (see mapAdminConnector). */
export interface ConnectorView {
  id: string;
  serverKey: string;
  nameEn: string | null;
  nameZh: string | null;
  version: string;
  categoryId: string | null;
  description: string | null;
  connectorType: ConnectorType;
  url: string;
  transport: Transport2;
  authMode: AuthMode6;
  /** Per-mode, non-secret fields + masked secret(s). Shape keyed by authMode. */
  authConfig: Record<string, unknown>;
  secretMeta: { lastUpdatedAt?: string; lastUpdatedBy?: string } | null;
  authStatus: 'configured' | 'pending';
  enabled: boolean;
  scope: ConnectorScope;
  scopeSummary: string;
  tools: ToolEntry[];
  toolCount: number;
  hasDraft: boolean;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastLatencyMs: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A connector's version-history row (admin wire, `mcp_connector_versions`
 * mapped to camelCase). `config` is intentionally NOT exposed here — rollback
 * restores it server-side; the list only needs metadata. */
export interface VersionRow {
  id: string;
  version: string;
  note: string | null;
  current: boolean;
  createdAt: string;
  createdBy: string | null;
}

/** Public (desktop) wire — scope-filtered, no secret material. */
export interface ConnectorPublicView {
  id: string;
  serverKey: string;
  name: string;
  nameZh: string | null;
  description: string;
  category: string;
  version: string;
  connectorType: ConnectorType;
  url: string;
  transport: Transport2;
  authMode: AuthMode6;
  authStatus: 'configured' | 'pending';
  scopeSummary: string;
  hasDraft: boolean;
  enabled: boolean;
  toolCount: number;
  /** Present only for direct-link modes (`user-oauth` / `sso`) with complete
   * endpoints. Non-secret only — never carries any `*ClientSecret` or `__enc__*`
   * ciphertext. `sso` reads its endpoints from the `sso*` fields. */
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes?: string[];
  };
  /** Present only for `user-key`: the header name the connector's API key is
   * injected under (non-secret). Absent when the admin left it unset (the
   * desktop then defaults to `X-Api-Key`). */
  apiKeyHeaderName?: string;
}

/** Single source of the SELECT column list for admin + public queries.
 * Keep in sync with the 035 schema. */
export const COLUMNS = `id, org_id, server_key, name_en, name_zh, version, category_id, description,
  connector_type, url, transport, auth_mode, auth_config, secret_meta, auth_status,
  enabled, scope, tools, draft, last_test_at, last_test_status, last_latency_ms,
  created_by, created_at, updated_at`;

/** A connector's scope grants a caller access iff allCompany, or the caller
 * is a member exception (userIds), or any granted dept id is present in the
 * caller's dept set. Pure — no DB: subtree expansion (grant 销售部 ->
 * 华东/华南 visible) happens at query time in the public route, so
 * `callerDeptIds` is the already-expanded set (scopeApi.deptIdsFor). */
export function scopeMatches(
  scope: ConnectorScope,
  callerDeptIds: string[],
  callerId: string,
): boolean {
  if (scope.allCompany) return true;
  if (scope.userIds.includes(callerId)) return true;
  return (scope.deptIds ?? []).some(d => callerDeptIds.includes(d));
}

/** Compact display string for a scope. */
export function scopeSummary(scope: ConnectorScope): string {
  if (scope.allCompany) return 'all';
  const d = scope.deptIds?.length ?? 0;
  const u = scope.userIds?.length ?? 0;
  if (d === 0 && u === 0) return 'none';
  return `depts:${d}` + (u ? `,users:${u}` : '');
}

/** Row -> admin wire. `authConfig` is masked: stored `__enc__*` secrets become
 * a `••••xxxx` form and the ciphertext keys are stripped; non-secret fields
 * pass through. Never returns plaintext. */
export function mapAdminConnector(row: ConnectorRow): ConnectorView {
  return {
    id: row.id,
    serverKey: row.server_key,
    nameEn: row.name_en,
    nameZh: row.name_zh,
    version: row.version,
    categoryId: row.category_id,
    description: row.description,
    connectorType: row.connector_type,
    url: row.url,
    transport: row.transport,
    authMode: row.auth_mode,
    authConfig: maskConnectorSecrets(row.auth_config),
    secretMeta: row.secret_meta,
    authStatus: row.auth_status,
    enabled: row.enabled,
    scope: row.scope,
    scopeSummary: scopeSummary(row.scope),
    tools: row.tools,
    toolCount: row.tools.filter(t => !t.removed).length,
    hasDraft: !!row.draft,
    lastTestAt: row.last_test_at ? row.last_test_at.toISOString() : null,
    lastTestStatus: row.last_test_status,
    lastLatencyMs: row.last_latency_ms,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Pick the non-secret OAuth endpoints from a stored auth_config for the given
 * mode. `user-oauth` reads `authorizeUrl`/`tokenUrl`/`clientId`/`scopes`;
 * `sso` reads the `sso*`-prefixed equivalents. Whitelist-only; ignores any
 * `*ClientSecret` and every `__enc__*` key. Returns undefined when either
 * endpoint is missing (desktop then shows the not-configured guardrail, never
 * falls back to a default provider). */
function pickPublicOauth(
  authConfig: Record<string, unknown>,
  mode: 'user-oauth' | 'sso',
): ConnectorPublicView['oauth'] | undefined {
  // `sso` stores its endpoints under `sso*`-prefixed names with a capital
  // first letter (`ssoAuthorizeUrl`, …); `user-oauth` uses the bare names.
  const names =
    mode === 'sso'
      ? { authorizeUrl: 'ssoAuthorizeUrl', tokenUrl: 'ssoTokenUrl', clientId: 'ssoClientId', scopes: 'ssoScopes' }
      : { authorizeUrl: 'authorizeUrl', tokenUrl: 'tokenUrl', clientId: 'clientId', scopes: 'scopes' };
  const authorizeUrl = typeof authConfig[names.authorizeUrl] === 'string' ? (authConfig[names.authorizeUrl] as string).trim() : '';
  const tokenUrl = typeof authConfig[names.tokenUrl] === 'string' ? (authConfig[names.tokenUrl] as string).trim() : '';
  if (!authorizeUrl || !tokenUrl) return undefined;
  const clientId = typeof authConfig[names.clientId] === 'string' ? (authConfig[names.clientId] as string).trim() : '';
  const scopes = Array.isArray(authConfig[names.scopes])
    ? (authConfig[names.scopes] as unknown[]).filter((s): s is string => typeof s === 'string')
    : undefined;
  const out: ConnectorPublicView['oauth'] = { authorizeUrl, tokenUrl, clientId };
  if (scopes && scopes.length > 0) out.scopes = scopes;
  return out;
}

/** Row -> public (desktop) wire. Only public fields: no `authConfig`, no
 * `secretMeta`, no secret material. `name` prefers zh, then en, then key.
 * Scope filtering is the public route's job (query time); this mapper only
 * shapes the row. */
export function mapPublicConnector(row: ConnectorRow): ConnectorPublicView {
  return {
    id: row.id,
    serverKey: row.server_key,
    name: row.name_zh ?? row.name_en ?? row.server_key,
    nameZh: row.name_zh,
    description: row.description ?? '',
    category: row.category_id ?? '',
    version: row.version,
    connectorType: row.connector_type,
    url: row.url,
    transport: row.transport,
    authMode: row.auth_mode,
    authStatus: row.auth_status,
    scopeSummary: scopeSummary(row.scope),
    hasDraft: !!row.draft,
    enabled: row.enabled,
    toolCount: row.tools.filter(t => !t.removed).length,
    oauth:
      row.auth_mode === 'user-oauth'
        ? pickPublicOauth(row.auth_config, 'user-oauth')
        : row.auth_mode === 'sso'
          ? pickPublicOauth(row.auth_config, 'sso')
          : undefined,
    apiKeyHeaderName:
      row.auth_mode === 'user-key'
        ? (typeof row.auth_config.apiKeyHeaderName === 'string' && row.auth_config.apiKeyHeaderName.trim()
            ? (row.auth_config.apiKeyHeaderName as string).trim()
            : undefined)
        : undefined,
  };
}
