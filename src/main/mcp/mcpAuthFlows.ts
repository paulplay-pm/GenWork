import type { BrowserWindow } from 'electron';

import { McpAuthMethod } from '../../shared/mcp/constants';
import { runGenericOauthFlow, type GenericOauthConfig } from './genericOauthFlow';
import { probeAuthorization, type ProbeResult } from './mcpAuthProbe';
import { McpStore } from './mcpStore';

/**
 * Module-level store singleton. Set once by `McpRuntime` after the DB is
 * available. Tests inject an explicit store via the `options.store`
 * argument; production callers may rely on the default (e.g. when invoked
 * from endpoints that don't carry a runtime reference).
 */
let defaultStore: McpStore | null = null;

export function setDefaultMcpStore(store: McpStore | null): void {
  defaultStore = store;
}

function getDefaultStore(): McpStore {
  if (!defaultStore) {
    throw new Error(
      '[mcpAuthFlows] no default store configured; pass options.store or call setDefaultMcpStore()',
    );
  }
  return defaultStore;
}

/**
 * OAuth providers the dispatcher knows how to drive. v1: just qichacha.
 * The `runFlow` hook performs the entire window dance internally because
 * qichacha uses a custom token-harvest probe rather than a generic
 * token-exchange callback, so it cannot reuse `openOauthFlow` directly.
 */
export interface OAuthProviderEntry {
  id: string;
  label: string;
  /** Build the authorize URL. Most providers ignore the state and use runFlow. */
  buildAuthorizeUrl: (state: string) => Promise<string>;
  /** Wait for the user to complete the OAuth dance and return the credential. */
  runFlow: (win: BrowserWindow | null) => Promise<string>;
}

const OAUTH_REGISTRY: Record<string, OAuthProviderEntry> = {
  qichacha: {
    id: 'qichacha',
    label: '企查查',
    // qichacha uses runFlow directly (custom harvest); the URL builder is unused.
    buildAuthorizeUrl: async () => '',
    runFlow: async (win) => {
      // Loose import to avoid a hard cycle and to keep qichacha's PKCE
      // machinery isolated from the generic dispatcher.
      const { startQichachaMcpApiKeyLogin } = await import('./qichachaMcpAuth');
      return await startQichachaMcpApiKeyLogin(win);
    },
  },
};

/** Save payload from the renderer. Discriminated by `kind`. */
export type SaveCredentialPayload =
  | { kind: 'bearer'; bearer: string }
  | { kind: 'apiKey'; headerName: string; value: string }
  | { kind: 'env'; envKey: string; value: string }
  | { kind: 'oauth'; providerId: string; oauthConfig?: GenericOauthConfig };

export interface SaveCredentialResult {
  ok: true;
  result: ProbeResult;
}
export interface SaveCredentialError {
  ok: false;
  reason: string;
}
export type SaveCredentialResponse = SaveCredentialResult | SaveCredentialError;

export interface SaveCredentialOptions {
  /** Optional store override. Defaults to the module-level singleton. */
  store?: McpStore;
}

/**
 * Dispatches a credential-save by transport / auth-method.
 *
 * Order: write the credential first, then probe. The credential is persisted
 * even if the probe fails so the user can retry without re-entering it.
 */
