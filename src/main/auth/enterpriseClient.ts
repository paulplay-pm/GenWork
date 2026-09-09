import { session } from 'electron';

import { type ConnectorSubmitRequest } from '../../shared/mcp/constants';
import { type SkillSubmitRequest } from '../../shared/skills/constants';
import { SSO_OAUTH_PARTITION } from '../mcp/oauthBrowserFlow';
import { loginGate } from './loginGate';
import { sessionStorage } from './sessionStorage';

const KEY_FIELD_RE = /api_key|secret|access_token|bearer/i;

export interface ModelView {
  id: string;
  provider: string;
  model: string;
  display_name: string | null;
  quota_per_user_per_day: number | null;
  enabled: boolean;
}

export interface CatalogModel {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  quotaPerUserPerDay: number | null;
  enabled: boolean;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsThinking: boolean;
  contextWindow: number | null;
  maxTokens: number | null;
}

export interface CatalogProvider {
  id: string;
  provider: string;
  label: string | null;
  endpoint: string | null;
  region: 'china' | 'global' | null;
  defaultBaseUrl: string | null;
  website: string | null;
  enabled: boolean;
}

export interface CatalogResponse {
  providers: CatalogProvider[];
  models: CatalogModel[];
}

export interface PolicyView {
  id: string;
  scope: string;
  disabled: boolean;
  [k: string]: unknown;
}

let baseUrl = '';
let tokenProvider: () => string | null = () => null;

function sanitize<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (KEY_FIELD_RE.test(k)) continue;
    out[k] = v;
  }
  return out as T;
}

async function call<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  const tok = tokenProvider();
  if (tok) headers.set('authorization', `Bearer ${tok}`);
  headers.set('content-type', 'application/json');
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  } catch (e) {
    if (retry) {
      await new Promise((r) => setTimeout(r, 200));
      return call<T>(path, init, false);
    }
    throw new Error(`network: ${(e as Error).message}`);
  }
  if (res.status === 401) {
    // Distinguish an expired/invalid session (error: 'unauthorized') from a
    // business 401 such as a wrong current password ('invalid_current'), which
    // must NOT lock the gate and kick the user out.
    let body: { error?: string } = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    if (body.error !== 'unauthorized') {
      throw new Error(`http ${res.status}: ${body.error ?? 'unauthorized'}`);
    }
    // 401 → lock the gate so the renderer returns to LoginPage.
    loginGate.lock();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json() as Promise<T>;
}

export interface MeView {
  id: string;
  effective_roles: string[];
  membersCanSubmitSkills?: boolean;
  [k: string]: unknown;
}

export interface EnterpriseModelCapabilities {
  supports_image: boolean;
  supports_video: boolean;
  supports_thinking: boolean;
  context_window: number | null;
  max_tokens: number | null;
}

export interface EnterpriseModelEntry {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  endpoint: string | null;
  capabilities: EnterpriseModelCapabilities;
  quotaPerDay: number | null;
}

export interface EnterpriseKit {
  id: string;
  name: { en: string; zh: string };
  description: { en: string; zh: string };
  icon?: string;
  author?: string;
  version?: string;
  tryAsking?: Array<{ en: string; zh: string }>;
  skills: { bundle: string; list: Array<Record<string, unknown>> };
}

