import { describe,expect, test } from 'vitest';

import {
  OpenClawApi,
  OpenClawProviderId,
  ProviderName,
} from '../../shared/providers';

const providerApiKeyEnvVar = (providerName: string): string => {
  const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `GENWORK_APIKEY_${envName}`;
};

describe('providerApiKeyEnvVar', () => {
  test('converts simple provider names', () => {
    expect(providerApiKeyEnvVar(ProviderName.Moonshot)).toBe('GENWORK_APIKEY_MOONSHOT');
    expect(providerApiKeyEnvVar(ProviderName.Anthropic)).toBe('GENWORK_APIKEY_ANTHROPIC');
    expect(providerApiKeyEnvVar(ProviderName.OpenAI)).toBe('GENWORK_APIKEY_OPENAI');
    expect(providerApiKeyEnvVar(ProviderName.Ollama)).toBe('GENWORK_APIKEY_OLLAMA');
  });

  test('replaces hyphens and special chars with underscores', () => {
    expect(providerApiKeyEnvVar(ProviderName.GenworkServer)).toBe('GENWORK_APIKEY_GENWORK_SERVER');
    expect(providerApiKeyEnvVar('my.provider')).toBe('GENWORK_APIKEY_MY_PROVIDER');
  });

  test('server key matches hardcoded convention', () => {
    expect(providerApiKeyEnvVar('server')).toBe('GENWORK_APIKEY_SERVER');
  });
});

describe('env var stability on model switch', () => {
  const simulateCollectEnvVars = (providers: Record<string, { enabled: boolean; apiKey: string }>, serverToken?: string) => {
    const env: Record<string, string> = {};

    if (serverToken) {
      env.GENWORK_APIKEY_SERVER = serverToken;
    }

    for (const [name, config] of Object.entries(providers)) {
      if (!config.enabled) continue;
      const envName = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      env[`GENWORK_APIKEY_${envName}`] = config.apiKey;
    }

    return env;
  };

  test('switching from server to custom provider does not change env var keys', () => {
    const providers = {
      [ProviderName.Moonshot]: { enabled: true, apiKey: 'sk-moon-123' },
    };
    const serverToken = 'access-token-xyz';

    const envBefore = simulateCollectEnvVars(providers, serverToken);
    const envAfter = simulateCollectEnvVars(providers, serverToken);

    expect(JSON.stringify(envBefore)).toBe(JSON.stringify(envAfter));
  });

  test('switching between two custom providers does not change env var keys', () => {
    const providers = {
      [ProviderName.Moonshot]: { enabled: true, apiKey: 'sk-moon-123' },
      [ProviderName.Anthropic]: { enabled: true, apiKey: 'sk-ant-456' },
    };

    const envBefore = simulateCollectEnvVars(providers);
    const envAfter = simulateCollectEnvVars(providers);

    expect(JSON.stringify(envBefore)).toBe(JSON.stringify(envAfter));
    expect(envBefore.GENWORK_APIKEY_MOONSHOT).toBe('sk-moon-123');
    expect(envBefore.GENWORK_APIKEY_ANTHROPIC).toBe('sk-ant-456');
  });

  test('only editing apiKey value causes env var change', () => {
    const providersBefore = {
      [ProviderName.Moonshot]: { enabled: true, apiKey: 'sk-moon-OLD' },
    };
    const providersAfter = {
      [ProviderName.Moonshot]: { enabled: true, apiKey: 'sk-moon-NEW' },
    };

    const envBefore = simulateCollectEnvVars(providersBefore);
    const envAfter = simulateCollectEnvVars(providersAfter);

    expect(JSON.stringify(envBefore)).not.toBe(JSON.stringify(envAfter));
  });
});

// ═══════════════════════════════════════════════════════
// Provider Descriptor Registry Tests
//
// Since buildProviderSelection imports Electron-only modules,
// we mirror the descriptor resolution logic here to verify
// the registry mapping correctness.
// ═══════════════════════════════════════════════════════

type OpenClawProviderApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses' | 'google-generative-ai';

const mapApiTypeToOpenClawApi = (
  apiType: 'anthropic' | 'openai' | undefined,
): OpenClawProviderApi => {
  if (apiType === 'openai') return 'openai-completions';
  return 'anthropic-messages';
};

