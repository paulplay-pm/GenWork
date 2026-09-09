/** Brand metadata for the 9 PRD built-in providers (rail brand-square colors +
 * the built-in slug set). Model data is DB-sourced now (see
 * `src/org/builtinProviders.ts`); this file only drives the rail's brand
 * colors and exposes the built-in slug list. */
export const BUILTIN_SLUGS = [
  'openai',
  'anthropic',
  'deepseek',
  'moonshot',
  'qwen',
  'zhipu',
  'minimax',
  'xiaomi',
  'volc',
] as const;
export const BRAND_COLORS: Record<string, string> = {
  openai: '#10A37F',
  anthropic: '#D97757',
  deepseek: '#4D6BFE',
  moonshot: '#1F2329',
  qwen: '#615CED',
  zhipu: '#3B5BFE',
  minimax: '#E63946',
  xiaomi: '#FF6900',
  volc: '#0D8AFF',
};
export function brandColor(slug: string): string {
  return BRAND_COLORS[slug] ?? '#6B7280';
}

/**
 * Per-provider Base URL catalog (reference UI / PRD). For each built-in slug
 * the default OpenAI-compatible Base URL (matches the seeded `endpoint`), the
 * Anthropic-compatible Base URL (some providers expose an `/anthropic` or
 * `/compatible` variant), and — for the providers that offer a "Coding Plan"
 * (beta) — the coding-specific endpoint the UI swaps to when the Coding Plan
 * toggle is on. A missing key means that provider doesn't offer that variant.
 */
export interface ProviderEndpointSet {
  openai: string;
  anthropic?: string;
  codingPlan?: string;
}
export const PROVIDER_ENDPOINTS: Record<string, ProviderEndpointSet> = {
  deepseek: {
    openai: 'https://api.deepseek.com',
    anthropic: 'https://api.deepseek.com/anthropic',
  },
  moonshot: {
    openai: 'https://api.moonshot.cn/v1',
    codingPlan: 'https://api.kimi.com/coding/v1',
  },
  qwen: {
    openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
    codingPlan: 'https://coding.dashscope.aliyuncs.com/v1',
  },
  zhipu: {
    openai: 'https://open.bigmodel.cn/api/paas/v4',
    anthropic: 'https://open.bigmodel.cn/api/anthropic',
    codingPlan: 'https://open.bigmodel.cn/api/coding/paas/v4',
  },
  minimax: {
    openai: 'https://api.minimaxi.com/v1',
    anthropic: 'https://api.minimaxi.com/anthropic',
  },
  xiaomi: {
    openai: 'https://api.xiaomimimo.com/v1/chat/completions',
    anthropic: 'https://api.xiaomimimo.com/anthropic',
    codingPlan: 'https://token-plan-cn.xiaomimimo.com/v1',
  },
  volc: {
    openai: 'https://ark.cn-beijing.volces.com/api/v3',
    anthropic: 'https://ark.cn-beijing.volces.com/api/compatible',
    codingPlan: 'https://ark.cn-beijing.volces.com/api/coding/v3',
  },
};

/**
 * Display name overrides for a provider slug. Built-in rows seed
 * without a label, so the UI falls back to the slug — except where a slug is
 * an abbreviation the operator should not see (volc → "Volcengine"). Returns
 * the slug itself when there is no override.
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  volc: 'Volcengine',
};
export function providerDisplayName(slug: string): string {
  return PROVIDER_DISPLAY_NAMES[slug] ?? slug;
}
