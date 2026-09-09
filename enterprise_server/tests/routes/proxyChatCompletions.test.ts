import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { _resetRequireActiveMemberCacheForTest } from '../../src/auth/requireActiveMember';
import { resetSchema, runMigrations,testPool } from '../../src/db/testDb';
import { modelCatalog } from '../../src/models/modelCatalog';
import { proxyRoutes } from '../../src/routes/proxy';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', proxyRoutes);
  return app;
}

async function tokenFor(orgId: string, userId: string, roles: string[] = ['user']): Promise<string> {
  return signToken({ sub: userId, orgId, roles });
}

async function seedOrgUserKeyModel(opts: {
  orgId: string;
  userId: string;
  provider: string;
  model: string;
  displayName?: string;
}): Promise<{ id: string }> {
  await testPool.query(
    `INSERT INTO orgs(id, name, timezone) VALUES ($1, 'T', 'UTC') ON CONFLICT DO NOTHING`,
    [opts.orgId]
  );
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash) VALUES ($1, $2, 'u', 'x') ON CONFLICT DO NOTHING`,
    [opts.userId, opts.orgId]
  );
  const k = await providerKeyVault.add({
    orgId: opts.orgId,
    provider: opts.provider,
    plaintextKey: 'sk-test',
    label: 'p',
    createdBy: opts.userId,
  });
  return modelCatalog.add({
    orgId: opts.orgId,
    providerKeyId: k.id,
    provider: opts.provider,
    model: opts.model,
    displayName: opts.displayName,
  });
}

/** Seed a single org + user + one model row bound to a provider key with a
 * distinct endpoint, so tests can tell which upstream a request forwards to. */
async function seedModelWithEndpoint(opts: {
  orgId: string;
  userId: string;
  provider: string;
  model: string;
  endpoint: string;
}): Promise<{ keyId: string; modelId: string }> {
  await testPool.query(
    `INSERT INTO orgs(id, name, timezone) VALUES ($1, 'T', 'UTC') ON CONFLICT DO NOTHING`,
    [opts.orgId]
  );
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash) VALUES ($1, $2, 'u', 'x') ON CONFLICT DO NOTHING`,
    [opts.userId, opts.orgId]
  );
  const k = await providerKeyVault.add({
    orgId: opts.orgId,
    provider: opts.provider,
    plaintextKey: 'sk-test',
    label: `key-${opts.provider}`,
    endpoint: opts.endpoint,
    createdBy: opts.userId,
  });
  const m = await modelCatalog.add({
    orgId: opts.orgId,
    providerKeyId: k.id,
    provider: opts.provider,
    model: opts.model,
  });
  return { keyId: k.id, modelId: m.id };
}