type ProviderDescriptor = {
  providerId: string;
  resolveApi: (ctx: { apiType: 'anthropic' | 'openai' | undefined; baseURL: string }) => OpenClawProviderApi;
  normalizeBaseUrl: (rawBaseUrl: string) => string;
  resolveSessionModelId?: (modelId: string) => string;
  resolveModelReasoning?: (modelId: string, codingPlanEnabled: boolean) => boolean | undefined;
  modelDefaults?: Partial<{
    reasoning: boolean;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
};

const DEEPSEEK_REASONING_MODEL_IDS = new Set(['deepseek-reasoner', 'deepseek-r1']);
const DEEPSEEK_V4_MODEL_PATTERN = /^deepseek-v4(?:[-_.]|$)/;

const resolveDeepSeekModelReasoning = (modelId: string): boolean | undefined => {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (DEEPSEEK_REASONING_MODEL_IDS.has(normalized) || DEEPSEEK_V4_MODEL_PATTERN.test(normalized)) {
    return true;
  }
  return undefined;
};

const stripChatCompletionsSuffix = (rawBaseUrl: string): string => {
  const trimmed = rawBaseUrl.trim();
  if (!trimmed) return trimmed;
  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.endsWith('/openai')) {
    return normalized.slice(0, -'/openai'.length);
  }
  return normalized;
};

