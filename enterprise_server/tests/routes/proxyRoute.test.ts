import { beforeEach, describe, expect, test, vi } from 'vitest';

import { proxyRoutes } from '../../src/routes/proxy';

// vi.mock factories are hoisted above module scope, so the shared mock fns
// must be created with vi.hoisted or they throw a TDZ ReferenceError at
// import time (surfacing as a 500 from Hono).
const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getByUpstreamModel: vi.fn(),
  handle: vi.fn(),
}));

vi.mock('../../src/auth/requireActiveMember', () => ({
  // The real middleware verifies the bearer + member status and sets `claims`.
  // Stand in by setting a fixed caller so the route handler can read it.
  requireActiveMember: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    c.set('claims', { sub: 'user-1', orgId: 'org-1', roles: [] });
    return next();
  },
}));

vi.mock('../../src/models/modelCatalog', () => ({
  modelCatalog: {
    getById: (...a: unknown[]) => mocks.getById(...a),
    getByUpstreamModel: (...a: unknown[]) => mocks.getByUpstreamModel(...a),
  },
}));

vi.mock('../../src/proxy/providerProxy', () => ({
  providerProxy: { handle: (...a: unknown[]) => mocks.handle(...a) },
}));

const CATALOG_ROW = {
  id: '21e3e29a-a900-4574-b1bd-aaa8fb803ff1',
  org_id: 'org-1',
  provider_key_id: 'pk-vllm',
  provider: 'vllm',
  model: 'Qwen3.8-27B',
  display_name: null,
  quota_per_user_per_day: null,
  enabled: true,
  supports_image: true,
  supports_video: false,
  supports_thinking: true,
  context_window: null,
  max_tokens: null,
  temperature: null,
  top_p: null,
  max_output_tokens: null,
};

function wrappedInput(): { model_id: string; body: Record<string, unknown> } {
  const call = mocks.handle.mock.calls.at(-1) as unknown as [
    string,
    { model_id: string; body: Record<string, unknown> },
  ];
  return call[1];
}

