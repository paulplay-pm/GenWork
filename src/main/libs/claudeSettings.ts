import { type ApiFormat, type ProviderConfig, ProviderName } from '../../shared/providers';
import { type GenWorkRequestCapability } from '../../shared/providers/genworkRequestOptions';
import { type ModelThinkingConfig } from '../../shared/providers/modelThinking';
import {
  enterpriseModelCache,
} from '../auth/enterpriseModelCache';
import { enterpriseModelPrefs } from '../auth/enterpriseModelPrefs';
import { sessionStorage } from '../auth/sessionStorage';
import type { SqliteStore } from '../sqliteStore';
import { catalogResolver } from './catalogResolver';
import type { GenWorkApiConfig } from './genworkConfigStore';
import { type AnthropicApiFormat,normalizeProviderApiFormat } from './genworkFormatTransform';
import {
  configureCoworkOpenAICompatProxy,
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyStatus,
  type OpenAICompatProxyTarget,
} from './genworkOpenAICompatProxy';
import { readOpenAICodexAuthFile } from './openaiCodexAuth';
import { hasXaiOAuthCredential } from './xaiAuth';

type LocalProviderConfig = Omit<ProviderConfig, 'apiFormat'> & { apiFormat?: ApiFormat | 'native' };

const gwDiagTs = (): string => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const tz = d.getTimezoneOffset();
  const sign = tz <= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return `[GW-RESTART-DIAG] ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
};

type AppConfig = {
  model?: {
    defaultModel?: string;
    defaultModelProvider?: string;
  };
  providers?: Record<string, LocalProviderConfig>;
};

type ProviderModelConfig = {
  id: string;
  name: string;
  supportsImage?: boolean;
  supportsVideo?: boolean;
  supportsThinking?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  customParams?: Record<string, unknown>;
};

type ProviderModelInputConfig = {
  id: string;
  name?: string;
  supportsImage?: boolean;
  supportsVideo?: boolean;
  supportsThinking?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  customParams?: Record<string, unknown>;
};

export type ServerModelMetadata = {
  modelId: string;
  modelName?: string;
  provider?: string;
  apiFormat?: string;
  runtimeProfile?: string;
  supportsImage?: boolean;
  supportsVideo?: boolean;
  supportsThinking?: boolean;
  thinkingConfig?: ModelThinkingConfig;
  requestCapabilities?: GenWorkRequestCapability[];
  supportsToolCalling?: boolean;
  agenticReady?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  explicitContextCache?: boolean;
};

type CachedServerModelMetadata = Omit<ServerModelMetadata, 'modelId'> & {
  invalidRuntimeProfile?: boolean;
};

export type ServerModelMetadataInput =
  Omit<ServerModelMetadata, 'runtimeProfile' | 'thinkingConfig' | 'requestCapabilities'>
  & { runtimeProfile?: unknown; thinkingConfig?: unknown; requestCapabilities?: unknown };

export const ServerModelRunGateReason = {
  MetadataMissing: 'metadata_missing',
  RuntimeProfileMissing: 'runtime_profile_missing',
  RuntimeProfileUnsupported: 'runtime_profile_unsupported',
  TransportUnsupported: 'transport_unsupported',
  ToolCallingUnavailable: 'tool_calling_unavailable',
  AgenticNotReady: 'agentic_not_ready',
} as const;

export type ServerModelRunGateReason =
  typeof ServerModelRunGateReason[keyof typeof ServerModelRunGateReason];

export type ServerModelRunGateResult =
  | { allowed: true; metadata: ServerModelMetadata }
  | { allowed: false; reason: ServerModelRunGateReason };

const KIMI_K3_SERVER_MODEL_IDS = new Set([
  'kimik3',
  'kimik3youdaoinner',
]);

const isServerKimiK3Candidate = (
  metadata: Pick<ServerModelMetadataInput, 'modelId' | 'modelName' | 'provider'>,
): boolean => {
  const normalizedProvider = metadata.provider?.trim().toLowerCase();
  const normalizedName = metadata.modelName
    ? normalizeModelIdForComparison(metadata.modelName)
    : '';
  return KIMI_K3_SERVER_MODEL_IDS.has(normalizeModelIdForComparison(metadata.modelId))
    || (normalizedProvider === 'moonshot' && normalizedName === 'kimik3');
};

const normalizeModelIdForComparison = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

export type ApiConfigResolution = {
  config: GenWorkApiConfig | null;
  error?: string;
  providerMetadata?: {
    providerName: string;
    authType?: ProviderConfig['authType'];
    codingPlanEnabled: boolean;
    runtimeProfile?: string;
    supportsImage?: boolean;
    supportsVideo?: boolean;
    supportsThinking?: boolean;
    thinkingConfig?: ModelThinkingConfig;
    requestCapabilities?: GenWorkRequestCapability[];
    modelName?: string;
    contextWindow?: number;
    maxTokens?: number;
  };
};

// Store getter function injected from main.ts
let storeGetter: (() => SqliteStore | null) | null = null;

export function setStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

// Auth token getter injected from main.ts for server model provider
let authTokensGetter: (() => { accessToken: string; refreshToken: string } | null) | null = null;

export function setAuthTokensGetter(getter: () => { accessToken: string; refreshToken: string } | null): void {
  authTokensGetter = getter;
}

// Server base URL getter injected from main.ts
let serverBaseUrlGetter: (() => string) | null = null;

export function setServerBaseUrlGetter(getter: () => string): void {
  serverBaseUrlGetter = getter;
}

// Cached server model metadata (populated when auth:getModels is called).
// Keyed by modelId -> server-provided metadata used for OpenClaw config sync.
let serverModelMetadataCache: Map<string, CachedServerModelMetadata> = new Map();

export function clearServerModelMetadata(): void {
  serverModelMetadataCache.clear();
}

// Populate one entry of the legacy server-metadata cache from the
// enterprise catalog. This cache has been the source of truth for the
// send-time run-gate (`evaluateServerModelRunGate`) since the pre-disconnect
// youdao era, but no writer existed once `auth:getModels` was removed.
// The enterprise catalog is now the live source: `enterpriseModelCache.load`
// calls this for every entry it receives. The gate (line 222) reads back
// the entry it needs; the OpenClaw config sync (`getAllServerModelMetadata`)
// also reads it for the gateway's per-model placeholder substitution.
export function setServerModelMetadata(
  modelId: string,
  metadata: Omit<ServerModelMetadataInput, 'modelId'>,
): void {
  if (!modelId) return;
  // `ServerModelMetadataInput` deliberately widens `runtimeProfile`,
  // `thinkingConfig`, and `requestCapabilities` to `unknown` so callers
  // can pass server-supplied JSON. We narrow to the cache's concrete types
  // here; the values are already validated by the type signature.
  serverModelMetadataCache.set(modelId.trim(), {
    modelName: metadata.modelName ?? null,
    provider: metadata.provider ?? null,
    apiFormat: metadata.apiFormat ?? null,
    runtimeProfile: typeof metadata.runtimeProfile === 'string' ? metadata.runtimeProfile : null,
    supportsImage: metadata.supportsImage ?? null,
    supportsVideo: metadata.supportsVideo ?? null,
    supportsThinking: metadata.supportsThinking ?? null,
    thinkingConfig: (metadata.thinkingConfig ?? null) as ModelThinkingConfig | null,
    requestCapabilities: (metadata.requestCapabilities ?? null) as GenWorkRequestCapability[] | null,
    supportsToolCalling: metadata.supportsToolCalling ?? null,
    agenticReady: metadata.agenticReady ?? null,
    contextWindow: metadata.contextWindow ?? null,
    maxTokens: metadata.maxTokens ?? null,
    explicitContextCache: metadata.explicitContextCache ?? null,
  });
}

export function getAllServerModelMetadata(): ServerModelMetadata[] {
  return Array.from(serverModelMetadataCache.entries()).map(([modelId, meta]) => ({
    modelId,
    modelName: meta.modelName,
    provider: meta.provider,
    apiFormat: meta.apiFormat,
    runtimeProfile: meta.runtimeProfile,
    supportsImage: meta.supportsImage,
    supportsVideo: meta.supportsVideo,
    supportsThinking: meta.supportsThinking,
    thinkingConfig: meta.thinkingConfig,
    requestCapabilities: meta.requestCapabilities,
    supportsToolCalling: meta.supportsToolCalling,
    agenticReady: meta.agenticReady,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    explicitContextCache: meta.explicitContextCache,
  }));
}

export function getServerModelMetadata(modelId: string): ServerModelMetadata | null {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return null;
  const metadata = serverModelMetadataCache.get(normalizedModelId);
  if (!metadata) return null;
  return {
    modelId: normalizedModelId,
    modelName: metadata.modelName,
    provider: metadata.provider,
    apiFormat: metadata.apiFormat,
    runtimeProfile: metadata.runtimeProfile,
    supportsImage: metadata.supportsImage,
    supportsVideo: metadata.supportsVideo,
    supportsThinking: metadata.supportsThinking,
    thinkingConfig: metadata.thinkingConfig,
    requestCapabilities: metadata.requestCapabilities,
    supportsToolCalling: metadata.supportsToolCalling,
    agenticReady: metadata.agenticReady,
    contextWindow: metadata.contextWindow,
    maxTokens: metadata.maxTokens,
    explicitContextCache: metadata.explicitContextCache,
  };
}

export function evaluateServerModelRunGate(modelId: string): ServerModelRunGateResult {
  const normalizedModelId = modelId.trim();
  const cachedMetadata = normalizedModelId
    ? serverModelMetadataCache.get(normalizedModelId)
    : undefined;
  if (!cachedMetadata) {
    return { allowed: false, reason: ServerModelRunGateReason.MetadataMissing };
  }
  if (cachedMetadata.invalidRuntimeProfile) {
    return {
      allowed: false,
      reason: ServerModelRunGateReason.RuntimeProfileUnsupported,
    };
  }

  const metadata = getServerModelMetadata(normalizedModelId);
  if (!metadata) {
    return { allowed: false, reason: ServerModelRunGateReason.MetadataMissing };
  }
  if (!metadata.runtimeProfile) {
    if (isServerKimiK3Candidate(metadata)) {
      return {
        allowed: false,
        reason: ServerModelRunGateReason.RuntimeProfileMissing,
      };
    }
    return { allowed: true, metadata };
  }
  if (metadata.runtimeProfile !== 'moonshot-kimi-k3') {
    return {
      allowed: false,
      reason: ServerModelRunGateReason.RuntimeProfileUnsupported,
    };
  }
  if (metadata.apiFormat?.trim().toLowerCase() !== 'openai') {
    return { allowed: false, reason: ServerModelRunGateReason.TransportUnsupported };
  }
  if (metadata.supportsToolCalling !== true) {
    return { allowed: false, reason: ServerModelRunGateReason.ToolCallingUnavailable };
  }
  if (metadata.agenticReady !== true) {
    return { allowed: false, reason: ServerModelRunGateReason.AgenticNotReady };
  }
  return { allowed: true, metadata };
}

function buildServerFallbackModels(effectiveModelId: string): NonNullable<LocalProviderConfig['models']> {
  const models = getAllServerModelMetadata().map((model) => ({
    id: model.modelId,
    name: model.modelName || model.modelId,
    supportsImage: model.supportsImage,
    supportsVideo: model.supportsVideo,
    supportsThinking: model.supportsThinking,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));

  if (!models.some(model => model.id === effectiveModelId)) {
    const cachedMeta = serverModelMetadataCache.get(effectiveModelId);
    models.unshift({
      id: effectiveModelId,
      name: cachedMeta?.modelName || effectiveModelId,
      supportsImage: cachedMeta?.supportsImage,
      supportsVideo: cachedMeta?.supportsVideo,
      supportsThinking: cachedMeta?.supportsThinking,
      contextWindow: cachedMeta?.contextWindow,
      maxTokens: cachedMeta?.maxTokens,
    });
  }

  return models;
}

function normalizeProviderModels(providerName: string, models?: ProviderModelInputConfig[]): ProviderModelConfig[] {
  const cap = catalogResolver.resolveCapability(providerName, '');
  return (models ?? [])
    .filter(model => model.id?.trim())
    .map(model => {
      const contextWindow = catalogResolver.resolveCapability(providerName, model.id).contextWindow ?? model.contextWindow;
      const supportsThinking = catalogResolver.resolveCapability(providerName, model.id).supportsThinking ?? model.supportsThinking;
      const supportsVideo = catalogResolver.resolveCapability(providerName, model.id).supportsVideo ?? model.supportsVideo;
      const maxTokens = catalogResolver.resolveCapability(providerName, model.id).maxTokens ?? model.maxTokens;
      return {
        ...model,
        name: model.name || model.id,
        supportsImage: cap.supportsImage || model.supportsImage,
        ...(supportsVideo ? { supportsVideo } : {}),
        ...(supportsThinking ? { supportsThinking } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      };
    });
}

const getStore = (): SqliteStore | null => {
  if (!storeGetter) {
    return null;
  }
  return storeGetter();
};

type MatchedProvider = {
  providerName: string;
  providerConfig: LocalProviderConfig;
  modelId: string;
  apiFormat: AnthropicApiFormat;
  baseURL: string;
  runtimeProfile?: string;
  supportsImage?: boolean;
  supportsVideo?: boolean;
  supportsThinking?: boolean;
  thinkingConfig?: ModelThinkingConfig;
  requestCapabilities?: GenWorkRequestCapability[];
  modelName?: string;
  contextWindow?: number;
  maxTokens?: number;
};

function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  // Desktop is single-provider; defer to the saved apiFormat on the model.
  return normalizeProviderApiFormat(apiFormat);
}

function providerRequiresApiKey(providerName: string): boolean {
  return providerName !== ProviderName.Ollama
    && providerName !== ProviderName.LmStudio
    && providerName !== ProviderName.Copilot;
}

function shouldUseOpenAICodexOAuth(providerName: string, providerConfig: LocalProviderConfig): boolean {
  if (providerName !== ProviderName.OpenAI) {
    return false;
  }
  if (providerConfig.authType === 'oauth') {
    return true;
  }
  if (providerConfig.apiKey?.trim()) {
    return false;
  }
  return readOpenAICodexAuthFile() !== null;
}

/**
 * xAI OAuth mode: the credential lives in the OpenClaw auth-profiles store
 * (written by xaiAuth.ts) and the runtime's bundled xai plugin injects and
 * refreshes the Bearer token, so no local API key exists in oauth mode.
 */
function shouldUseXaiOAuth(providerName: string, providerConfig: LocalProviderConfig): boolean {
  return providerName === ProviderName.Xai && providerConfig.authType === 'oauth';
}

function tryGenworkServerFallback(modelId?: string): MatchedProvider | null {
  const tokens = authTokensGetter?.();
  const serverBaseUrl = serverBaseUrlGetter?.();
  if (!tokens?.accessToken || !serverBaseUrl) return null;
  const effectiveModelId = modelId?.trim() || '';
  if (!effectiveModelId) return null;
  const baseURL = `${serverBaseUrl}/api/proxy/v1`;
  const cachedMeta = serverModelMetadataCache.get(effectiveModelId);
  const effectiveApiFormat = cachedMeta?.apiFormat
    ? normalizeProviderApiFormat(cachedMeta.apiFormat)
    : 'openai';
  console.debug('[ClaudeSettings] genwork-server provider resolved:', {
    baseURL,
    modelId: effectiveModelId,
    apiFormat: effectiveApiFormat,
    supportsImage: cachedMeta?.supportsImage,
    supportsThinking: cachedMeta?.supportsThinking,
    thinkingConfig: cachedMeta?.thinkingConfig,
  });
  return {
    providerName: ProviderName.GenworkServer,
    providerConfig: { enabled: true, apiKey: tokens.accessToken, baseUrl: baseURL, apiFormat: effectiveApiFormat, models: buildServerFallbackModels(effectiveModelId) },
    modelId: effectiveModelId,
    apiFormat: effectiveApiFormat,
    baseURL,
    runtimeProfile: cachedMeta?.runtimeProfile,
    supportsImage: cachedMeta?.supportsImage,
    supportsVideo: cachedMeta?.supportsVideo,
    supportsThinking: cachedMeta?.supportsThinking,
    thinkingConfig: cachedMeta?.thinkingConfig,
    requestCapabilities: cachedMeta?.requestCapabilities,
    modelName: cachedMeta?.modelName,
    contextWindow: cachedMeta?.contextWindow,
    maxTokens: cachedMeta?.maxTokens,
  };
}

export function tryEnterpriseCatalogFallback(modelId?: string): MatchedProvider | null {
  if (!process.env.ENTERPRISE_SERVER_URL) return null;
  if (enterpriseModelCache.isEmpty()) return null;

  const entries = enterpriseModelCache.list();
  const wantedId = modelId?.trim();
  const lastUsedId = enterpriseModelPrefs.readLastSelectedModelId();
  const matchedEntry =
    (wantedId ? entries.find((e) => e.id === wantedId) : undefined)
    ?? (lastUsedId ? entries.find((e) => e.id === lastUsedId) : undefined)
    ?? entries[0];

  if (!matchedEntry) return null;

  const apiKey = enterpriseModelCache.getApiKey(matchedEntry.id);
  const endpoint = enterpriseModelCache.getEndpoint(matchedEntry.id);
  if (!apiKey || !endpoint) return null;

  // Route enterprise models through the multi-tenant proxy
  // (${ENTERPRISE_SERVER_URL}/proxy/<provider>) instead of the catalog's
  // raw upstream URL. The proxy holds the org context (from the user's
  // JWT) and looks up the correct provider_key for the org, so vllm
  // (or any other upstream) sees a request that is unambiguously
  // authorised for the org. Direct upstream connections bypass the
  // proxy and the per-org allowlist there rejects the request with
  // "model not configured for org" when the catalog's apiKey is bound
  // to a different vllm-side org than the model row.
  const enterpriseUrl = process.env.ENTERPRISE_SERVER_URL ?? '';
  const enterpriseSession = sessionStorage.load();
  const userJwt = enterpriseSession?.jwt ?? '';
  if (!enterpriseUrl || !userJwt) return null;
  const baseURL = `${enterpriseUrl}/proxy/${matchedEntry.provider}`;
  // OpenClaw needs SOMETHING non-empty for the Authorization header
  // (it just forwards it), so use the user's enterprise JWT. The proxy
  // re-authenticates with its own logic and substitutes the org's
  // provider_key before forwarding upstream.
  const upstreamAuth = userJwt;
  const modelName = matchedEntry.displayName ?? matchedEntry.model;
  console.debug('[ClaudeSettings] enterprise catalog provider resolved:', {
    baseURL,
    modelId: matchedEntry.id,
    supportsImage: matchedEntry.capabilities.supports_image,
    supportsThinking: matchedEntry.capabilities.supports_thinking,
  });
  return {
    providerName: ProviderName.GenworkServer,
    providerConfig: {
      enabled: true,
      apiKey: upstreamAuth,
      baseUrl: baseURL,
      apiFormat: 'openai',
      models: [
        {
          id: matchedEntry.id,
          name: modelName ?? matchedEntry.id,
        },
      ],
    },
    modelId: matchedEntry.id,
    apiFormat: 'openai',
    baseURL,
    supportsImage: matchedEntry.capabilities.supports_image,
    supportsVideo: matchedEntry.capabilities.supports_video,
    supportsThinking: matchedEntry.capabilities.supports_thinking,
    modelName,
    contextWindow: matchedEntry.capabilities.context_window ?? undefined,
    maxTokens: matchedEntry.capabilities.max_tokens ?? undefined,
    runtimeProfile: 'enterprise',
  };
}

function resolveMatchedProvider(appConfig: AppConfig): { matched: MatchedProvider | null; error?: string } {
  const providers = appConfig.providers ?? {};

  const resolveFallbackModel = (): {
    providerName: string;
    providerConfig: LocalProviderConfig;
    modelId: string;
  } | null => {
    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (!providerConfig?.enabled || !providerConfig.models || providerConfig.models.length === 0) {
        continue;
      }
      const fallbackModel = providerConfig.models.find((model) => model.id?.trim());
      if (!fallbackModel) {
        continue;
      }
      return {
        providerName,
        providerConfig,
        modelId: fallbackModel.id.trim(),
      };
    }
    return null;
  };

  const configuredModelId = appConfig.model?.defaultModel?.trim();
  let modelId = configuredModelId || '';
  if (!modelId) {
    const fallback = resolveFallbackModel();
    if (!fallback) {
      const enterpriseMatch = tryEnterpriseCatalogFallback(configuredModelId);
      if (enterpriseMatch) return { matched: enterpriseMatch };
      const serverFallback = tryGenworkServerFallback(configuredModelId);
      if (serverFallback) return { matched: serverFallback };
      return { matched: null, error: 'No available model configured in enabled providers.' };
    }
    modelId = fallback.modelId;
  }

  let providerEntry: [string, LocalProviderConfig] | undefined;
  const preferredProviderName = appConfig.model?.defaultModelProvider?.trim();

  // Handle genwork-server provider: dynamically construct from auth tokens
  if (preferredProviderName === ProviderName.GenworkServer) {
    const enterpriseMatch = tryEnterpriseCatalogFallback(modelId);
    if (enterpriseMatch) return { matched: enterpriseMatch };
    const serverMatch = tryGenworkServerFallback(modelId);
    if (serverMatch) {
      return { matched: serverMatch };
    }
  }

  if (preferredProviderName) {
    const preferredProvider = providers[preferredProviderName];
    if (
      preferredProvider?.enabled
      && preferredProvider.models?.some((model) => model.id === modelId)
    ) {
      providerEntry = [preferredProviderName, preferredProvider];
    }
  }

  if (!providerEntry) {
    providerEntry = Object.entries(providers).find(([, provider]) => {
      if (!provider?.enabled || !provider.models) {
        return false;
      }
      return provider.models.some((model) => model.id === modelId);
    });
  }

  if (!providerEntry) {
    const fallback = resolveFallbackModel();
    if (fallback) {
      modelId = fallback.modelId;
      providerEntry = [fallback.providerName, fallback.providerConfig];
    } else {
      const enterpriseMatch = tryEnterpriseCatalogFallback(modelId);
      if (enterpriseMatch) return { matched: enterpriseMatch };
      const serverFallback = tryGenworkServerFallback(modelId);
      if (serverFallback) return { matched: serverFallback };
      return { matched: null, error: `No enabled provider found for model: ${modelId}` };
    }
  }

  const [providerName, storedProviderConfig] = providerEntry;
  const providerConfig = shouldUseOpenAICodexOAuth(providerName, storedProviderConfig)
    ? { ...storedProviderConfig, authType: 'oauth' as const }
    : storedProviderConfig;
  const normalizedProviderModels = normalizeProviderModels(providerName, providerConfig.models);

  // MiniMax OAuth mode guard: if OAuth is selected but login has not been completed
  // (no access token), do not use the stale API key as an OAuth token.
  if (providerName === ProviderName.Minimax && (providerConfig as any).authType === 'oauth' && !(providerConfig as any).oauthAccessToken) {
    const enterpriseMatch = tryEnterpriseCatalogFallback(modelId);
    if (enterpriseMatch) return { matched: enterpriseMatch };
    const serverFallback = tryGenworkServerFallback(modelId);
    if (serverFallback) return { matched: serverFallback };
    return { matched: null, error: 'MiniMax OAuth mode selected but login not completed.' };
  }

  // xAI OAuth mode guard: without a credential in the OpenClaw auth-profiles
  // store the provider cannot serve requests yet.
  if (shouldUseXaiOAuth(providerName, providerConfig) && !hasXaiOAuthCredential()) {
    const enterpriseMatch = tryEnterpriseCatalogFallback(modelId);
    if (enterpriseMatch) return { matched: enterpriseMatch };
    const serverFallback = tryGenworkServerFallback(modelId);
    if (serverFallback) return { matched: serverFallback };
    return { matched: null, error: 'xAI OAuth mode selected but login not completed.' };
  }

  let apiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);
  let baseURL = providerConfig.baseUrl?.trim();

  // codingPlan is no longer used: the desktop is single-provider
  // (genwork-server) and the dedicated coding-plan endpoints were a
  // per-provider concept.

  if (!baseURL) {
    const enterpriseMatch = tryEnterpriseCatalogFallback(modelId);
    if (enterpriseMatch) return { matched: enterpriseMatch };
    const serverFallback = tryGenworkServerFallback(modelId);
    if (serverFallback) return { matched: serverFallback };
    return { matched: null, error: `Provider ${providerName} is missing base URL.` };
  }

   // Check for API key or OAuth credentials
  const hasApiKey = providerConfig.apiKey?.trim();
  const hasOAuthCreds =
    (providerName === ProviderName.Minimax && (providerConfig as any).authType === 'oauth' && !!(providerConfig as any).oauthAccessToken?.trim())
    || shouldUseOpenAICodexOAuth(providerName, providerConfig)
    || (shouldUseXaiOAuth(providerName, providerConfig) && hasXaiOAuthCredential());
  if (apiFormat === 'anthropic' && providerRequiresApiKey(providerName) && !providerConfig.apiKey?.trim() && !hasApiKey && !hasOAuthCreds) {
    const enterpriseMatch = tryEnterpriseCatalogFallback(modelId);
    if (enterpriseMatch) return { matched: enterpriseMatch };
    const serverFallback = tryGenworkServerFallback(modelId);
    if (serverFallback) return { matched: serverFallback };
    return { matched: null, error: `Provider ${providerName} requires API key for Anthropic-compatible mode.` };
  }

  const matchedModel = normalizedProviderModels.find((m) => m.id === modelId);

  return {
    matched: {
      providerName,
      providerConfig: {
        ...providerConfig,
        models: normalizedProviderModels,
      },
      modelId,
      apiFormat,
      baseURL,
      supportsImage: matchedModel?.supportsImage,
      supportsVideo: matchedModel?.supportsVideo,
      supportsThinking: matchedModel?.supportsThinking,
      modelName: matchedModel?.name,
      contextWindow: matchedModel?.contextWindow,
      maxTokens: matchedModel?.maxTokens,
    },
  };
}

export function resolveCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return {
      config: null,
      error: 'Store is not initialized.',
    };
  }

  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return {
      config: null,
      error: 'Application config not found.',
    };
  }

  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return {
      config: null,
      error,
    };
  }

  const resolvedBaseURL = matched.baseURL;
  let resolvedApiKey = matched.providerConfig.apiKey?.trim() || '';

  // Providers that don't require auth (e.g. Ollama) still need a non-empty
  // placeholder so downstream components (OpenClaw gateway, compat proxy)
  // don't reject the request with "No API key found for provider".
  const effectiveApiKey = resolvedApiKey
    || (!providerRequiresApiKey(matched.providerName) ? 'sk-genwork-local' : '');

  if (matched.apiFormat === 'anthropic') {
    return {
      config: {
        apiKey: effectiveApiKey,
        baseURL: resolvedBaseURL,
        model: matched.modelId,
        apiType: 'anthropic',
      },
      providerMetadata: {
        providerName: matched.providerName,
        codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
        runtimeProfile: matched.runtimeProfile,
        supportsImage: matched.supportsImage,
        supportsVideo: matched.supportsVideo,
        supportsThinking: matched.supportsThinking,
        thinkingConfig: matched.thinkingConfig,
        requestCapabilities: matched.requestCapabilities,
        modelName: matched.modelName,
        contextWindow: matched.contextWindow,
        maxTokens: matched.maxTokens,
      },
    };
  }

  const proxyStatus = getCoworkOpenAICompatProxyStatus();
  if (!proxyStatus.running) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy is not running.',
    };
  }

  configureCoworkOpenAICompatProxy({
    baseURL: resolvedBaseURL,
    apiKey: resolvedApiKey || undefined,
    model: matched.modelId,
    provider: matched.providerName,
  });

  const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL(target);
  if (!proxyBaseURL) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy base URL is unavailable.',
    };
  }

  return {
    config: {
      apiKey: resolvedApiKey || 'genwork-openai-compat',
      baseURL: proxyBaseURL,
      model: matched.modelId,
      apiType: 'openai',
    },
    providerMetadata: {
      providerName: matched.providerName,
      codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
      runtimeProfile: matched.runtimeProfile,
      supportsImage: matched.supportsImage,
      supportsVideo: matched.supportsVideo,
      supportsThinking: matched.supportsThinking,
      thinkingConfig: matched.thinkingConfig,
      requestCapabilities: matched.requestCapabilities,
      modelName: matched.modelName,
      contextWindow: matched.contextWindow,
      maxTokens: matched.maxTokens,
    },
  };
}

export function getCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): GenWorkApiConfig | null {
  return resolveCurrentApiConfig(target).config;
}

/**
 * Resolve the raw API config directly from the app config,
 * without requiring the OpenAI compatibility proxy.
 * Used by OpenClaw config sync which has its own model routing.
 */
export function resolveRawApiConfig(): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    console.debug('[ClaudeSettings] resolveRawApiConfig: store is null, storeGetter not set yet');
    return { config: null, error: 'Store is not initialized.' };
  }
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    console.debug('[ClaudeSettings] resolveRawApiConfig: app_config not found in store');
    return { config: null, error: 'Application config not found.' };
  }
  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    // Local-config path failed (no matching appConfig.providers entry).
    //
    // Desktop LLM access routes uniformly through the multi-tenant proxy
    // (${ENTERPRISE_SERVER_URL}/proxy/<provider> + the user JWT). That proxy
    // config is produced by resolveMatchedProvider → tryEnterpriseCatalogFallback
    // above: whenever ENTERPRISE_SERVER_URL and a session JWT are present, an
    // enterprise model resolves to a `matched` and the proxy path below (line 851+)
    // is used. We therefore reach this branch ONLY when the proxy is unusable
    // (no ENTERPRISE_SERVER_URL, no session JWT, or empty catalog).
    //
    // We must NOT fall back to the catalog's raw upstream endpoint
    // (enterpriseModelCache.getEndpoint) with a ${GENWORK_APIKEY_X} placeholder
    // here: a direct upstream connection bypasses the proxy and the per-org
    // allowlist, and the upstream rejects a model it doesn't serve with
    // 404 "model_not_found" (e.g. a Qwen model forwarded to /proxy/deepseek's
    // DeepSeek upstream). Returning config: null lets openclawConfigSync
    // handle the no-model state and the enterprise openclaw.json merge supply
    // the proxy-based provider block.
    const providerKeys = Object.keys(appConfig.providers ?? {});
    const defaultModel = appConfig.model?.defaultModel;
    const defaultProvider = appConfig.model?.defaultModelProvider;
    const enterpriseActive = (() => {
      try {
        return enterpriseModelCache.getActive();
      } catch {
        return null;
      }
    })();
    console.debug(`[ClaudeSettings] resolveRawApiConfig: no matched provider, error=${error}, providers=[${providerKeys.join(',')}], defaultModel=${defaultModel}, defaultProvider=${defaultProvider}, enterpriseActive=${enterpriseActive ?? ''}`);
    return { config: null, error };
  }
  let apiKey = matched.providerConfig.apiKey?.trim() || '';
  let effectiveBaseURL = matched.baseURL;
  let effectiveApiFormat = matched.apiFormat;

  // Handle MiniMax OAuth: use oauthAccessToken and oauthBaseUrl (independent of apiKey)
  if (matched.providerName === ProviderName.Minimax && (matched.providerConfig as any).authType === 'oauth') {
    const oauthToken = (matched.providerConfig as any).oauthAccessToken?.trim();
    const oauthBaseUrl = (matched.providerConfig as any).oauthBaseUrl?.trim();
    if (oauthToken) {
      apiKey = oauthToken;
      if (oauthBaseUrl) effectiveBaseURL = oauthBaseUrl;
      effectiveApiFormat = 'anthropic';
    }
  }

  console.log('[ClaudeSettings] resolved raw API config:', JSON.stringify({
    providerName: matched.providerName,
    modelId: matched.modelId,
    apiFormat: effectiveApiFormat,
    runtimeProfile: matched.runtimeProfile,
    supportsImage: matched.supportsImage,
    supportsVideo: matched.supportsVideo,
    supportsThinking: matched.supportsThinking,
    contextWindow: matched.contextWindow,
    maxTokens: matched.maxTokens,
    codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
    authType: matched.providerConfig.authType,
  }));
  // OpenClaw's gateway requires a non-empty apiKey for every provider — even
  // local servers (Ollama, vLLM, etc.) that don't enforce auth.  When the user
  // leaves the key blank we supply a placeholder so the gateway doesn't reject
  // the request with "No API key found for provider".
  const effectiveApiKey = apiKey
    || (!providerRequiresApiKey(matched.providerName) ? 'sk-genwork-local' : '');
  return {
    config: {
      apiKey: effectiveApiKey,
      baseURL: effectiveBaseURL,
      model: matched.modelId,
      apiType: effectiveApiFormat === 'anthropic' ? 'anthropic' : 'openai',
    },
    providerMetadata: {
      providerName: matched.providerName,
      authType: matched.providerConfig.authType,
      codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
      runtimeProfile: matched.runtimeProfile,
      supportsImage: matched.supportsImage,
      supportsVideo: matched.supportsVideo,
      supportsThinking: matched.supportsThinking,
      thinkingConfig: matched.thinkingConfig,
      requestCapabilities: matched.requestCapabilities,
      modelName: matched.modelName,
      contextWindow: matched.contextWindow,
      maxTokens: matched.maxTokens,
    },
  };
}

/**
 * Collect apiKeys for ALL configured providers (not just the currently selected one).
 * Used by OpenClaw config sync to pre-register all apiKeys as env vars at gateway
 * startup, so switching between providers doesn't require a process restart.
 *
 * Returns a map of env-var-safe provider name → apiKey.
 */
export function resolveAllProviderApiKeys(): Record<string, string> {
  const result: Record<string, string> = {};

  // genwork-server token: the consumer backend's access token is injected as
  // an env var for the personal (non-enterprise) path. The local token proxy
  // that previously managed this has been removed, so the token is always
  // injected here whenever a consumer token is available.
  const tokens = authTokensGetter?.();
  const serverBaseUrl = serverBaseUrlGetter?.();
  if (tokens?.accessToken && serverBaseUrl) {
    result.SERVER = tokens.accessToken;
  }

  // All configured custom providers
  const sqliteStore = getStore();
  if (!sqliteStore) return result;
  const appConfig = sqliteStore.get<AppConfig>('app_config');

  // Local-config path (legacy / personal / non-enterprise mode): the desktop
  // still owns its own provider keys via app_config.providers. This branch
  // is what the pre-enterprise codebase used.
  if (appConfig?.providers) {
    for (const [providerName, providerConfig] of Object.entries(appConfig.providers)) {
      if (!providerConfig?.enabled) continue;
      if (shouldUseOpenAICodexOAuth(providerName, providerConfig)) {
        continue;
      }
      // xAI OAuth: the Bearer comes from the OpenClaw auth-profiles store, no env key.
      if (shouldUseXaiOAuth(providerName, providerConfig)) {
        continue;
      }
      // For MiniMax OAuth, inject oauthAccessToken instead of apiKey
      let apiKey = providerConfig.apiKey?.trim();
      if (providerName === ProviderName.Minimax && (providerConfig as any).authType === 'oauth') {
        const oauthToken = (providerConfig as any).oauthAccessToken?.trim();
        if (!oauthToken) continue; // OAuth not completed, skip
        apiKey = oauthToken;
      } else if (!apiKey && providerRequiresApiKey(providerName)) {
        continue;
      }
      const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      result[envName] = apiKey || 'sk-genwork-local';
    }
  }

  // Enterprise path: per spec §4.3 the desktop never persists API keys
  // locally. The enterprise server hands the desktop a per-org catalog
  // (kept in memory in enterpriseModelCache). The env-name derivation must
  // match what openclaw.json expects so that the `${GENWORK_APIKEY_<NAME>}`
  // placeholder resolves at gateway startup.
  //
  // This is collected IN ADDITION to the local providers above, not as an
  // `else` branch. After an enterprise login the config-sync round trip
  // leaves a hollow `genwork-server` entry in app_config.providers (empty
  // key, no models), which keeps the local branch above "active" while
  // resolveRawApiConfig falls through to the enterprise branch and writes a
  // `${GENWORK_APIKEY_X}` placeholder. If we made the two branches mutually
  // exclusive, the hollow local entry would shadow the real catalog and the
  // placeholder would have no matching env var → gateway SecretRefResolutionError
  // crash loop. In pure local mode the catalog is empty, so this is a no-op.
  try {
    const enterpriseList = enterpriseModelCache.list();
    if (enterpriseList.length > 0) {
      console.log(
        `[resolveAllProviderApiKeys] enterprise cache size=${enterpriseList.length} sample=${JSON.stringify(enterpriseList[0] ?? null)}`,
      );
    }
    for (const m of enterpriseList) {
      const apiKey = enterpriseModelCache.getApiKey(m.id);
      if (!apiKey) continue;
      const envName = m.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      // Last-write-wins: if multiple models share a provider (e.g. two Qwen
      // variants under provider='vllm'), the loop's last seen key wins, which
      // is consistent with the legacy path that wrote a single key per provider.
      // The catalog key also wins over a hollow local entry of the same name,
      // which is what we want in enterprise mode.
      result[envName] = apiKey;
    }
  } catch (err) {
    console.error('[resolveAllProviderApiKeys] enterprise cache read failed:', err);
    // enterpriseModelCache not configured (e.g. running unit tests).
    // Fall through with no provider keys; OpenClaw will surface the
    // empty-key state to the user via its own auth error.
  }

  const D = gwDiagTs;
  console.log(`${D()} resolveAllProviderApiKeys: hasServer=${!!result.SERVER} providers=[${Object.keys(result).filter(k => k !== 'SERVER').join(',')}]`);

  return result;
}


export function buildEnvForConfig(config: GenWorkApiConfig): Record<string, string> {
  const baseEnv = { ...process.env } as Record<string, string>;

  baseEnv.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  baseEnv.ANTHROPIC_API_KEY = config.apiKey;
  baseEnv.ANTHROPIC_BASE_URL = config.baseURL;
  baseEnv.ANTHROPIC_MODEL = config.model;
  return baseEnv;
}

export type ProviderRawConfig = {
  providerName: string;
  baseURL: string;
  apiKey: string;
  apiType: 'anthropic' | 'openai';
  authType?: ProviderConfig['authType'];
  codingPlanEnabled: boolean;
  models: ProviderModelConfig[];
};

export type ProviderSourceEntry = {
  providerName: string;
  codingPlanEnabled: boolean;
  authType?: ProviderConfig['authType'];
  displayName?: string;
};

/**
 * Lightweight view of every configured provider (enabled or not) for
 * classifying which Settings entry a runtime error's provider id belongs to.
 */
export function listProviderSourceEntries(): ProviderSourceEntry[] {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<AppConfig>('app_config');
  if (!appConfig?.providers) return [];

  const entries: ProviderSourceEntry[] = [];
  for (const [providerName, providerConfig] of Object.entries(appConfig.providers)) {
    if (!providerConfig) continue;
    entries.push({
      providerName,
      codingPlanEnabled: !!providerConfig.codingPlanEnabled,
      authType: providerConfig.authType,
      displayName: providerConfig.displayName?.trim() || undefined,
    });
  }
  return entries;
}

export function resolveAllEnabledProviderConfigs(): ProviderRawConfig[] {
  const sqliteStore = getStore();
  if (!sqliteStore) return [];
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig?.providers) return [];

  const result: ProviderRawConfig[] = [];

  for (const [providerName, providerConfig] of Object.entries(appConfig.providers)) {
    if (!providerConfig?.enabled) continue;
    if (providerName === ProviderName.GenworkServer) continue;

    // When minimax is in OAuth mode, use oauthAccessToken and oauthBaseUrl
    // (independent from the user's manually entered apiKey/baseUrl).
    // This must come before the apiKey emptiness check below.
    if (providerName === ProviderName.Minimax && (providerConfig as any).authType === 'oauth') {
      const oauthToken = (providerConfig as any).oauthAccessToken?.trim();
      if (!oauthToken) continue; // OAuth not completed, skip
      const oauthBaseUrl = ((providerConfig as any).oauthBaseUrl?.trim()) || providerConfig.baseUrl?.trim() || '';
      if (!oauthBaseUrl) continue;
      const models = normalizeProviderModels(providerName, providerConfig.models);
      if (models.length === 0) continue;
      result.push({
        providerName,
        baseURL: oauthBaseUrl,
        apiKey: oauthToken,
        apiType: 'anthropic',
        authType: providerConfig.authType,
        codingPlanEnabled: false,
        models,
      });
      continue;
    }

    if (shouldUseOpenAICodexOAuth(providerName, providerConfig)) {
      const baseURL = providerConfig.baseUrl?.trim() || 'https://api.openai.com/v1';
      const models = normalizeProviderModels(providerName, providerConfig.models);
      if (models.length === 0) continue;
      result.push({
        providerName,
        baseURL,
        apiKey: '',
        apiType: 'openai',
        authType: 'oauth',
        codingPlanEnabled: false,
        models,
      });
      continue;
    }

    // xAI OAuth: declare the provider only once login has completed, so the
    // gateway never sees an xai provider it cannot authenticate.
    if (shouldUseXaiOAuth(providerName, providerConfig)) {
      if (!hasXaiOAuthCredential()) continue;
      const baseURL = providerConfig.baseUrl?.trim() || 'https://api.x.ai/v1';
      const models = normalizeProviderModels(providerName, providerConfig.models);
      if (models.length === 0) continue;
      result.push({
        providerName,
        baseURL,
        apiKey: '',
        apiType: 'openai',
        authType: 'oauth',
        codingPlanEnabled: false,
        models,
      });
      continue;
    }

    const apiKey = providerConfig.apiKey?.trim() || '';
    if (!apiKey && providerRequiresApiKey(providerName)) continue;

    const baseURL = providerConfig.baseUrl?.trim() || '';

    let effectiveBaseURL = baseURL;
    let effectiveApiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);

    // codingPlan is no longer used: the desktop is single-provider
    // (genwork-server) and the dedicated coding-plan endpoints were a
    // per-provider concept.

    if (!effectiveBaseURL) continue;

    const models = normalizeProviderModels(providerName, providerConfig.models);
    if (models.length === 0) continue;

    result.push({
      providerName,
      baseURL: effectiveBaseURL,
      apiKey: apiKey || 'sk-genwork-local',
      apiType: effectiveApiFormat === 'anthropic' ? 'anthropic' : 'openai',
      authType: providerConfig.authType,
      codingPlanEnabled: !!providerConfig.codingPlanEnabled,
      models,
    });
  }

  return result;
}

/**
 * Returns the long-lived GitHub OAuth token used by OpenClaw's built-in
 * github-copilot provider to exchange for short-lived Copilot API tokens.
 * OpenClaw reads this from the COPILOT_GITHUB_TOKEN env var.
 */
export function getCopilotGithubToken(): string | null {
  const sqliteStore = getStore();
  if (!sqliteStore) return null;
  const token = sqliteStore.get<string>('github_copilot_github_token');
  return token?.trim() || null;
}
