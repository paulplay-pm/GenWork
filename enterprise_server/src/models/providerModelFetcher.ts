/**
 * Provider model-list fetcher. Hits provider-specific model-list endpoints and
 * returns the list of model ids the provider exposes.
 *
 * Provider routing:
 * - An explicit `protocol` (`'openai' | 'anthropic'`, from `provider_keys.protocol`)
 *   always wins over the slug sets below.
 * - `OPENAI_COMPAT_PROVIDERS`: OpenAI-shaped `GET {base}/v1/models` with Bearer auth.
 * - `ANTHROPIC_PROVIDERS`: `GET {base}/v1/models` with `x-api-key` + `anthropic-version` headers.
 * - `GEMINI_PROVIDERS`: `GET {base}/v1beta/models?key=...` (Google's API key as query string).
 * - Anything else falls back to `probeModelsEndpoint`, which attempts the OpenAI
 *   shape; callers can plug in custom base URLs (e.g. internal gateways).
 *
 * Error model: a single non-throwing result envelope so route handlers
 * can map it onto an HTTP response without try/catch noise.
 */

const FETCH_TIMEOUT_MS = 10_000;

/** Provider ids whose `/v1/models` endpoint follows the OpenAI shape. */
export const OPENAI_COMPAT_PROVIDERS = new Set<string>([
  'openai',
  'deepseek',
  'moonshot',
  'qwen',
  'zhipu',
  'xai',
]);

/** Provider ids that use Anthropic's `GET /v1/models` shape. */
export const ANTHROPIC_PROVIDERS = new Set<string>(['anthropic']);

/** Provider ids that use Gemini's `GET /v1beta/models?key=...` shape. */
export const GEMINI_PROVIDERS = new Set<string>(['gemini']);

export function isOpenAiCompatible(provider: string): boolean {
  return OPENAI_COMPAT_PROVIDERS.has(provider);
}

export interface FetchResultOk {
  ok: true;
  models: { id: string }[];
}

export interface FetchResultErr {
  ok: false;
  error: 'invalid_api_key' | 'upstream_timeout' | 'upstream_error' | 'empty_endpoint';
  detail?: string;
}

export type FetchResult = FetchResultOk | FetchResultErr;

interface ProviderModelFetcherInput {
  /** Fully-qualified URL, e.g. `https://api.openai.com/v1/models`. */
  endpoint: string;
  apiKey: string;
}

/**
 * Build the `/v1/models` URL from a base URL. The base may or may not
 * end in `/v1` (e.g. `https://api.openai.com/v1` vs `https://api.deepseek.com`).
 * We normalize by stripping a trailing `/v1` before appending `/v1/models`,
 * so callers can pass either form.
 */
function buildModelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  return /\/v1$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

