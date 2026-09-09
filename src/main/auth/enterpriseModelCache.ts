import type { App } from 'electron';

import {
  clearServerModelMetadata,
  setServerModelMetadata,
} from '../libs/claudeSettings';
import { log as logger } from '../logger';
import { enterpriseClient } from './enterpriseClient';

export interface EnterpriseModelEntry {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  endpoint: string | null;
  capabilities: {
    supports_image: boolean;
    supports_video: boolean;
    supports_thinking: boolean;
    context_window: number | null;
    max_tokens: number | null;
  };
  quotaPerDay: number | null;
}

interface CachedModel extends EnterpriseModelEntry {
  apiKey: string | null;
}

let cache: Map<string, CachedModel> = new Map();
let activeModelId: string | null = null;
let orgId: string | null = null;

export const enterpriseModelCache = {
  async load(): Promise<{ models: EnterpriseModelEntry[]; activeModelId: string | null }> {
    const resp = await enterpriseClient.listEnterpriseModels();
    const next = new Map<string, CachedModel>();
    for (const m of resp.models) {
      next.set(m.id, { ...m, apiKey: m.apiKey });
    }
    cache = next;
    orgId = enterpriseClient.orgId;
    if (!activeModelId && cache.size > 0) {
      const firstThinking = [...cache.values()].find((m) => m.capabilities.supports_thinking);
      activeModelId = (firstThinking ?? cache.values().next().value!).id;
    }
    // Mirror the catalog into the legacy server-metadata cache so the
    // send-time run-gate (`evaluateServerModelRunGate`) and the OpenClaw
    // config sync (`getAllServerModelMetadata`) see the same model set.
    // Before the desktop disconnected from youdao this cache was filled
    // by the now-removed `auth:getModels` IPC; the enterprise catalog is
    // now the source of truth.
    clearServerModelMetadata();
    for (const m of cache.values()) {
      // Key the legacy cache by the catalog UUID (`m.id`). The desktop's
      // model identity is the catalog row's UUID (the OpenClaw `models[].id`
      // and the session/agent ref's model portion), and the enterprise proxy
      // rewrites the wire `model` back to the upstream name. Keying by the
      // upstream NAME would collapse two same-named rows bound to different
      // provider keys into one entry, so the same-name switch bug returns.
      // Legacy name refs (saved before the identity change) are tolerated by
      // the unique-name fallback in `canonicalModelId`.
      setServerModelMetadata(m.id, {
        modelName: m.displayName ?? m.model,
        provider: m.provider,
        apiFormat: 'openai',
        supportsImage: m.capabilities.supports_image,
        supportsVideo: m.capabilities.supports_video,
        supportsThinking: m.capabilities.supports_thinking,
        contextWindow: m.capabilities.context_window ?? undefined,
        maxTokens: m.capabilities.max_tokens ?? undefined,
      });
    }
    logger.info(`[enterpriseModelCache] loaded ${cache.size} models for org ${orgId}; active=${activeModelId}`);
    return {
      // Strip apiKey via destructuring so it never leaves the main process.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      models: [...cache.values()].map(({ apiKey, ...rest }) => rest),
      activeModelId,
    };
  },

  list(): EnterpriseModelEntry[] {
    // Strip apiKey via destructuring so it never leaves the main process.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return [...cache.values()].map(({ apiKey, ...rest }) => rest);
  },

  getApiKey(modelId: string): string | null {
    return cache.get(modelId)?.apiKey ?? null;
  },

  getEndpoint(modelId: string): string | null {
    return cache.get(modelId)?.endpoint ?? null;
  },

  /**
   * Look up a cached entry by its upstream-facing model name (e.g.
   * "Qwen3.8-27B"). Retained for legacy name-based lookups; the primary
   * send/run path uses the UUID via `canonicalModelId`/`resolveForSendRef`.
   *
   * Returns null when the name does not correspond to a cached
   * enterprise-managed model, so callers can distinguish "not enterprise
   * managed" from "enterprise-managed but not yet cached".
   */
  getByModelName(modelName: string): CachedModel | null {
    for (const entry of cache.values()) {
      if (entry.model === modelName) return entry;
    }
    return null;
  },

  isEmpty(): boolean {
    return cache.size === 0;
  },

  /**
   * Resolve both the API key and the endpoint for a model. Throws when the
   * model is unknown to the cache (e.g. user hasn't loaded the catalog yet
   * or the org disabled it). Used by chat-send IPC handlers to gate runs
   * before they hit upstream.
   */
  resolveForSend(modelId: string): { apiKey: string; endpoint: string } {
    const entry = cache.get(modelId);
    if (!entry || !entry.apiKey || !entry.endpoint) {
      throw new Error(`model ${modelId} not configured for org`);
    }
    return { apiKey: entry.apiKey, endpoint: entry.endpoint };
  },

  /**
   * Send-time resolver keyed by upstream model name (e.g. "Qwen3.8-27B"), the
   * identity the OpenClaw gateway actually routes on. Unlike `resolveForSend`
   * (which takes the catalog UUID and throws on a miss), this returns `null`
   * when the name is not an enterprise-managed model so the caller can skip
   * the gate, and throws only when the model IS enterprise-managed but its
   * key/endpoint is missing (e.g. `load()` has not finished yet).
   */
  resolveForSendByModelName(modelName: string): { apiKey: string; endpoint: string } | null {
    const entry = this.getByModelName(modelName);
    if (!entry) return null;
    if (!entry.apiKey || !entry.endpoint) {
      throw new Error(`model ${modelName} not configured for org`);
    }
    return { apiKey: entry.apiKey, endpoint: entry.endpoint };
  },

  /**
   * Resolve a run/ref model **portion** to its catalog UUID. New refs carry
   * the UUID directly; legacy refs (saved before the identity moved to the
   * catalog UUID) carry the upstream name. UUID lookup is tried first and is
   * authoritative. A name lookup that matches exactly one row resolves to
   * that row's UUID; a name matching several same-named rows is ambiguous
   * and returns null so the caller can surface the ambiguity rather than
   * guess. Returns null when the portion matches no catalog row.
   */
  canonicalModelId(portion: string): string | null {
    const trimmed = portion.trim();
    if (!trimmed) return null;
    const byId = cache.get(trimmed);
    if (byId) return byId.id;
    const byName: string[] = [];
    for (const entry of cache.values()) {
      if (entry.model === trimmed) byName.push(entry.id);
    }
    return byName.length === 1 ? byName[0] : null;
  },

  /**
   * Send-time resolver keyed by a ref's model **portion** (the segment after
   * `genwork-server/`). Canonicalizes via {@link canonicalModelId} (UUID-first,
   * unique-name legacy fallback) then validates the key/endpoint. Returns
   * `null` when the portion is not an enterprise-managed model so callers can
   * skip the gate, and throws only when the model IS enterprise-managed but
   * its key/endpoint is missing (e.g. `load()` has not finished yet).
   */
  resolveForSendRef(portion: string): { apiKey: string; endpoint: string } | null {
    const id = this.canonicalModelId(portion);
    if (!id) return null;
    const entry = cache.get(id);
    if (!entry || !entry.apiKey || !entry.endpoint) {
      throw new Error(`model ${portion} not configured for org`);
    }
    return { apiKey: entry.apiKey, endpoint: entry.endpoint };
  },

  setActive(modelId: string): void {
    if (!cache.has(modelId)) throw new Error(`unknown modelId: ${modelId}`);
    activeModelId = modelId;
  },

  getActive(): string | null {
    return activeModelId;
  },

  wipe(): void {
    // Replace contents with empty containers; old memory becomes GC-eligible.
    for (const v of cache.values()) v.apiKey = null;
    cache = new Map();
    activeModelId = null;
    orgId = null;
    // Drop the legacy server-metadata cache in lockstep so a stale org's
    // model ids can't satisfy a post-switch send-time run-gate.
    clearServerModelMetadata();
  },
};

export function bindShutdownWipe(app: App): void {
  const wipe = (): void => enterpriseModelCache.wipe();
  app.on('before-quit', wipe);
  app.on('window-all-closed', wipe);
  app.on('will-quit', wipe);
}