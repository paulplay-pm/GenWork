import { beforeEach,describe, expect, test, vi } from 'vitest';

// Isolate the pure lookup logic. The real module pulls in electron-log
// (../logger), the heavy claudeSettings chain (../libs/claudeSettings) and
// the network client (./enterpriseClient); mock all three so only the
// in-memory cache behaviour under test is exercised.
vi.mock('../libs/claudeSettings', () => ({
  setServerModelMetadata: vi.fn(),
  clearServerModelMetadata: vi.fn(),
}));
vi.mock('../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./enterpriseClient', () => ({
  enterpriseClient: {
    listEnterpriseModels: vi.fn(),
    orgId: 'org-test',
  },
}));

import { enterpriseClient } from './enterpriseClient';
import { enterpriseModelCache } from './enterpriseModelCache';

const listModels = vi.mocked(enterpriseClient.listEnterpriseModels);

const FIXTURE = [
  {
    id: 'uuid-1',
    provider: 'vllm',
    model: 'Qwen3.8-27B',
    displayName: null,
    endpoint: 'https://vllm.iepose.cn/v1/',
    capabilities: {
      supports_image: false,
      supports_video: false,
      supports_thinking: true,
      context_window: 32768,
      max_tokens: 8192,
    },
    quotaPerDay: null,
    apiKey: 'P2a0u0l0',
  },
  {
    id: 'uuid-2',
    provider: 'openai',
    model: 'gpt-4o',
    displayName: 'GPT-4o',
    endpoint: 'https://api.openai.com/v1',
    capabilities: {
      supports_image: true,
      supports_video: false,
      supports_thinking: false,
      context_window: null,
      max_tokens: null,
    },
    quotaPerDay: 100,
    apiKey: 'sk-openai',
  },
];

function loadWith(models: unknown[]): Promise<unknown> {
  listModels.mockResolvedValue({ models } as { models: never[] });
  return enterpriseModelCache.load();
}

beforeEach(async () => {
  // Reset to a known-empty cache.
  await loadWith([]);
});

describe('enterpriseModelCache name-based send-time resolution', () => {
  test('resolveForSendByModelName resolves an enterprise model by upstream name', async () => {
    await loadWith(FIXTURE);

    const resolved = enterpriseModelCache.resolveForSendByModelName('Qwen3.8-27B');
    expect(resolved).not.toBeNull();
    expect(resolved?.apiKey).toBe('P2a0u0l0');
    expect(resolved?.endpoint).toBe('https://vllm.iepose.cn/v1/');
  });

  test('resolveForSendByModelName returns null for a non-enterprise name (gate no-op)', async () => {
    await loadWith(FIXTURE);

    expect(enterpriseModelCache.resolveForSendByModelName('totally-unrelated')).toBeNull();
  });

  test('resolveForSendByModelName throws when the name is enterprise-managed but the key is missing', async () => {
    const broken = FIXTURE.map((m) => (m.model === 'Qwen3.8-27B' ? { ...m, apiKey: null } : m));
    await loadWith(broken);

    expect(() => enterpriseModelCache.resolveForSendByModelName('Qwen3.8-27B')).toThrow(
      /Qwen3\.8-27B not configured for org/,
    );
  });

  test('resolveForSendByModelName returns null when the catalog is empty', () => {
    // Empty catalog already loaded in beforeEach.
    expect(enterpriseModelCache.resolveForSendByModelName('Qwen3.8-27B')).toBeNull();
  });

  test('getByModelName returns the cached entry and null on a miss', async () => {
    await loadWith(FIXTURE);

    const hit = enterpriseModelCache.getByModelName('gpt-4o');
    expect(hit?.id).toBe('uuid-2');
    expect(hit?.provider).toBe('openai');
    expect(enterpriseModelCache.getByModelName('nope')).toBeNull();
  });

  test('UUID-based resolveForSend is unaffected (still keyed by catalog id)', async () => {
    await loadWith(FIXTURE);

    // The name does NOT resolve by UUID; the UUID still does.
    expect(enterpriseModelCache.resolveForSend('uuid-1').apiKey).toBe('P2a0u0l0');
    expect(() => enterpriseModelCache.resolveForSend('Qwen3.8-27B')).toThrow();
  });
});

