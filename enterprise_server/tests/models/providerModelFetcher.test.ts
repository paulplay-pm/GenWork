import '../helpers/setupEnv';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';

import {
  ANTHROPIC_PROVIDERS,
  fetchAnthropicModels,
  fetchGeminiModels,
  fetchOpenAiCompatibleModels,
  fetchProviderModels,
  GEMINI_PROVIDERS,
  isOpenAiCompatible,
  OPENAI_COMPAT_PROVIDERS,
  probeModelsEndpoint,
  __internal,
} from '../../src/models/providerModelFetcher';

const { buildModelsEndpoint } = __internal;

describe('models/providerModelFetcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('isOpenAiCompatible returns true only for the curated set', () => {
    expect(isOpenAiCompatible('openai')).toBe(true);
    expect(isOpenAiCompatible('deepseek')).toBe(true);
    expect(isOpenAiCompatible('qwen')).toBe(true);
    expect(isOpenAiCompatible('anthropic')).toBe(false);
    expect(isOpenAiCompatible('gemini')).toBe(false);
    expect(isOpenAiCompatible('mycorp')).toBe(false);
    expect(OPENAI_COMPAT_PROVIDERS.size).toBeGreaterThan(0);
  });

  describe('buildModelsEndpoint', () => {
    test('appends /v1/models when base has no /v1 suffix', () => {
      expect(buildModelsEndpoint('https://api.deepseek.com')).toBe(
        'https://api.deepseek.com/v1/models'
      );
    });
    test('uses /models (no double /v1) when base already ends in /v1', () => {
      expect(buildModelsEndpoint('https://api.openai.com/v1')).toBe(
        'https://api.openai.com/v1/models'
      );
    });
    test('strips trailing slash before deciding', () => {
      expect(buildModelsEndpoint('https://api.openai.com/v1/')).toBe(
        'https://api.openai.com/v1/models'
      );
    });
  });

  test('returns empty_endpoint when endpoint is empty', async () => {
    const r = await fetchOpenAiCompatibleModels({ endpoint: '', apiKey: 'k' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('empty_endpoint');
  });

  test('returns ok with model ids from OpenAI-shaped response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'o1-mini' }] }),
      }))
    );
    const r = await fetchOpenAiCompatibleModels({
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.models.map((m) => m.id).sort()).toEqual(['gpt-4o', 'o1-mini']);
    }
  });

  test('returns invalid_api_key on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) }))
    );
    const r = await fetchOpenAiCompatibleModels({
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-bad',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_api_key');
  });

  test('returns invalid_api_key on 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 403, ok: false, json: async () => ({}) }))
    );
    const r = await fetchOpenAiCompatibleModels({
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-bad',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_api_key');
  });

  test('returns upstream_error on 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 500, ok: false, json: async () => ({}) }))
    );
    const r = await fetchOpenAiCompatibleModels({
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('upstream_error');
  });

  test('returns upstream_timeout when fetch aborts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            (e as Error & { name: string }).name = 'AbortError';
            reject(e);
          });
        });
      })
    );
    const r = await fetchOpenAiCompatibleModels({
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('upstream_timeout');
  });

  test('handles non-OpenAI body shape (no data field) as empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ models: ['a', 'b'] }),
      }))
    );
    const r = await fetchOpenAiCompatibleModels({
      endpoint: 'https://example.com',
      apiKey: 'k',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.models).toEqual([]);
  });

  describe('Anthropic fetcher', () => {
    test('returns empty_endpoint when endpoint is empty', async () => {
      const r = await fetchAnthropicModels({ endpoint: '', apiKey: 'k' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('empty_endpoint');
    });

    test('uses x-api-key and anthropic-version headers, parses data array', async () => {
      const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        // Headers may be a Headers instance or a plain object — handle both.
        const hdrs = init?.headers as Record<string, string> | undefined;
        const lower: Record<string, string> = {};
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) lower[k.toLowerCase()] = v;
        }
        expect(lower['x-api-key']).toBe('sk-ant-test');
        expect(lower['anthropic-version']).toBe('2023-06-01');
        // Bearer must NOT be used.
        expect(lower['authorization']).toBeUndefined();
        return {
          status: 200,
          ok: true,
          json: async () => ({ data: [{ id: 'claude-3-5-sonnet' }] }),
        };
      });
      vi.stubGlobal('fetch', fakeFetch);
      const r = await fetchAnthropicModels({
        endpoint: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test',
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.models.map((m) => m.id)).toEqual(['claude-3-5-sonnet']);
    });

    test('returns invalid_api_key on 401', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) }))
      );
      const r = await fetchAnthropicModels({
        endpoint: 'https://api.anthropic.com/v1',
        apiKey: 'sk-bad',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('invalid_api_key');
    });

    test('returns upstream_error on 5xx', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ status: 503, ok: false, json: async () => ({}) }))
      );
      const r = await fetchAnthropicModels({
        endpoint: 'https://api.anthropic.com/v1',
        apiKey: 'sk-test',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('upstream_error');
    });

    test('returns upstream_timeout when fetch aborts', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          return await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const e = new Error('aborted');
              (e as Error & { name: string }).name = 'AbortError';
              reject(e);
            });
          });
        })
      );
      const r = await fetchAnthropicModels({
        endpoint: 'https://api.anthropic.com/v1',
        apiKey: 'sk-test',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('upstream_timeout');
    });

    test('malformed JSON body falls through to empty list (parses null, no `data`)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          status: 200,
          ok: true,
          json: async () => {
            throw new Error('bad json');
          },
        }))
      );
      const r = await fetchAnthropicModels({
        endpoint: 'https://api.anthropic.com/v1',
        apiKey: 'sk-test',
      });
      // Matches the OpenAI fetcher's behavior: a 2xx with no parseable body
      // yields an empty model list rather than a hard error. Operators see
      // "0 models" and can investigate; not an upstream_error block.
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.models).toEqual([]);
    });
  });

  describe('Gemini fetcher', () => {
    test('returns empty_endpoint when endpoint is empty', async () => {
      const r = await fetchGeminiModels({ endpoint: '', apiKey: 'k' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('empty_endpoint');
    });

    test('passes api key as query string and strips models/ prefix', async () => {
      const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toContain('/v1beta/models?key=gm-test');
        // Headers must NOT carry the key.
        const hdrs = init?.headers as Record<string, string> | undefined;
        if (hdrs) {
          for (const k of Object.keys(hdrs)) {
            expect(k.toLowerCase()).not.toBe('authorization');
            expect(k.toLowerCase()).not.toBe('x-api-key');
          }
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({
            models: [
              { name: 'models/gemini-1.5-pro' },
              { name: 'models/gemini-1.5-flash' },
            ],
          }),
        };
      });
      vi.stubGlobal('fetch', fakeFetch);
      const r = await fetchGeminiModels({
        endpoint: 'https://generativelanguage.googleapis.com',
        apiKey: 'gm-test',
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.models.map((m) => m.id).sort()).toEqual([
        'gemini-1.5-flash',
        'gemini-1.5-pro',
      ]);
    });

    test('returns invalid_api_key on 403', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ status: 403, ok: false, json: async () => ({}) }))
      );
      const r = await fetchGeminiModels({
        endpoint: 'https://generativelanguage.googleapis.com',
        apiKey: 'bad',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('invalid_api_key');
    });

    test('returns upstream_error on 5xx', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ status: 502, ok: false, json: async () => ({}) }))
      );
      const r = await fetchGeminiModels({
        endpoint: 'https://generativelanguage.googleapis.com',
        apiKey: 'k',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('upstream_error');
    });

    test('returns upstream_timeout when fetch aborts', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          return await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const e = new Error('aborted');
              (e as Error & { name: string }).name = 'AbortError';
              reject(e);
            });
          });
        })
      );
      const r = await fetchGeminiModels({
        endpoint: 'https://generativelanguage.googleapis.com',
        apiKey: 'k',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('upstream_timeout');
    });

    test('non-Gemini body shape (no models array) returns empty list', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          status: 200,
          ok: true,
          json: async () => ({ data: [{ id: 'x' }] }),
        }))
      );
      const r = await fetchGeminiModels({
        endpoint: 'https://generativelanguage.googleapis.com',
        apiKey: 'k',
      });
      // No `models` field → empty list (matches OpenAI fetcher behaviour).
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.models).toEqual([]);
    });
  });

  describe('probeModelsEndpoint', () => {
    test('returns empty_endpoint when endpoint is empty', async () => {
      const r = await probeModelsEndpoint({ endpoint: '', apiKey: 'k' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('empty_endpoint');
    });

    test('parses OpenAI-shaped response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          status: 200,
          ok: true,
          json: async () => ({ data: [{ id: 'custom-1' }, { id: 'custom-2' }] }),
        }))
      );
      const r = await probeModelsEndpoint({
        endpoint: 'https://gateway.internal/v1',
        apiKey: 'k',
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.models.map((m) => m.id).sort()).toEqual(['custom-1', 'custom-2']);
    });

    test('non-OpenAI body becomes upstream_error with detail', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          status: 200,
          ok: true,
          json: async () => ({ models: ['x'] }),
        }))
      );
      const r = await probeModelsEndpoint({
        endpoint: 'https://gateway.internal',
        apiKey: 'k',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe('upstream_error');
        expect(r.detail).toContain('data');
      }
    });

    test('invalid_api_key on 401', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) }))
      );
      const r = await probeModelsEndpoint({
        endpoint: 'https://gateway.internal',
        apiKey: 'k',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('invalid_api_key');
    });
  });

  describe('fetchProviderModels dispatcher', () => {
    test('routes openai-compatible provider to fetchOpenAiCompatibleModels', async () => {
      const fakeFetch = vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }] }),
      }));
      vi.stubGlobal('fetch', fakeFetch);
      const r = await fetchProviderModels({
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'k',
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.models.map((m) => m.id)).toEqual(['gpt-4o']);
    });

    test('routes anthropic to fetchAnthropicModels (uses x-api-key header)', async () => {
      const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const hdrs = init?.headers as Record<string, string> | undefined;
        expect(hdrs?.['x-api-key']).toBe('sk-ant');
        return {
          status: 200,
          ok: true,
          json: async () => ({ data: [{ id: 'claude-3-5-haiku' }] }),
        };
      });
      vi.stubGlobal('fetch', fakeFetch);
      const r = await fetchProviderModels({
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant',
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.models.map((m) => m.id)).toEqual(['claude-3-5-haiku']);
    });

    test('routes gemini to fetchGeminiModels (uses query-string key)', async () => {
      const fakeFetch = vi.fn(async (url: string) => {
        expect(url).toContain('?key=gm-key');
        return {
          status: 200,
          ok: true,
          json: async () => ({ models: [{ name: 'models/gemini-1.5-pro' }] }),
        };
      });
      vi.stubGlobal('fetch', fakeFetch);
      const r = await fetchProviderModels({
        provider: 'gemini',
        endpoint: 'https://generativelanguage.googleapis.com',
        apiKey: 'gm-key',
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.models.map((m) => m.id)).toEqual(['gemini-1.5-pro']);
    });

    test('unknown provider falls back to probeModelsEndpoint', async () => {
      const fakeFetch = vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ data: [{ id: 'custom-1' }] }),
      }));
      vi.stubGlobal('fetch', fakeFetch);
      const r = await fetchProviderModels({
        provider: 'mycorp',
        endpoint: 'https://gateway.internal/v1',
        apiKey: 'k',
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.models.map((m) => m.id)).toEqual(['custom-1']);
    });

    test('curated provider sets are non-empty', () => {
      expect(ANTHROPIC_PROVIDERS.size).toBeGreaterThan(0);
      expect(GEMINI_PROVIDERS.size).toBeGreaterThan(0);
      expect(OPENAI_COMPAT_PROVIDERS.size).toBeGreaterThan(0);
    });
  });

  describe('fetchProviderModels protocol dispatch', () => {
    function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
      const f = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
      vi.stubGlobal('fetch', f);
      return f;
    }
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const modelsResponse = (id: string) =>
      new Response(JSON.stringify({ data: [{ id }]}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    test('protocol=anthropic uses x-api-key, not Bearer', async () => {
      const f = stubFetch(() => modelsResponse('claude-sonnet-4'));
      const res = await fetchProviderModels({
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com',
        apiKey: 'sk-ant-1',
        protocol: 'anthropic',
      });
      expect(res.ok).toBe(true);
      const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-1');
      expect(headers['authorization']).toBeUndefined();
    });

    test('protocol=openai uses Bearer', async () => {
      const f = stubFetch(() => modelsResponse('gpt-4o'));
      const res = await fetchProviderModels({
        provider: 'my-vllm',
        endpoint: 'https://vllm.example/v1',
        apiKey: 'sk-bearer',
        protocol: 'openai',
      });
      expect(res.ok).toBe(true);
      const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer sk-bearer');
    });

    test('no protocol falls back to slug sets (anthropic slug -> x-api-key)', async () => {
      const f = stubFetch(() => modelsResponse('claude'));
      await fetchProviderModels({
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com',
        apiKey: 'k',
      });
      const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('k');
    });

    // Discriminating cases: the explicit protocol must OVERRIDE the slug-set
    // routing. (The three cases above pass both before and after the change,
    // because those slug/protocol combos already produced the same wire
    // format via the legacy slug routing.)
    test('protocol=openai overrides anthropic slug (Bearer, not x-api-key)', async () => {
      const f = stubFetch(() => modelsResponse('claude'));
      const res = await fetchProviderModels({
        provider: 'anthropic',
        endpoint: 'https://api.anthropic.com',
        apiKey: 'sk-ant-1',
        protocol: 'openai',
      });
      expect(res.ok).toBe(true);
      const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer sk-ant-1');
      expect(headers['x-api-key']).toBeUndefined();
    });

    test('protocol=anthropic overrides openai slug (x-api-key, not Bearer)', async () => {
      const f = stubFetch(() => modelsResponse('gpt-4o'));
      const res = await fetchProviderModels({
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'sk-oi',
        protocol: 'anthropic',
      });
      expect(res.ok).toBe(true);
      const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-oi');
      expect(headers['authorization']).toBeUndefined();
    });
  });
});