/** Call `GET {endpoint}` with Bearer auth. Never throws. */
export async function fetchOpenAiCompatibleModels(
  input: ProviderModelFetcherInput
): Promise<FetchResult> {
  if (!input.endpoint) {
    return { ok: false, error: 'empty_endpoint' };
  }
  const url = buildModelsEndpoint(input.endpoint);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'invalid_api_key', detail: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, error: 'upstream_error', detail: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as
      | { data?: Array<{ id?: unknown }> | null }
      | null;
    const list = Array.isArray(body?.data) ? body!.data! : [];
    const models: { id: string }[] = [];
    for (const m of list) {
      if (typeof m?.id === 'string' && m.id.length > 0) models.push({ id: m.id });
    }
    return { ok: true, models };
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') {
      return { ok: false, error: 'upstream_timeout' };
    }
    return {
      ok: false,
      error: 'upstream_error',
      detail: (e as Error)?.message ?? 'fetch failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

export const __internal = { buildModelsEndpoint };

/**
 * Dispatcher: route to the right fetcher. An explicit `protocol` (from the
 * `provider_keys.protocol` column) always wins; without one, fall back to the
 * provider-slug sets, then to `probeModelsEndpoint` (OpenAI shape probe) for
 * unknown providers — handy for internal gateways and custom base URLs.
 */
export async function fetchProviderModels(input: {
  provider: string;
  endpoint: string;
  apiKey: string;
  protocol?: 'openai' | 'anthropic';
}): Promise<FetchResult> {
  if (input.protocol === 'anthropic') return fetchAnthropicModels(input);
  if (input.protocol === 'openai') return fetchOpenAiCompatibleModels(input);
  // Legacy fallback for rows without an explicit protocol (pre-031).
  if (OPENAI_COMPAT_PROVIDERS.has(input.provider)) return fetchOpenAiCompatibleModels(input);
  if (ANTHROPIC_PROVIDERS.has(input.provider)) return fetchAnthropicModels(input);
  if (GEMINI_PROVIDERS.has(input.provider)) return fetchGeminiModels(input);
  return probeModelsEndpoint(input);
}

/** Anthropic uses `x-api-key` + `anthropic-version` headers (no Bearer). */
export async function fetchAnthropicModels(
  input: ProviderModelFetcherInput
): Promise<FetchResult> {
  if (!input.endpoint) {
    return { ok: false, error: 'empty_endpoint' };
  }
  const url = buildModelsEndpoint(input.endpoint);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': input.apiKey,
        'anthropic-version': '2023-06-01',
        accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'invalid_api_key', detail: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, error: 'upstream_error', detail: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as
      | { data?: Array<{ id?: unknown }> | null }
      | null;
    const list = Array.isArray(body?.data) ? body!.data! : [];
    const models: { id: string }[] = [];
    for (const m of list) {
      if (typeof m?.id === 'string' && m.id.length > 0) models.push({ id: m.id });
    }
    return { ok: true, models };
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') {
      return { ok: false, error: 'upstream_timeout' };
    }
    return {
      ok: false,
      error: 'upstream_error',
      detail: (e as Error)?.message ?? 'fetch failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Gemini requires the API key as a query parameter, not a header. */
export async function fetchGeminiModels(
  input: ProviderModelFetcherInput
): Promise<FetchResult> {
  if (!input.endpoint) {
    return { ok: false, error: 'empty_endpoint' };
  }
  const trimmed = input.endpoint.trim().replace(/\/$/, '');
  const url = `${trimmed}/v1beta/models?key=${encodeURIComponent(input.apiKey)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'invalid_api_key', detail: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, error: 'upstream_error', detail: `HTTP ${res.status}` };
    }
    // Gemini returns { models: [{ name: "models/gemini-1.5-pro", ... }] }.
    const body = (await res.json().catch(() => null)) as
      | { models?: Array<{ name?: unknown }> | null }
      | null;
    const list = Array.isArray(body?.models) ? body!.models! : [];
    const models: { id: string }[] = [];
    for (const m of list) {
      if (typeof m?.name === 'string' && m.name.length > 0) {
        // Gemini prefixes with "models/" — strip it so downstream code sees
        // a bare model id (consistent with OpenAI/Anthropic shapes).
        const id = m.name.replace(/^models\//, '');
        if (id.length > 0) models.push({ id });
      }
    }
    return { ok: true, models };
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') {
      return { ok: false, error: 'upstream_timeout' };
    }
    return {
      ok: false,
      error: 'upstream_error',
      detail: (e as Error)?.message ?? 'fetch failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generic probe: try OpenAI shape against any base URL. Useful for internal
 * gateways that implement the OpenAI shape under a custom provider id.
 * If the response shape is not OpenAI, we return `upstream_error` rather than
 * silently treating unknown shapes as empty — empty lists hide integration bugs.
 */
export async function probeModelsEndpoint(
  input: ProviderModelFetcherInput
): Promise<FetchResult> {
  if (!input.endpoint) {
    return { ok: false, error: 'empty_endpoint' };
  }
  const url = buildModelsEndpoint(input.endpoint);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'invalid_api_key', detail: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, error: 'upstream_error', detail: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as
      | { data?: Array<{ id?: unknown }> | null }
      | null;
    if (!body || !Array.isArray(body.data)) {
      return {
        ok: false,
        error: 'upstream_error',
        detail: 'response body is not OpenAI-shaped (no `data` array)',
      };
    }
    const models: { id: string }[] = [];
    for (const m of body.data) {
      if (typeof m?.id === 'string' && m.id.length > 0) models.push({ id: m.id });
    }
    return { ok: true, models };
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') {
      return { ok: false, error: 'upstream_timeout' };
    }
    return {
      ok: false,
      error: 'upstream_error',
      detail: (e as Error)?.message ?? 'fetch failed',
    };
  } finally {
    clearTimeout(timer);
  }
}
