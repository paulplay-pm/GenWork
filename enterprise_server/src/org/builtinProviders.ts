import { pool } from '../db/pool';

export interface BuiltinModelDef { id: string; name: string; types: string[]; contextWindow: number; }
export interface BuiltinProviderDef {
  slug: string; name: string; endpoint: string; protocol: 'openai' | 'anthropic';
  models: BuiltinModelDef[];
}

export const BUILTIN_PROVIDERS: BuiltinProviderDef[] = [
  { slug: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', protocol: 'openai',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', types: ['chat', 'vision'], contextWindow: 128000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', types: ['chat'], contextWindow: 128000 },
      { id: 'o3-mini', name: 'o3-mini', types: ['chat', 'reasoning'], contextWindow: 128000 },
    ] },
  { slug: 'anthropic', name: 'Anthropic', endpoint: 'https://api.anthropic.com', protocol: 'anthropic',
    models: [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', types: ['chat', 'reasoning'], contextWindow: 200000 },
      { id: 'claude-opus-4', name: 'Claude Opus 4', types: ['chat', 'reasoning'], contextWindow: 200000 },
    ] },
  { slug: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com', protocol: 'openai',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', types: ['chat', 'reasoning'], contextWindow: 128000 },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', types: ['chat'], contextWindow: 128000 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', types: ['reasoning'], contextWindow: 128000 },
    ] },
  { slug: 'moonshot', name: 'Moonshot (Kimi)', endpoint: 'https://api.moonshot.cn/v1', protocol: 'openai',
    models: [
      { id: 'kimi-k3', name: 'Kimi K3', types: ['chat', 'reasoning'], contextWindow: 200000 },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', types: ['chat'], contextWindow: 200000 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', types: ['chat'], contextWindow: 200000 },
    ] },
  { slug: 'qwen', name: 'Qwen (DashScope)', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai',
    models: [
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', types: ['chat', 'vision'], contextWindow: 128000 },
      { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', types: ['chat'], contextWindow: 128000 },
      { id: 'qwen-vl-max', name: 'Qwen-VL-Max', types: ['chat', 'vision'], contextWindow: 128000 },
    ] },
  { slug: 'zhipu', name: 'Zhipu (GLM)', endpoint: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai',
    models: [
      { id: 'glm-5.1', name: 'GLM 5.1', types: ['chat', 'reasoning'], contextWindow: 128000 },
      { id: 'glm-5', name: 'GLM 5', types: ['chat'], contextWindow: 128000 },
    ] },
  { slug: 'minimax', name: 'MiniMax', endpoint: 'https://api.minimaxi.com/v1', protocol: 'openai',
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', types: ['chat'], contextWindow: 128000 },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', types: ['chat'], contextWindow: 128000 },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', types: ['chat'], contextWindow: 128000 },
    ] },
  { slug: 'xiaomi', name: 'Xiaomi (MiMo)', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', protocol: 'openai',
    models: [
      { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', types: ['chat'], contextWindow: 128000 },
      { id: 'mimo-v2.5', name: 'MiMo V2.5', types: ['chat'], contextWindow: 128000 },
    ] },
  { slug: 'volc', name: '火山引擎 (豆包)', endpoint: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'openai',
    models: [
      { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro', types: ['chat', 'vision', 'reasoning'], contextWindow: 200000 },
      { id: 'doubao-seed-2.0-lite', name: 'Doubao Seed 2.0 Lite', types: ['chat'], contextWindow: 200000 },
    ] },
];

// Map an 8-value `types` first element to a legal legacy `type` (old-6 domain)
// so the desktop `GET /admin/catalog` contract keeps a valid single value.
const LEGACY_TYPE: Record<string, string> = {
  'chat': 'chat', 'vision': 'vision', 'reasoning': 'reasoning',
  'image-gen': 'image', 'embedding': 'embedding', 'rerank': 'embedding',
  'asr': 'audio', 'tts': 'audio',
};

export function legacyTypeFor(types: string[]): string {
  return LEGACY_TYPE[types[0]] ?? 'chat';
}

/** Idempotently seed the 9 built-in providers + models for one org. */
export async function seedBuiltinProviders(orgId: string): Promise<void> {
  for (const p of BUILTIN_PROVIDERS) {
    const pkId = `builtin:${orgId}:${p.slug}`;
    // Built-ins seed without an API Key, so they start DISABLED (未启用): the
    // operator must add a key and enable the provider before its models are
    // offered to users (a keyless provider can't authenticate). Models are
    // still seeded so the catalog is populated and can be fetched/enabled once
    // a key is set.
    await pool.query(
      `INSERT INTO provider_keys(id, org_id, provider, endpoint, is_builtin, protocol, enabled)
       VALUES ($1,$2,$3,$4, true, $5, false)
       ON CONFLICT (org_id, provider) WHERE is_builtin DO NOTHING`,
      [pkId, orgId, p.slug, p.endpoint, p.protocol],
    );
    for (const m of p.models) {
      const mid = `builtin:${orgId}:${p.slug}:${m.id}`;
      await pool.query(
        `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model, display_name, types, context_window, type, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, true)
         ON CONFLICT (org_id, provider_key_id, model) DO NOTHING`,
        [mid, orgId, pkId, p.slug, m.id, m.name, m.types, m.contextWindow, legacyTypeFor(m.types)],
      );
    }
  }
}

/** Seed every existing org (idempotent no-op once present). */
export async function seedBuiltinProvidersForAllOrgs(): Promise<void> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM orgs`);
  for (const org of r.rows) {
    await seedBuiltinProviders(org.id);
  }
}