describe('enterpriseModelCache ref-portion canonicalization (UUID-first, name fallback)', () => {
  // The send/run gates and the OpenClaw ref canonicalizer address enterprise
  // models by the ref's model portion, which is the catalog UUID for new refs
  // but the upstream name for legacy (pre-UUID) refs. `canonicalModelId` maps
  // either to the catalog UUID; `resolveForSendRef` validates key/endpoint on
  // top of that.
  test('canonicalModelId returns a known catalog UUID as-is', async () => {
    await loadWith(FIXTURE);
    expect(enterpriseModelCache.canonicalModelId('uuid-1')).toBe('uuid-1');
    expect(enterpriseModelCache.canonicalModelId('uuid-2')).toBe('uuid-2');
  });

  test('canonicalModelId resolves a unique upstream name to its catalog UUID', async () => {
    await loadWith(FIXTURE);
    // 'Qwen3.8-27B' is unique in this catalog → resolves to its row's id.
    expect(enterpriseModelCache.canonicalModelId('Qwen3.8-27B')).toBe('uuid-1');
    expect(enterpriseModelCache.canonicalModelId('gpt-4o')).toBe('uuid-2');
  });

  test('canonicalModelId returns null for an unknown portion', async () => {
    await loadWith(FIXTURE);
    expect(enterpriseModelCache.canonicalModelId('totally-unrelated')).toBeNull();
  });

  test('canonicalModelId returns null when the name is ambiguous (two same-name rows)', async () => {
    // Two rows share the upstream name 'Qwen3.8-27B' but have distinct UUIDs.
    // A legacy name ref cannot pick one deterministically, so it is ambiguous.
    const twoSameName = [
      { ...FIXTURE[0], id: 'uuid-a' },
      { ...FIXTURE[0], id: 'uuid-b' },
    ];
    await loadWith(twoSameName);
    expect(enterpriseModelCache.canonicalModelId('Qwen3.8-27B')).toBeNull();
    // ...but each UUID still resolves.
    expect(enterpriseModelCache.canonicalModelId('uuid-a')).toBe('uuid-a');
    expect(enterpriseModelCache.canonicalModelId('uuid-b')).toBe('uuid-b');
  });

  test('resolveForSendRef resolves a UUID portion to key+endpoint', async () => {
    await loadWith(FIXTURE);
    const resolved = enterpriseModelCache.resolveForSendRef('uuid-1');
    expect(resolved?.apiKey).toBe('P2a0u0l0');
    expect(resolved?.endpoint).toBe('https://vllm.iepose.cn/v1/');
  });

  test('resolveForSendRef resolves a legacy name portion to key+endpoint', async () => {
    await loadWith(FIXTURE);
    // Legacy name ref 'Qwen3.8-27B' → canonical UUID → key/endpoint.
    const resolved = enterpriseModelCache.resolveForSendRef('Qwen3.8-27B');
    expect(resolved?.apiKey).toBe('P2a0u0l0');
    expect(resolved?.endpoint).toBe('https://vllm.iepose.cn/v1/');
  });

  test('resolveForSendRef returns null for a portion not in the catalog (gate no-op)', async () => {
    await loadWith(FIXTURE);
    // A model portion that matches no enterprise row → the gate is a no-op.
    expect(enterpriseModelCache.resolveForSendRef('not-in-catalog')).toBeNull();
  });

  test('resolveForSendRef throws when the portion is enterprise-managed but the key is missing', async () => {
    const broken = FIXTURE.map((m) => (m.id === 'uuid-1' ? { ...m, apiKey: null } : m));
    await loadWith(broken);
    expect(() => enterpriseModelCache.resolveForSendRef('uuid-1')).toThrow(
      /not configured for org/,
    );
  });
});
