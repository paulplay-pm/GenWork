import { describe, expect, test, beforeEach, vi } from 'vitest';

// Mock enterpriseClient.getCatalog so the resolver is testable without a server.
const getCatalogMock = vi.fn();
vi.mock('../src/main/auth/enterpriseClient', () => ({
  enterpriseClient: { getCatalog: (...args: unknown[]) => getCatalogMock(...args) },
}));

import { catalogResolver, type CatalogModel } from '../src/main/libs/catalogResolver';

const MODEL: CatalogModel = {
  id: 'm1', provider: 'deepseek', model: 'deepseek-chat', displayName: 'DeepSeek Chat',
  quotaPerUserPerDay: 500, enabled: true, supportsImage: false, supportsVideo: false,
  supportsThinking: true, contextWindow: 128000, maxTokens: 8192,
};

describe('catalogResolver', () => {
  beforeEach(() => {
    getCatalogMock.mockReset();
    // The resolver caches internally; expose a reset for tests.
    (catalogResolver as unknown as { _reset: () => void })._reset();
  });

  test('lookupModel finds a model by (provider, modelId)', async () => {
    getCatalogMock.mockResolvedValueOnce({ providers: [], models: [MODEL] });
    await catalogResolver.refresh();
    expect(catalogResolver.lookupModel('deepseek', 'deepseek-chat')?.id).toBe('m1');
    expect(catalogResolver.lookupModel('deepseek', 'missing')).toBeUndefined();
  });

  test('resolveCapability returns defaults for an unknown model', async () => {
    getCatalogMock.mockResolvedValueOnce({ providers: [], models: [MODEL] });
    await catalogResolver.refresh();
    expect(catalogResolver.resolveCapability('deepseek', 'deepseek-chat')).toEqual({
      supportsImage: false, supportsVideo: false, supportsThinking: true,
      contextWindow: 128000, maxTokens: 8192,
    });
    expect(catalogResolver.resolveCapability('nope', 'nope')).toEqual({
      supportsImage: false, supportsVideo: false, supportsThinking: false,
      contextWindow: null, maxTokens: null,
    });
  });

  test('refresh failure leaves an empty catalog (no throw)', async () => {
    getCatalogMock.mockRejectedValueOnce(new Error('down'));
    await catalogResolver.refresh();
    expect(catalogResolver.listModels()).toEqual([]);
  });
});