export async function saveCredential(
  win: BrowserWindow | null,
  id: string,
  payload: SaveCredentialPayload,
  options: SaveCredentialOptions = {},
): Promise<SaveCredentialResponse> {
  const store = options.store ?? getDefaultStore();
  const record = store.getServer(id);
  if (!record) return { ok: false, reason: 'server not found' };

  if (payload.kind === 'oauth') {
    // Per-provider generic flow (spec §5.2 option B): bypass the registry so
    // the built-in qichacha entry is untouched. `generic:<serverKey>` + an
    // oauthConfig means "drive this connector's own endpoints".
    if (payload.providerId.startsWith('generic:') && payload.oauthConfig) {
      let genericToken: string;
      try {
        genericToken = await runGenericOauthFlow(payload.oauthConfig, win);
      } catch (err) {
        console.warn(`[mcpAuthFlows] generic oauth flow failed for ${payload.providerId}: ${errMsg(err)}`);
        return { ok: false, reason: errMsg(err) };
      }
      if (!genericToken) return { ok: false, reason: 'oauth flow returned empty credential' };
      store.updateServer(id, {
        authMethod: McpAuthMethod.OAuth,
        oauth: { providerId: payload.providerId, token: genericToken },
        headers: { ...(record.headers ?? {}), Authorization: `Bearer ${genericToken}` },
      });
      const afterGeneric = store.getServer(id);
      if (!afterGeneric) return { ok: false, reason: 'server disappeared after save' };
      const result = await probeAuthorization(afterGeneric, store);
      console.log(`[mcpAuthFlows] saved generic oauth credential for server ${id}`);
      return { ok: true, result };
    }
    const provider = OAUTH_REGISTRY[payload.providerId];
    if (!provider) {
      return { ok: false, reason: `unknown oauth provider: ${payload.providerId}` };
    }
    let token: string;
    try {
      token = await provider.runFlow(win);
    } catch (err) {
      console.warn(`[mcpAuthFlows] oauth flow failed for provider ${payload.providerId}: ${errMsg(err)}`);
      return { ok: false, reason: errMsg(err) };
    }
    if (!token) {
      return { ok: false, reason: 'oauth flow returned empty credential' };
    }
    // Persist oauth sub-key on config_json + mirror into Authorization header
    // so the existing probe (which checks `headers.Authorization`) sees it.
    store.updateServer(id, {
      authMethod: McpAuthMethod.OAuth,
      oauth: { providerId: payload.providerId, token },
      headers: { ...(record.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    const after = store.getServer(id);
    if (!after) return { ok: false, reason: 'server disappeared after save' };
    const result = await probeAuthorization(after, store);
    console.log(`[mcpAuthFlows] saved credential for server ${id}`);
    return { ok: true, result };
  }

  if (payload.kind === 'bearer') {
    if (record.transportType === 'stdio') {
      // For stdio bearer, stash under env.API_KEY so the child process inherits it.
      store.updateServer(id, {
        authMethod: McpAuthMethod.Bearer,
        env: { ...(record.env ?? {}), API_KEY: payload.bearer },
      });
    } else {
      store.updateServer(id, {
        authMethod: McpAuthMethod.Bearer,
        headers: { ...(record.headers ?? {}), Authorization: `Bearer ${payload.bearer}` },
      });
    }
  } else if (payload.kind === 'apiKey') {
    if (record.transportType === 'stdio') {
      store.updateServer(id, {
        authMethod: McpAuthMethod.ApiKey,
        env: { ...(record.env ?? {}), [payload.headerName]: payload.value },
      });
    } else {
      store.updateServer(id, {
        authMethod: McpAuthMethod.ApiKey,
        headers: { ...(record.headers ?? {}), [payload.headerName]: payload.value },
      });
    }
  } else {
    // 'env' — only meaningful for stdio; field name + value come from the renderer.
    // We do not assume a specific authMethod here; the renderer controls it via
    // the form. Preserve the existing authMethod on the record.
    store.updateServer(id, {
      env: { ...(record.env ?? {}), [payload.envKey]: payload.value },
    });
  }

  const after = store.getServer(id);
  if (!after) return { ok: false, reason: 'server disappeared after save' };
  const result = await probeAuthorization(after, store);
  console.log(`[mcpAuthFlows] saved credential for server ${id}`);
  return { ok: true, result };
}

/** Just-probe without saving new credentials. Used by re-authorize / retry buttons. */
export async function probeOnly(
  id: string,
  options: SaveCredentialOptions = {},
): Promise<ProbeResult> {
  const store = options.store ?? getDefaultStore();
  const record = store.getServer(id);
  if (!record) return { ok: false, status: 'connect-error', latencyMs: 0, error: 'server not found' };
  return await probeAuthorization(record, store);
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
