/**
 * Unit tests for enterprise raw-API routing.
 *
 * Desktop LLM access must route uniformly through the multi-tenant proxy
 * (${ENTERPRISE_SERVER_URL}/proxy/<provider> + the user's JWT). It must
 * NEVER emit a raw upstream config (the catalog's getEndpoint() URL) with a
 * ${GENWORK_APIKEY_X} placeholder — doing so bypasses the proxy and the
 * per-org allowlist, producing 404 "model_not_found" (and, before the fix,
 * could leave a dangling placeholder with no backing env var → gateway
 * SecretRefResolutionError crash loop).
 *
 * The invariant under test:
 *   resolveRawApiConfig() resolves an enterprise model
 *     => it uses the proxy baseURL (not the raw upstream endpoint) with the
 *        user JWT as the apiKey; and
 *   when the proxy is unavailable (no ENTERPRISE_SERVER_URL / no session JWT)
 *     => it returns config: null rather than a raw upstream config.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mock electron so claudeSettings' import chain loads in Node.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp',
  },
}));

// sessionStorage.load() is read by tryEnterpriseCatalogFallback to obtain
// the user JWT for the enterprise `/proxy/<provider>` Authorization header.
// Default to a non-empty session so the function returns a MatchedProvider;
// tests that want to exercise the missing-session branch clear the mock via
// sessionState.clear().
const sessionState = vi.hoisted(() => ({
  jwt: 'test-enterprise-jwt',
}));
vi.mock('../auth/sessionStorage', () => ({
  sessionStorage: {
    configure: () => {},
    clear: () => {},
    load: () => ({
      userId: 'u-1',
      orgId: 'org-d8e4966a',
      username: 'tester',
      displayName: 'Tester',
      roles: [],
      jwt: sessionState.jwt,
      expiresAt: Date.now() + 60 * 60 * 1000,
    }),
    save: () => {},
  },
}));

// Controllable in-memory enterprise catalog. Mirrors the real cache API.
const cacheState = vi.hoisted(() => ({
  active: null as string | null,
  entries: new Map<
    string,
    {
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
      apiKey: string | null;
    }
  >(),
}));

// Controllable last-selected-model-id state. Mirrors enterpriseModelPrefs.
const prefsState = vi.hoisted(() => ({
  lastSelected: null as string | null,
}));

vi.mock('../auth/enterpriseModelCache', () => ({
  enterpriseModelCache: {
    load: vi.fn(async () => {
      const active = cacheState.active;
      const list = listCache();
      return { models: list, activeModelId: active };
    }),
    list: listCache,
    isEmpty: () => cacheState.entries.size === 0,
    getApiKey: (id: string) => cacheState.entries.get(id)?.apiKey ?? null,
    getEndpoint: (id: string) => cacheState.entries.get(id)?.endpoint ?? null,
    setActive: (id: string) => {
      if (!cacheState.entries.has(id)) throw new Error(`unknown modelId: ${id}`);
      cacheState.active = id;
    },
    getActive: () => cacheState.active,
    wipe: () => {
      cacheState.entries = new Map();
      cacheState.active = null;
    },
  },
}));

function listCache() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return [...cacheState.entries.values()].map(({ apiKey, ...rest }) => rest);
}

vi.mock('../auth/enterpriseModelPrefs', () => ({
  enterpriseModelPrefs: {
    configure: vi.fn(),
    readLastSelectedModelId: () => prefsState.lastSelected,
    writeLastSelectedModelId: (id: string | null) => {
      prefsState.lastSelected = id;
    },
  },
}));

import { resolveAllProviderApiKeys, resolveRawApiConfig, setStoreGetter, tryEnterpriseCatalogFallback } from './claudeSettings';

// app_config with NO `providers` key forces the local-config path to fail
// (matched === null) and reach the enterprise fallback branch.
const enterpriseAppConfig = {
  model: {
    defaultModel: '21e3e29a-a900-4574-b1bd-aaa8fb803ff1',
    defaultModelProvider: 'genwork-server',
  },
} as const;

// The REAL on-disk app_config after an enterprise login + config-sync round
// trip: a hollow `genwork-server` local provider (empty key, no models)
// plus the enterprise default model. This is the exact shape that crashed the
// gateway — the hollow entry makes resolveAllProviderApiKeys take the local
// branch and skip, while resolveRawApiConfig falls to the enterprise branch.
const enterpriseAppConfigWithHollowProvider = {
  model: {
    defaultModel: '21e3e29a-a900-4574-b1bd-aaa8fb803ff1',
    defaultModelProvider: 'genwork-server',
  },
  providers: {
    'genwork-server': {
      enabled: true,
      apiKey: '',
      baseUrl: '',
      models: [],
    },
  },
} as const;

function setupStore(appConfig: unknown = enterpriseAppConfig): void {
  const store = { get: vi.fn((key: string) => (key === 'app_config' ? appConfig : null)) };
  setStoreGetter(() => store);
}

function resetCache(): void {
  cacheState.active = null;
  cacheState.entries = new Map();
  prefsState.lastSelected = null;
}

beforeEach(() => {
  resetCache();
  setupStore();
});

describe('resolveRawApiConfig enterprise routing (proxy, never raw upstream)', () => {
  const origEnv = process.env.ENTERPRISE_SERVER_URL;
  const ACTIVE_ID = '21e3e29a-a900-4574-b1bd-aaa8fb803ff1';

  beforeEach(() => {
    process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
    sessionState.jwt = 'test-enterprise-jwt';
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.ENTERPRISE_SERVER_URL;
    } else {
      process.env.ENTERPRISE_SERVER_URL = origEnv;
    }
    sessionState.jwt = 'test-enterprise-jwt';
  });

  const seedActiveModel = (overrides: {
    provider?: string;
    apiKey?: string | null;
    endpoint?: string | null;
  } = {}) => {
    cacheState.entries.set(ACTIVE_ID, {
      id: ACTIVE_ID,
      provider: 'deepseek',
      model: 'deepseek-flash',
      displayName: null,
      endpoint: 'https://api.deepseek.com',
      capabilities: {
        supports_image: true,
        supports_video: true,
        supports_thinking: true,
        context_window: 1111111,
        max_tokens: 2,
      },
      quotaPerDay: null,
      apiKey: 'sk-real-deepseek-key',
      ...overrides,
    });
    cacheState.active = ACTIVE_ID;
  };

  test('routes a resolvable enterprise model through the proxy, never the raw upstream', () => {
    seedActiveModel();
    const raw = resolveRawApiConfig();

    expect(raw.config).not.toBeNull();
    // Proxy baseURL with the active model's provider segment.
    expect(raw.config?.baseURL).toBe('https://ent.example/proxy/deepseek');
    // User JWT as the bearer (the proxy substitutes the org key upstream).
    expect(raw.config?.apiKey).toBe('test-enterprise-jwt');
    // Catalog UUID as the model id (desktop identity).
    expect(raw.config?.model).toBe(ACTIVE_ID);
    // Never the raw upstream endpoint, never a dangling placeholder.
    expect(raw.config?.baseURL).not.toContain('api.deepseek.com');
    expect(raw.config?.apiKey).not.toMatch(/^\$\{GENWORK_APIKEY_/);
  });

  test('returns null (no raw upstream config) when the session JWT is absent', () => {
    seedActiveModel();
    sessionState.jwt = '';
    const raw = resolveRawApiConfig();

    // No JWT → the proxy path is unusable. We must NOT fall back to the raw
    // catalog endpoint: that bypasses the proxy + per-org allowlist and 404s.
    expect(raw.config).toBeNull();
    expect(raw.config?.baseURL ?? '').not.toContain('api.deepseek.com');
  });

  test('returns null (no raw upstream config) when ENTERPRISE_SERVER_URL is unset', () => {
    seedActiveModel();
    delete process.env.ENTERPRISE_SERVER_URL;
    const raw = resolveRawApiConfig();

    expect(raw.config).toBeNull();
    expect(raw.config?.baseURL ?? '').not.toContain('api.deepseek.com');
  });

  test('routes through the proxy even when a hollow genwork-server local provider exists', () => {
    setupStore(enterpriseAppConfigWithHollowProvider);
    seedActiveModel();
    const raw = resolveRawApiConfig();

    expect(raw.config?.baseURL).toBe('https://ent.example/proxy/deepseek');
    expect(raw.config?.apiKey).toBe('test-enterprise-jwt');
  });

  test('still collects the catalog API key for env injection (collector unchanged)', () => {
    seedActiveModel();
    const env = resolveAllProviderApiKeys();
    // Keyed by the bare env suffix (DEEPSEEK); the GENWORK_APIKEY_ prefix is
    // applied downstream in collectSecretEnvVars.
    expect(env.DEEPSEEK).toBe('sk-real-deepseek-key');
  });
});

describe('tryEnterpriseCatalogFallback', () => {
  const origEnv = process.env.ENTERPRISE_SERVER_URL;

  const seedEntry = (id: string, provider: string, overrides: {
    apiKey?: string | null;
    endpoint?: string | null;
    displayName?: string | null;
    supportsThinking?: boolean;
  } = {}) => {
    cacheState.entries.set(id, {
      id,
      provider,
      model: id,
      displayName: overrides.displayName ?? id,
      endpoint: overrides.endpoint === undefined ? `https://upstream.example/v1` : overrides.endpoint,
      capabilities: {
        supports_image: false,
        supports_video: false,
        supports_thinking: overrides.supportsThinking ?? false,
        context_window: 8000,
        max_tokens: 4000,
      },
      quotaPerDay: null,
      apiKey: overrides.apiKey === undefined ? 'sk-test-1234' : overrides.apiKey,
    });
  };

  beforeEach(() => {
    process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.ENTERPRISE_SERVER_URL;
    } else {
      process.env.ENTERPRISE_SERVER_URL = origEnv;
    }
  });

  test('returns null when ENTERPRISE_SERVER_URL is unset', () => {
    delete process.env.ENTERPRISE_SERVER_URL;
    seedEntry('m-a', 'openai');
    expect(tryEnterpriseCatalogFallback('m-a')).toBeNull();
  });

  test('returns null when the catalog is empty', () => {
    // No entries seeded.
    expect(tryEnterpriseCatalogFallback('m-a')).toBeNull();
  });

  test('returns the requested modelId match when present in the catalog', () => {
    seedEntry('m-a', 'openai');
    seedEntry('m-b', 'openai');
    const match = tryEnterpriseCatalogFallback('m-b');
    expect(match).not.toBeNull();
    expect(match?.modelId).toBe('m-b');
    expect(match?.providerName).toBe('genwork-server');
    expect(match?.runtimeProfile).toBe('enterprise');
  });

  test('falls back to lastSelectedModelId when modelId is empty and lastSelected is known', () => {
    seedEntry('m-a', 'openai');
    seedEntry('m-b', 'openai');
    prefsState.lastSelected = 'm-a';
    const match = tryEnterpriseCatalogFallback('');
    expect(match?.modelId).toBe('m-a');
  });

  test('falls back to entries[0] when no modelId and no lastSelected is present', () => {
    seedEntry('m-a', 'openai');
    seedEntry('m-b', 'openai');
    const match = tryEnterpriseCatalogFallback('');
    expect(match?.modelId).toBe('m-a');
  });

  test('returns null when getApiKey returns null (server-disabled key)', () => {
    seedEntry('m-a', 'openai', { apiKey: null });
    expect(tryEnterpriseCatalogFallback('m-a')).toBeNull();
  });

  test('returns null when getEndpoint returns null', () => {
    seedEntry('m-a', 'openai', { endpoint: null });
    expect(tryEnterpriseCatalogFallback('m-a')).toBeNull();
  });
});