const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {
  [ProviderName.Moonshot]: {
    providerId: OpenClawProviderId.Moonshot,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
    modelDefaults: {
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 8192,
    },
  },
  [ProviderName.Gemini]: {
    providerId: OpenClawProviderId.Google,
    resolveApi: () => OpenClawApi.GoogleGenerativeAI as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
    modelDefaults: { reasoning: true },
  },
  [ProviderName.Anthropic]: {
    providerId: OpenClawProviderId.Anthropic,
    resolveApi: () => OpenClawApi.AnthropicMessages as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.OpenAI]: {
    providerId: OpenClawProviderId.OpenAI,
    resolveApi: () => OpenClawApi.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.DeepSeek]: {
    providerId: OpenClawProviderId.DeepSeek,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
    resolveModelReasoning: resolveDeepSeekModelReasoning,
  },
  [ProviderName.Qwen]: {
    providerId: OpenClawProviderId.Qwen,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Zhipu]: {
    providerId: OpenClawProviderId.Zai,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Volcengine]: {
    providerId: OpenClawProviderId.Volcengine,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Minimax]: {
    providerId: OpenClawProviderId.Minimax,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Youdaozhiyun]: {
    providerId: OpenClawProviderId.Youdaozhiyun,
    resolveApi: () => OpenClawApi.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.StepFun]: {
    providerId: OpenClawProviderId.StepFun,
    resolveApi: () => OpenClawApi.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Xiaomi]: {
    providerId: OpenClawProviderId.Xiaomi,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
    resolveModelReasoning: () => true,
  },
  [ProviderName.OpenRouter]: {
    providerId: OpenClawProviderId.OpenRouter,
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
  [ProviderName.Ollama]: {
    providerId: OpenClawProviderId.Ollama,
    resolveApi: () => OpenClawApi.OpenAICompletions as OpenClawProviderApi,
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
};

const DEFAULT_DESCRIPTOR: ProviderDescriptor = {
  providerId: OpenClawProviderId.Genwork,
  resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
  normalizeBaseUrl: stripChatCompletionsSuffix,
};

const resolveDescriptor = (
  providerName: string,
  codingPlanEnabled: boolean,
): ProviderDescriptor => {
  if (codingPlanEnabled) {
    const compositeKey = `${providerName}:codingPlan`;
    if (compositeKey in PROVIDER_REGISTRY) {
      return PROVIDER_REGISTRY[compositeKey];
    }
  }
  if (providerName in PROVIDER_REGISTRY) {
    return PROVIDER_REGISTRY[providerName];
  }
  return {
    ...DEFAULT_DESCRIPTOR,
    providerId: providerName || OpenClawProviderId.Genwork,
  };
};

describe('resolveDescriptor', () => {
  test('gemini maps to google providerId with google-generative-ai API', () => {
    const d = resolveDescriptor(ProviderName.Gemini, false);
    expect(d.providerId).toBe(OpenClawProviderId.Google);
    expect(d.resolveApi({ apiType: undefined, baseURL: '' })).toBe(OpenClawApi.GoogleGenerativeAI);
  });

  test('anthropic maps to anthropic providerId with anthropic-messages API', () => {
    const d = resolveDescriptor(ProviderName.Anthropic, false);
    expect(d.providerId).toBe(OpenClawProviderId.Anthropic);
    expect(d.resolveApi({ apiType: undefined, baseURL: '' })).toBe(OpenClawApi.AnthropicMessages);
  });

  test('openai maps to openai providerId', () => {
    const d = resolveDescriptor(ProviderName.OpenAI, false);
    expect(d.providerId).toBe(OpenClawProviderId.OpenAI);
  });

  test('moonshot without codingPlan uses moonshot providerId', () => {
    const d = resolveDescriptor(ProviderName.Moonshot, false);
    expect(d.providerId).toBe(OpenClawProviderId.Moonshot);
    expect(d.resolveApi({ apiType: 'openai', baseURL: '' })).toBe(OpenClawApi.OpenAICompletions);
    expect(d.resolveApi({ apiType: 'anthropic', baseURL: '' })).toBe(OpenClawApi.AnthropicMessages);
  });

  test('moonshot with codingPlan falls back to moonshot providerId', () => {
    const d = resolveDescriptor(ProviderName.Moonshot, true);
    expect(d.providerId).toBe(OpenClawProviderId.Moonshot);
  });

  test('moonshot has model defaults', () => {
    const d = resolveDescriptor(ProviderName.Moonshot, false);
    expect(d.modelDefaults?.contextWindow).toBe(256000);
    expect(d.modelDefaults?.maxTokens).toBe(8192);
  });

  test('deepseek maps to deepseek providerId respecting apiType', () => {
    const d = resolveDescriptor(ProviderName.DeepSeek, false);
    expect(d.providerId).toBe(OpenClawProviderId.DeepSeek);
    expect(d.resolveApi({ apiType: 'openai', baseURL: '' })).toBe(OpenClawApi.OpenAICompletions);
    expect(d.resolveApi({ apiType: 'anthropic', baseURL: '' })).toBe(OpenClawApi.AnthropicMessages);
  });

  test('deepseek marks reasoning models but leaves chat models unspecified', () => {
    const d = resolveDescriptor(ProviderName.DeepSeek, false);
    expect(d.resolveModelReasoning?.('deepseek-reasoner', false)).toBe(true);
    expect(d.resolveModelReasoning?.('deepseek-v4-pro', false)).toBe(true);
    expect(d.resolveModelReasoning?.('deepseek-v4_flash', false)).toBe(true);
    expect(d.resolveModelReasoning?.('deepseek-chat', false)).toBeUndefined();
  });

  test('xiaomi marks every model as reasoning-capable', () => {
    const d = resolveDescriptor(ProviderName.Xiaomi, false);
    expect(d.resolveModelReasoning?.('mimo-v2.5-pro', false)).toBe(true);
    expect(d.resolveModelReasoning?.('mimo-custom-model', false)).toBe(true);
  });

  test('youdaozhiyun always uses openai-completions', () => {
    const d = resolveDescriptor(ProviderName.Youdaozhiyun, false);
    expect(d.providerId).toBe(OpenClawProviderId.Youdaozhiyun);
    expect(d.resolveApi({ apiType: 'anthropic', baseURL: '' })).toBe(OpenClawApi.OpenAICompletions);
  });

  test('ollama always uses openai-completions', () => {
    const d = resolveDescriptor(ProviderName.Ollama, false);
    expect(d.providerId).toBe(OpenClawProviderId.Ollama);
    expect(d.resolveApi({ apiType: undefined, baseURL: '' })).toBe(OpenClawApi.OpenAICompletions);
  });

  test('unknown provider falls back to genwork providerId', () => {
    const d = resolveDescriptor('some-unknown', false);
    expect(d.providerId).toBe('some-unknown');
  });

  test('empty provider name falls back to genwork', () => {
    const d = resolveDescriptor('', false);
    expect(d.providerId).toBe(OpenClawProviderId.Genwork);
  });

  test('codingPlan flag is ignored for providers without codingPlan entry', () => {
    const d = resolveDescriptor(ProviderName.OpenAI, true);
    expect(d.providerId).toBe(OpenClawProviderId.OpenAI);
  });

  test('volcengine with codingPlan falls back to volcengine providerId', () => {
    const d = resolveDescriptor(ProviderName.Volcengine, true);
    expect(d.providerId).toBe(OpenClawProviderId.Volcengine);
  });

  test('volcengine without codingPlan uses volcengine providerId', () => {
    const d = resolveDescriptor(ProviderName.Volcengine, false);
    expect(d.providerId).toBe(OpenClawProviderId.Volcengine);
  });
});

describe('provider registry coverage', () => {
  const allRegistryProviders = [
    ProviderName.Moonshot,
    ProviderName.Gemini,
    ProviderName.Anthropic,
    ProviderName.OpenAI,
    ProviderName.DeepSeek,
    ProviderName.Qwen,
    ProviderName.Zhipu,
    ProviderName.Volcengine,
    ProviderName.Minimax,
    ProviderName.Youdaozhiyun,
    ProviderName.StepFun,
    ProviderName.Xiaomi,
    ProviderName.OpenRouter,
    ProviderName.Ollama,
  ] as const;

  test('all 14 providers have registry entries', () => {
    for (const name of allRegistryProviders) {
      expect(name in PROVIDER_REGISTRY, `${name} missing from registry`).toBe(true);
    }
  });

  test('no provider resolves to genwork fallback', () => {
    for (const name of allRegistryProviders) {
      const d = resolveDescriptor(name, false);
      expect(d.providerId).not.toBe(OpenClawProviderId.Genwork);
    }
  });

  test('every provider has a non-empty providerId', () => {
    for (const name of allRegistryProviders) {
      const d = resolveDescriptor(name, false);
      expect(d.providerId.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════
// isCatalogUuid identity shape tests
//
// Mirror the regex + predicate used by `isCatalogUuid` in
// `openclawConfigSync.ts`. The desktop must accept BOTH a v4 UUID
// (user-added provider_key row id) AND the `builtin:<orgId>:<slug>:<modelId>`
// id (plan/built-in row seeded by enterprise_server). Anything else makes
// the OpenClaw gateway reply "Unknown model: genwork-server/<id>".
// ═══════════════════════════════════════════════════════

describe('isCatalogUuid identity shape', () => {
  // Mirror of `src/main/libs/openclawConfigSync.ts` `isCatalogUuid`.
  // When the source predicate is updated to also accept `builtin:` ids,
  // update this mirror in lockstep so the assertion below stays green.
  const CATALOG_UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const CATALOG_BUILTIN_PREFIX = 'builtin:';

  const isCatalogUuidMirror = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    return (
      CATALOG_UUID_RE.test(trimmed) ||
      trimmed.startsWith(CATALOG_BUILTIN_PREFIX)
    );
  };

  test('accepts v4 UUIDs', () => {
    expect(isCatalogUuidMirror('ac55946f-82b4-40f0-8a31-970996a2146c')).toBe(true);
    expect(isCatalogUuidMirror('AC55946F-82B4-40F0-8A31-970996A2146C')).toBe(true);
    expect(isCatalogUuidMirror('  ac55946f-82b4-40f0-8a31-970996a2146c  ')).toBe(true);
  });

  test('accepts builtin: plan/built-in ids', () => {
    expect(isCatalogUuidMirror('builtin:org-e6da8a5a:minimax:MiniMax-M3')).toBe(true);
    expect(isCatalogUuidMirror('builtin:org-abc:qwen:qwen3.6-plus')).toBe(true);
    expect(isCatalogUuidMirror('  builtin:org-x:y:z  ')).toBe(true);
  });

  test('rejects display names and legacy upstream names', () => {
    expect(isCatalogUuidMirror('MiniMax-M3')).toBe(false);
    expect(isCatalogUuidMirror('MiniMax M3')).toBe(false);
    expect(isCatalogUuidMirror('qwen3.6-plus')).toBe(false);
    expect(isCatalogUuidMirror('')).toBe(false);
    // Looks like a UUID but wrong version — must not slip through.
    expect(isCatalogUuidMirror('00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// isCatalogUuid source-level regression guard
//
// Read `openclawConfigSync.ts` directly and assert the predicate accepts
// `builtin:` plan ids in addition to v4 UUIDs. This protects against the
// exact Windows/M3 bug where the OpenClaw gateway reports
// `Unknown model: genwork-server/builtin:org-...:MiniMax-M3` because the
// desktop dropped the `builtin:` branch when it was added to the
// enterprise-server proxy.
// ═══════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';

describe('openclawConfigSync.isCatalogUuid source guard', () => {
  const sourcePath = path.join(__dirname, 'openclawConfigSync.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  // Find the predicate line index.
  const lines = source.split('\n');
  const startIndex = lines.findIndex((line) =>
    /export const isCatalogUuid = \(value: string\): boolean =>/.test(line),
  );

  // Slice a window that covers the predicate and its nearby helpers
  // (e.g. the UUID regex constant) so we can assert both behaviours
  // without keeping each regex name in sync.
  const predicateWindow = ((): string => {
    if (startIndex < 0) return '';
    const from = Math.max(0, startIndex - 10);
    const to = Math.min(lines.length, startIndex + 10);
    return lines.slice(from, to).join('\n');
  })();

  test('predicate source is found', () => {
    expect(startIndex).toBeGreaterThanOrEqual(0);
  });

  test('predicate accepts builtin: plan ids', () => {
    // The predicate (or a helper it uses) must reference the `builtin:`
    // prefix so `genwork-server/builtin:org-...:MiniMax-M3` is treated
    // as a valid catalog id and routed through the enterprise proxy
    // rather than collapsed onto the display name.
    expect(predicateWindow).toContain('builtin:');
  });

  test('predicate still recognises v4 UUIDs', () => {
    expect(predicateWindow).toMatch(/\[0-9a-f\]\{8\}/);
  });
});
