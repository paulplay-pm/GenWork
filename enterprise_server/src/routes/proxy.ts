import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import { requireActiveMember } from '../auth/requireActiveMember';
import { modelCatalog } from '../models/modelCatalog';
import { type ProviderName,providerProxy } from '../proxy/providerProxy';

export const proxyRoutes = new Hono();
// The LLM proxy is the one hot path where per-request membership cost matters,
// so it uses the active-member gate (bearer-verify + cached `users.status`
// check) rather than the plain `requireAuth` shared by the other routes. A
// revoked member gets the distinct `{ error: 'not_member' }` 401.
proxyRoutes.use('/proxy/*', requireActiveMember);
proxyRoutes.use('/proxy/**', requireActiveMember);
proxyRoutes.use('/proxy/:provider/chat/completions', requireActiveMember);

async function handle(c: { req: { json: () => Promise<unknown>; header: (n: string) => string | undefined }; get: (n: 'claims') => { sub: string; orgId: string; roles: string[] } }, provider: ProviderName) {
  const claims = c.get('claims');
  const body = z
    .object({
      model_id: z.string(),
      body: z.unknown().default({}),
    })
    .transform((v) => ({ model_id: v.model_id, body: v.body ?? {} }))
    .parse(await c.req.json());
  const extraHeaders: Record<string, string> = {};
  const idem = c.req.header('idempotency-key');
  if (idem) extraHeaders['idempotency-key'] = idem;
  return providerProxy.handle(provider, body, claims, extraHeaders);
}

proxyRoutes.post('/proxy/openai', (c) => handle(c, 'openai'));
proxyRoutes.post('/proxy/anthropic', (c) => handle(c, 'anthropic'));
proxyRoutes.post('/proxy/deepseek', (c) => handle(c, 'deepseek'));

/**
 * OpenClaw-gateway-shaped route. The vendored OpenClaw gateway appends
 * `chat/completions` to its `baseUrl`, so the desktop writes
 * `baseUrl: <enterprise>/proxy/<provider>`. The gateway then sends a
 * standard OpenAI body (`{model, messages, ...}`) to
 * `<base>/chat/completions`. We accept the upstream's provider name as
 * a path segment (e.g. `vllm`) and route all of them through the
 * OpenAI protocol handler — the catalog's stored provider column is the
 * upstream type (`vllm`, `openai`, etc.) and may not match the API
 * protocol the gateway assumes (`openai`). All OpenAI-compatible
 * upstreams use the OpenAI chat-completions shape.
 */
const openAIChatBody = z
  .object({
    model: z.string().min(1),
  })
  .passthrough();

async function handleChatCompletions(c: Context, _provider: ProviderName) {
  const claims = c.get('claims');
  const body = openAIChatBody.parse(await c.req.json()) as { model: string; [k: string]: unknown };
  const providerSegment = c.req.param('provider') || null;
  // The desktop's enterprise model identity is the catalog row's `id`
  // (`genwork-server/<id>`), sent verbatim as the wire `model`. That id is a
  // v4 UUID for user-added provider-key models and a deterministic
  // `builtin:<orgId>:<slug>:<modelId>` string for plan/built-in models
  // (org/builtinProviders.ts). Either form resolves **by id**, fail-closed — a
  // miss must NOT fall through to a name match, or a row that was disabled
  // after selection could still be reached by its id. Only the remaining
  // non-id values are legacy upstream names (pre-identity refs), which keep the
  // scoped name lookup: the `:provider` segment disambiguates two same-named
  // models bound to different providers.
  const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const isCatalogId = UUID_V4_RE.test(body.model) || body.model.startsWith('builtin:');
  // Only `lookup.id` and `lookup.model` are consumed downstream (see the
  // `wrapped` construction below), so `lookup` is typed with exactly the fields
  // both resolution paths provide — rather than pinning it to `getById`'s return
  // type, which `getByUpstreamModel` does not fully satisfy (the name lookup
  // SELECTs no temperature/top_p/max_output_tokens).
  let lookup: { id: string; model: string } | null;
  if (isCatalogId) {
    const row = await modelCatalog.getById(body.model);
    lookup = row && row.org_id === claims.orgId && row.enabled ? row : null;
  } else {
    const scoped = providerSegment
      ? await modelCatalog.getByUpstreamModel(claims.orgId, providerSegment, body.model)
      : null;
    lookup = scoped ?? (await modelCatalog.getByUpstreamModel(claims.orgId, null, body.model));
  }
  if (!lookup) {
    return c.json(
      { error: `model ${body.model} not configured for org` },
      404,
    );
  }
  const wrapped = { model_id: lookup.id, body: { ...body, model: lookup.model } };
  const extraHeaders: Record<string, string> = {};
  const idem = c.req.header('idempotency-key');
  if (idem) extraHeaders['idempotency-key'] = idem;
  return providerProxy.handle('openai', wrapped, claims, extraHeaders);
}

proxyRoutes.post('/proxy/openai/chat/completions', (c) => handleChatCompletions(c, 'openai'));
proxyRoutes.post('/proxy/anthropic/chat/completions', (c) => handleChatCompletions(c, 'anthropic'));
proxyRoutes.post('/proxy/deepseek/chat/completions', (c) => handleChatCompletions(c, 'deepseek'));
// Catch-all for any other upstream-named path (e.g. /proxy/vllm/chat/completions
// when the desktop config writes `provider: vllm`). All OpenAI-compatible
// upstreams share the same chat-completions shape.
proxyRoutes.post('/proxy/:provider/chat/completions', (c) => handleChatCompletions(c, 'openai'));