async function postChatCompletions(model: string, provider = 'vllm') {
  const res = await proxyRoutes.request(
    `/proxy/${provider}/chat/completions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    },
  );
  return res;
}

describe('proxy/chat/completions model resolution', () => {
  beforeEach(() => {
    mocks.getById.mockReset();
    mocks.getByUpstreamModel.mockReset();
    mocks.handle.mockReset();
  });

  test('catalog UUID in body.model resolves the row and rewrites the wire model to the upstream name', async () => {
    mocks.getById.mockResolvedValue(CATALOG_ROW);
    mocks.getByUpstreamModel.mockResolvedValue(null);
    mocks.handle.mockResolvedValue(new Response('ok', { status: 200 }));

    const res = await postChatCompletions(CATALOG_ROW.id);
    expect(res.status).toBe(200);

    const { model_id, body } = wrappedInput();
    expect(model_id).toBe(CATALOG_ROW.id);
    expect(body.model).toBe('Qwen3.8-27B');
    // UUID must not have leaked to the upstream lookup: only the id path ran.
    expect(mocks.getById).toHaveBeenCalledTimes(1);
    expect(mocks.getByUpstreamModel).not.toHaveBeenCalled();
  });

  test('UUID disabled in the catalog is rejected (404), not forwarded', async () => {
    mocks.getById.mockResolvedValue({ ...CATALOG_ROW, enabled: false });
    mocks.handle.mockResolvedValue(new Response('ok', { status: 200 }));

    const res = await postChatCompletions(CATALOG_ROW.id);
    expect(res.status).toBe(404);
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  test('UUID belonging to another org is rejected (404)', async () => {
    mocks.getById.mockResolvedValue({ ...CATALOG_ROW, org_id: 'org-other' });
    mocks.handle.mockResolvedValue(new Response('ok', { status: 200 }));

    const res = await postChatCompletions(CATALOG_ROW.id);
    expect(res.status).toBe(404);
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  test('legacy name + provider segment still resolves via the name lookup (wire model untouched)', async () => {
    mocks.getById.mockResolvedValue(null);
    mocks.getByUpstreamModel.mockResolvedValue(CATALOG_ROW);
    mocks.handle.mockResolvedValue(new Response('ok', { status: 200 }));

    const res = await postChatCompletions('Qwen3.8-27B', 'vllm');
    expect(res.status).toBe(200);

    const { model_id, body } = wrappedInput();
    expect(model_id).toBe(CATALOG_ROW.id);
    expect(body.model).toBe('Qwen3.8-27B');
    expect(mocks.getByUpstreamModel).toHaveBeenCalledWith('org-1', 'vllm', 'Qwen3.8-27B');
  });

  test('unknown model (neither UUID nor name) is a 404', async () => {
    mocks.getById.mockResolvedValue(null);
    mocks.getByUpstreamModel.mockResolvedValue(null);

    const res = await postChatCompletions('does-not-exist');
    expect(res.status).toBe(404);
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  // Built-in plan models (MiniMax-M3, Kimi, Qwen plan models, ...) are seeded
  // with a deterministic catalog id `builtin:<orgId>:<slug>:<modelId>` — NOT a
  // v4 UUID. The desktop sets Model.id to that catalog id and the OpenClaw
  // gateway sends it verbatim as the wire `model`. Before the fix, the by-id
  // branch only recognised v4 UUIDs, so a `builtin:` id fell through to the
  // name lookup, which cannot match the full id string and 404'd with
  // "model ... not configured for org". It must resolve by id instead.
  test('builtin:<org>:<slug>:<modelId> catalog id resolves via getById (id path), not the name lookup', async () => {
    const builtinRow = { ...CATALOG_ROW, id: 'builtin:org-1:minimax:MiniMax-M3', model: 'MiniMax-M3' };
    mocks.getById.mockResolvedValue(builtinRow);
    mocks.getByUpstreamModel.mockResolvedValue(null);
    mocks.handle.mockResolvedValue(new Response('ok', { status: 200 }));

    const res = await postChatCompletions('builtin:org-1:minimax:MiniMax-M3', 'minimax');
    expect(res.status).toBe(200);

    const { model_id, body } = wrappedInput();
    expect(model_id).toBe('builtin:org-1:minimax:MiniMax-M3');
    expect(body.model).toBe('MiniMax-M3');
    // Must have taken the id path and failed closed — the name lookup must NOT
    // have run for a `builtin:` id (it can never match the full id).
    expect(mocks.getById).toHaveBeenCalledTimes(1);
    expect(mocks.getByUpstreamModel).not.toHaveBeenCalled();
  });

  test('builtin id miss fails closed (404), does not fall back to a name match', async () => {
    // A `builtin:` id that getById misses must 404 even if the string happens
    // to match an upstream name — treating an id miss as a name would let a
    // revoked row be reached by its id, same fail-closed invariant as the UUID.
    mocks.getById.mockResolvedValue(null);
    mocks.getByUpstreamModel.mockResolvedValue(CATALOG_ROW);

    const res = await postChatCompletions('builtin:org-1:minimax:MiniMax-M3');
    expect(res.status).toBe(404);
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.getByUpstreamModel).not.toHaveBeenCalled();
  });

  // The `startsWith('builtin:')` discriminator must cover EVERY built-in
  // provider, not just minimax — all 9 share the deterministic
  // `builtin:<org>:<slug>:<modelId>` id shape. Iterate the real seed table and
  // assert each provider's first model resolves via the id path (getById), so a
  // regression that special-cased one slug is caught.
  test('all built-in provider model ids resolve via getById (id path), not the name lookup', async () => {
    const { BUILTIN_PROVIDERS } = await import('../../src/org/builtinProviders');
    expect(BUILTIN_PROVIDERS.length).toBeGreaterThanOrEqual(9);
    for (const p of BUILTIN_PROVIDERS) {
      const modelId = p.models[0].id;
      const builtinId = `builtin:org-1:${p.slug}:${modelId}`;
      mocks.getById.mockReset();
      mocks.getByUpstreamModel.mockReset();
      mocks.handle.mockReset();
      mocks.getById.mockResolvedValue({ ...CATALOG_ROW, id: builtinId, model: modelId, provider: p.slug });
      mocks.handle.mockResolvedValue(new Response('ok', { status: 200 }));

      const res = await postChatCompletions(builtinId, p.slug);
      expect(res.status, `builtin id for provider ${p.slug} (${modelId})`).toBe(200);
      // id path only — the name lookup must never run for a builtin id.
      expect(mocks.getById, `getById for ${p.slug}`).toHaveBeenCalledTimes(1);
      expect(mocks.getByUpstreamModel, `name lookup for ${p.slug}`).not.toHaveBeenCalled();
    }
  });

  test('UUID lookup does not fall back to a name match (fail closed)', async () => {
    // A UUID-shaped value that getById misses must 404 even if the same
    // string happens to match an upstream name — silently treating an id
    // miss as a name would let a revoked row be reached by its id.
    mocks.getById.mockResolvedValue(null);
    mocks.getByUpstreamModel.mockResolvedValue(CATALOG_ROW);

    const res = await postChatCompletions('21e3e29a-a900-4574-b1bd-aaa8fb803ff1');
    expect(res.status).toBe(404);
    expect(mocks.handle).not.toHaveBeenCalled();
  });
});