describe('routes/proxy (chat-completions shape)', () => {
  beforeEach(async () => {
    _resetRequireActiveMemberCacheForTest();
    await resetSchema();
    await runMigrations();
  });

  test('401 without JWT', async () => {
    const a = buildApp();
    const r = await a.request('/proxy/openai/chat/completions', { method: 'POST' });
    expect(r.status).toBe(401);
  });

  test('bad-signature JWT returns the generic unauthorized, not not_member', async () => {
    await seedOrgUserKeyModel({ orgId: 'o1', userId: 'u1', provider: 'openai', model: 'gpt-4o' });
    const a = buildApp();
    const r = await a.request('/proxy/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer not-a-valid-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()) as { error: string }).toEqual({ error: 'unauthorized' });
  });

  test('active member with a valid JWT proceeds to the handler', async () => {
    const { modelId } = await seedModelWithEndpoint({
      orgId: 'o1', userId: 'u1', provider: 'openai', model: 'gpt-4o', endpoint: 'https://prod.example.com/v1',
    });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"id":"chatcmpl-m"}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
    const a = buildApp();
    const r = await a.request('/proxy/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await tokenFor('o1', 'u1')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    expect(r.status).toBe(200);
    expect(modelId).toBeTruthy();
  });

  test('a disabled member with a still-valid JWT is bounced as not_member', async () => {
    await seedOrgUserKeyModel({ orgId: 'o1', userId: 'u1', provider: 'openai', model: 'gpt-4o' });
    await testPool.query(`UPDATE users SET status = 'disabled' WHERE id = 'u1'`);
    const a = buildApp();
    const r = await a.request('/proxy/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await tokenFor('o1', 'u1')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()) as { error: string }).toEqual({ error: 'not_member' });
  });

  test('a deleted member (row gone) with a still-valid JWT is bounced as not_member', async () => {
    // The membership gate runs in middleware, before the handler, so no model
    // row is needed. Seed a bare user (no provider key) so the DELETE can't
    // trip the provider_keys.created_by foreign key.
    await testPool.query(
      `INSERT INTO orgs(id, name, timezone) VALUES ('o1', 'T', 'UTC')`
    );
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1', 'o1', 'u', 'x')`
    );
    const token = await tokenFor('o1', 'u1');
    await testPool.query(`DELETE FROM users WHERE id = 'u1'`);
    const a = buildApp();
    const r = await a.request('/proxy/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()) as { error: string }).toEqual({ error: 'not_member' });
  });

  test('404 when model name is unknown to the org catalog', async () => {
    await seedOrgUserKeyModel({ orgId: 'o1', userId: 'u1', provider: 'openai', model: 'gpt-4o' });
    const a = buildApp();
    const r = await a.request('/proxy/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await tokenFor('o1', 'u1')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'qwen-unknown', messages: [] }),
    });
    expect(r.status).toBe(404);
    const body = await r.json() as { error: string };
    expect(body.error).toContain('qwen-unknown');
  });

  test('upstream name matches model column and proxy forwards with catalog id', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"id":"chatcmpl-1"}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
    await seedOrgUserKeyModel({ orgId: 'o1', userId: 'u1', provider: 'openai', model: 'Qwen3.8-27B' });
    const a = buildApp();
    const r = await a.request('/proxy/openai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await tokenFor('o1', 'u1')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'Qwen3.8-27B', messages: [{ role: 'user', content: 'hi' }] }),
    });
    // Forwarding succeeded — the upstream mock returns 200.
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledWith = fetchSpy.mock.calls[0] as [string, RequestInit];
    const forwardedBody = JSON.parse(calledWith[1].body as string) as { model: string; messages: unknown[] };
    // The desktop-facing upstream name is preserved in the inner body
    // (the proxy passes it through); the proxy substitutes the catalog id
    // via tokenUsage, not by rewriting the body.
    expect(forwardedBody.model).toBe('Qwen3.8-27B');
  });

  test('upstream-type path (e.g. /proxy/vllm/chat/completions) hits the catch-all', async () => {
    // The desktop config may write `baseUrl: <enterprise>/proxy/vllm` when the
    // catalog's stored provider is "vllm" (an OpenAI-compatible upstream). The
    // OpenClaw gateway then appends `chat/completions`. The route handler
    // accepts any single segment as the provider.
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"id":"chatcmpl-2"}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
    await seedOrgUserKeyModel({ orgId: 'o1', userId: 'u1', provider: 'vllm', model: 'Qwen3.8-27B' });
    const a = buildApp();
    const r = await a.request('/proxy/vllm/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await tokenFor('o1', 'u1')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'Qwen3.8-27B', messages: [{ role: 'user', content: 'hi' }] }),
    });
    // The mocked fetch returns 200; the proxy should call it with the inner
    // body unchanged. (The current test setup uses provider='openai' for the
    // key seed, which is fine for the forward call — the catalog stores the
    // provider_key_id; the proxy uses that row to decrypt the upstream key.)
    if (r.status !== 200) {
      console.log('NON-200 BODY:', await r.text());
    }
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('two same-named models: :provider segment disambiguates the row', async () => {
    // Regression: the org catalog can carry two rows with the same upstream
    // model name bound to different providers (e.g. two `Qwen3.8-27B`, one on
    // a "vllm-test" key and one on a "vllm" key). The proxy must route to the
    // row whose provider matches the `:provider` path segment the desktop
    // writes — not to an arbitrary row picked by name-only resolution.
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"id":"chatcmpl-3"}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
    // Two keys, same upstream name, distinct endpoints so we can observe which
    // row the request forwards to.
    const a = await seedModelWithEndpoint({
      orgId: 'o1', userId: 'u1', provider: 'custom-vllm-test',
      model: 'Qwen3.8-27B', endpoint: 'https://test.example.com/v1',
    });
    const b = await seedModelWithEndpoint({
      orgId: 'o1', userId: 'u1', provider: 'vllm',
      model: 'Qwen3.8-27B', endpoint: 'https://prod.example.com/v1',
    });

    // Dial the "vllm" provider segment — must land on row b (prod), not row a.
    const app = buildApp();
    const r = await app.request('/proxy/vllm/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await tokenFor('o1', 'u1')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'Qwen3.8-27B', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const fwd = JSON.parse(init.body as string) as { model: string };
    expect(url).toContain('https://prod.example.com/v1/chat/completions');
    expect(fwd.model).toBe('Qwen3.8-27B');
    // Sanity: both seeded rows really exist so the scoped lookup had a choice.
    expect(a.modelId).not.toBe(b.modelId);
  });

  test('scoped :provider miss falls back to name-only match (no 404)', async () => {
    // The catalog holds one Qwen row under provider "vllm". A client dials the
    // catch-all with a DIFFERENT provider segment ("some-provider"), so the
    // scoped lookup (provider='some-provider') misses; the route must fall
    // back to the name-only match and forward rather than 404. This guards the
    // safety net behind the scoped lookup against drift/legacy callers.
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"id":"chatcmpl-4"}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
    await seedModelWithEndpoint({
      orgId: 'o1', userId: 'u1', provider: 'vllm',
      model: 'Qwen3.8-27B', endpoint: 'https://prod.example.com/v1',
    });
    const app = buildApp();
    const r = await app.request('/proxy/some-provider/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await tokenFor('o1', 'u1')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'Qwen3.8-27B', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