export const enterpriseClient = {
  configure(url: string): void {
    baseUrl = url.replace(/\/$/, '');
  },
  setTokenProvider(fn: () => string | null): void {
    tokenProvider = fn;
  },

  async login(orgName: string, username: string, password: string): Promise<{ token: string }> {
    return call('/auth/login', {
      method: 'POST',
      // The server's /auth/login schema reads the chosen org under `orgName`
      // (and drops unknown keys). The desktop sends the org *name* the user
      // picked — a single-org server falls back when this is empty. Sending it
      // as `orgId` would be silently ignored and break multi-org login.
      body: JSON.stringify({ orgName, username, password }),
    }, false);
  },

  /**
   * List orgs on the configured enterprise server. Used by the desktop
   * login page to know whether to show the org selector. The server's
   * `/auth/orgs` endpoint is public; `call()` only attaches the Bearer
   * token when one is present, so this naturally works pre-login.
   */
  async listOrgs(): Promise<{ orgs: { id: string; name: string }[] }> {
    return call('/auth/orgs', { method: 'GET' }, false);
  },

  /** List enabled SSO connections for an org (pre-login). The server's
   * `/auth/sso/providers` endpoint is public; `call()` only attaches the
   * Bearer token when one is present, so this works pre-login (like listOrgs). */
  async listSsoProviders(orgName: string): Promise<{
    providers: Array<{ id: string; name: string; provider_type: string; sort_order: number; logoUrl: string | null }>;
  }> {
    return call(`/auth/sso/providers?orgName=${encodeURIComponent(orgName)}`, { method: 'GET' }, false);
  },

  async refresh(): Promise<{ token: string }> {
    return call('/auth/refresh', { method: 'POST' }, false);
  },

  async getMe(): Promise<MeView> {
    return call<MeView>('/me');
  },

  async updateMe(displayName: string): Promise<MeView> {
    const me = await call<MeView>('/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    }, false);
    // Keep the cached session's display name in sync with the server so the
    // sidebar avatar reflects the updated name without a re-login.
    const session = sessionStorage.load();
    if (session) {
      session.displayName = displayName;
      sessionStorage.save(session);
    }
    return me;
  },

  /**
   * Submit a connector config to the org's member review queue. Gated server-
   * side by the org's `members_can_submit_connectors` toggle (403
   * `submission_disabled` when off) and by the same validation guards as the
   * admin create route. Uses the org JWT via `call()`.
   *
   * The body is the FULL connector config, including any auth secret the
   * member typed: the `sanitize` helper must NOT strip it here (it only exists
   * to keep list getters from leaking secrets). The server stores the cfg as
   * submitted and encrypts the secret fields when the connector is approved.
   */
  async submitConnectorRequest(cfg: ConnectorSubmitRequest): Promise<{ id: string }> {
    return call('/admin/mcp-connectors/submissions', {
      method: 'POST',
      body: JSON.stringify(cfg),
    });
  },

  /**
   * Submit a member's skill package to the org's review queue (T8 member
   * submission route). Gated server-side by the org's
   * `members_can_submit_skills` toggle (403 `submission_disabled` when off)
   * and by the same zip validation as the admin publish route (400/413 on
   * a bad or oversized zip). Uses the org JWT via `call()`.
   *
   * The server's `submissionSchema` expects the base64 zip under `zip`, so
   * the desktop-internal `zipBase64` field is mapped at this boundary
   * (undefined metadata drops on stringify).
   */
  async submitSkillRequest(req: SkillSubmitRequest): Promise<{ id: string }> {
    return call('/api/admin/skill-marketplace/submissions', {
      method: 'POST',
      body: JSON.stringify({
        desc: req.desc,
        nameZh: req.nameZh,
        icon: req.icon,
        scope: req.scope,
        zip: req.zipBase64,
      }),
    });
  },

  async changePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await call('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      }, false);
      return { ok: true };
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes('invalid_current')) {
        return { ok: false, error: 'invalid_current' };
      }
      if (message.includes('http 422')) {
        return { ok: false, error: 'invalid_input' };
      }
      return { ok: false, error: message || 'failed' };
    }
  },

  async getModels(): Promise<ModelView[]> {
    const list = await call<ModelView[]>('/models');
    return list.map((m) => sanitize(m as unknown as Record<string, unknown>) as unknown as ModelView);
  },

  async getCatalog(): Promise<CatalogResponse> {
    const body = await call<CatalogResponse>('/admin/catalog');
    return {
      providers: body.providers.map((p) =>
        sanitize(p as unknown as Record<string, unknown>) as unknown as CatalogProvider
      ),
      models: body.models.map((m) =>
        sanitize(m as unknown as Record<string, unknown>) as unknown as CatalogModel
      ),
    };
  },

  async getPolicies(type: 'mcp' | 'skill'): Promise<PolicyView[]> {
    const list = await call<PolicyView[]>(`/policies/${type}`);
    return list.map((p) => sanitize(p as unknown as Record<string, unknown>) as unknown as PolicyView);
  },

  async postAudit(
    events: { action: string; targetType?: string; targetId?: string; payload?: unknown }[]
  ): Promise<void> {
    await call('/audit', { method: 'POST', body: JSON.stringify({ events }) });
  },

  async getUsageToday(): Promise<{ window_date: string; items: { model_id: string; used: number }[] }> {
    return call('/usage/today');
  },

  async archiveUpload(
    targetUserId: string,
    blob: ArrayBuffer
  ): Promise<{ archiveId: string; size: number }> {
    return call(`/admin/users/${targetUserId}/archive`, {
      method: 'POST',
      body: blob,
      headers: { 'content-type': 'application/zip' },
    });
  },

  async getToken(): Promise<string | null> {
    return tokenProvider();
  },

  get orgId(): string | null {
    return sessionStorage.load()?.orgId ?? null;
  },

  /**
   * Fetch the per-org enterprise model catalog. The server returns each entry
   * with a `_k` field containing the decrypted provider key. That key is kept
   * only in main-process memory by the cache layer; it MUST NEVER be forwarded
   * to the renderer. This method uses a direct fetch (not `call()`) so the
   * `api_key`/`secret` sanitiser does NOT strip the `_k` field on the way in.
   */
  async listEnterpriseModels(): Promise<{
    models: Array<EnterpriseModelEntry & { apiKey: string | null }>;
  }> {
    const url = `${baseUrl}/enterprise-models`;
    const token = tokenProvider();
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`enterprise-models fetch failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { models: Array<Record<string, unknown>> };
    return {
      models: body.models.map((m) => ({
        id: String(m.id),
        provider: String(m.provider),
        model: String(m.model),
        displayName: (m.displayName as string | null) ?? null,
        endpoint: (m.endpoint as string | null) ?? null,
        capabilities: m.capabilities as EnterpriseModelCapabilities,
        quotaPerDay: (m.quotaPerDay as number | null) ?? null,
        apiKey: (m._k as string | null) ?? null,
      })),
    };
  },

  /**
   * List the enterprise_server MCP catalog scoped to the caller's role.
   * Uses the org JWT (Stack A) so the server's role/scope filter is enforced.
   * The payload is the public connector view — no secrets cross the wire.
   */
  async listEnterpriseMcps(): Promise<{
    categories: Array<{ id: string; name_zh: string; name_en: string }>;
    servers: Array<{
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
      oauth?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] };
      /** Present only for `user-key` with a header name set (non-secret). */
      apiKeyHeaderName?: string;
    }>;
  }> {
    const url = `${baseUrl}/api/mcp-marketplace`;
    const token = tokenProvider();
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`enterprise-mcp-marketplace fetch failed: HTTP ${res.status}`);
    }
    return res.json() as Promise<{
      categories: Array<{ id: string; name_zh: string; name_en: string }>;
      servers: Array<{
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
        oauth?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] };
        /** Present only for `user-key` with a header name set (non-secret). */
        apiKeyHeaderName?: string;
      }>;
    }>;
  },

  /**
   * List the enterprise skill catalog scoped to the caller's role.
   * Uses the org JWT so the server's role filter on the skill catalog is
   * enforced. Mirrors `listEnterpriseMcps`: direct fetch, explicit inline
   * return type (the method lives inside the object literal, so `this` is
   * not the client type).
   */
  async listEnterpriseSkills(): Promise<{
    categories: Array<{ id: string; name_zh: string; name_en: string }>;
    skills: Array<{
      id: string;
      name: string;
      name_zh: string | null;
      description: string;
      category: string;
      version: string | null;
      icon: string | null;
      source: { from?: string; url?: string; author?: string } | null;
      zipSize: number | null;
      sha256: string | null;
      updatedAt: string;
    }>;
  }> {
    const url = `${baseUrl}/api/skill-marketplace`;
    const token = tokenProvider();
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`enterprise-skill-marketplace fetch failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      categories: Array<{ id: string; name_zh: string; name_en: string }>;
      skills: Array<{
        id: string; name: string; name_zh: string | null; description: string;
        category: string; version: string | null; icon: string | null;
        source: { from?: string; url?: string; author?: string } | null;
        zipSize: number | null; sha256: string | null; updatedAt: string;
      }>;
    };
    return body;
  },

  /**
   * List the enterprise_server agent catalog scoped to the caller's role.
   * Mirrors `listEnterpriseSkills` / `listEnterpriseMcps`: direct fetch, explicit
   * inline return type (the method lives inside an object literal, so `this`
   * isn't the client type).
   */
  async listEnterpriseAgents(): Promise<Array<{
    agentId: string;
    name: string;
    description: string;
    identity: string;
    systemPrompt: string;
    aboutYou: string;
    model: string;
    thinkingLevel: string;
    icon: string;
    skillIds: string[];
    subagentAllowAgentIds: string[];
    allowedRoles: string[];
    enabled: boolean;
    imChannels: string[];
  }>> {
    const url = `${baseUrl}/api/agent-marketplace`;
    const token = tokenProvider();
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`enterprise-agent-marketplace fetch failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    return body.agents.map((a) => ({
      agentId: String(a.agentId),
      name: String(a.name),
      description: String(a.description ?? ''),
      identity: String(a.identity ?? ''),
      systemPrompt: String(a.systemPrompt ?? ''),
      aboutYou: String(a.aboutYou ?? ''),
      model: String(a.model ?? ''),
      thinkingLevel: String(a.thinkingLevel ?? ''),
      icon: String(a.icon ?? ''),
      skillIds: Array.isArray(a.skillIds) ? (a.skillIds as string[]) : [],
      subagentAllowAgentIds: Array.isArray(a.subagentAllowAgentIds) ? (a.subagentAllowAgentIds as string[]) : [],
      allowedRoles: Array.isArray(a.allowedRoles) ? (a.allowedRoles as string[]) : [],
      enabled: Boolean(a.enabled),
      // Wire field is camelCase `imChannels` (server `AgentMarketplaceView`),
      // matching the sibling mappings above.
      imChannels: Array.isArray(a.imChannels) ? (a.imChannels as string[]) : [],
    }));
  },

  /**
   * List the enterprise kit catalog scoped to the caller's role/scope.
   * Mirrors `listEnterpriseMcps`: direct fetch with the org JWT. The server
   * returns a relative `skills.bundle` path (`/api/kits/download/<slug>`); the
   * desktop main process absolutizes + installs it authed (kits:install).
   */
  async listEnterpriseKits(): Promise<{ kits: EnterpriseKit[] }> {
    const url = `${baseUrl}/api/kits`;
    const token = tokenProvider();
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      throw new Error(`network: ${(e as Error).message}`);
    }
    if (res.status === 401) {
      loginGate.lock();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      throw new Error(`enterprise-kit-marketplace fetch failed: HTTP ${res.status}`);
    }
    return res.json() as Promise<{ kits: EnterpriseKit[] }>;
  },

  /**
   * Download an enterprise kit's zip with the org JWT (binary). `path` is the
   * relative server path, e.g. `/api/kits/download/engineering`. Returns the raw
   * bytes so kits:install can write them to a temp file.
   */
  async downloadEnterpriseKit(path: string): Promise<Buffer> {
    const url = `${baseUrl}${path}`;
    const token = tokenProvider();
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      throw new Error(`network: ${(e as Error).message}`);
    }
    if (res.status === 401) {
      loginGate.lock();
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error(`http ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },

  // Persist helper used by main after successful login.
  persistSession(orgId: string, username: string, jwt: string, expiresAt: number): void {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as {
      sub: string;
      orgId: string;
      roles: string[];
    };
    const session = {
      userId: payload.sub,
      orgId,
      username,
      displayName: username,
      roles: payload.roles ?? [],
      jwt,
      expiresAt,
    };
    sessionStorage.save(session);
    loginGate.unlock(session);
  },

  async logout(): Promise<void> {
    sessionStorage.clear();
    loginGate.lock();
    // Decision 4: clear the SSO BrowserWindow partition so the next
    // login attempt starts from a clean TLS / cookie state. Best-effort:
    // a closed session or a slow filesystem must not block logout.
    try {
      await session.fromPartition(SSO_OAUTH_PARTITION).clearStorageData({
        storages: ['cookies', 'indexdb', 'localstorage', 'serviceworkers', 'cachestorage'],
      });
    } catch (error) {
      console.warn('[enterpriseClient] failed to clear SSO partition on logout:', error);
    }
  },
};