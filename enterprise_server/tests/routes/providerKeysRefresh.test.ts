import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { authService } from '../../src/auth/authService';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { modelCatalog } from '../../src/models/modelCatalog';
import { adminProviderKeyRoutes } from '../../src/routes/admin/providerKeys';
import { authRoutes } from '../../src/routes/auth';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  app.route('/', adminProviderKeyRoutes);
  return app;
}

async function seedAdmin(orgName = 'T'): Promise<{ token: string; userId: string }> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1', $1)`, [orgName]);
  const u = await authService.createUser({
    orgId: 'o1',
    username: 'admin',
    password: 'pw12345678',
  });
  const token = await signToken({
    sub: u.id,
    orgId: 'o1',
    roles: ['super_admin'],
  });
  return { token, userId: u.id };
}

describe('routes/admin/providerKeys.refresh-models', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetSchema();
    await runMigrations();
  });

  test('anthropic provider hits fetchAnthropicModels (was: skipped)', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({
      status: 200,
      ok: true,
      json: async () => ({ data: [{ id: 'claude-3-haiku-20240307' }] }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const { token, userId } = await seedAdmin();
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'anthropic',
      plaintextKey: 'sk-ant',
      endpoint: 'https://api.anthropic.com',
      createdBy: userId,
      // Protocol drives the wire format now; the anthropic built-in/custom
      // row carries protocol='anthropic' (column default is 'openai').
      protocol: 'anthropic',
    });
    const a = buildApp();
    const r = await a.request(`/admin/provider-keys/${k.id}/refresh-models`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { added: number; unchanged: number; upstreamCount: number };
    expect(body.upstreamCount).toBe(1);
    expect(body.added).toBe(1);
    // Anthropic uses x-api-key header (not Bearer)
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [_url, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
    });
  });

  test('vllm (custom OpenAI-compatible) routes via probeModelsEndpoint', async () => {
    const fetchSpy = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ data: [{ id: 'qwen2.5-7b' }, { id: 'qwen2.5-32b' }] }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const { token, userId } = await seedAdmin();
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'vllm',
      plaintextKey: 'no-auth',
      endpoint: 'http://localhost:8000/v1',
      createdBy: userId,
    });
    const a = buildApp();
    const r = await a.request(`/admin/provider-keys/${k.id}/refresh-models`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { added: number; unchanged: number; upstreamCount: number };
    expect(body.upstreamCount).toBe(2);
    expect(body.added).toBe(2);
    const list = await modelCatalog.listForAdmin('o1');
    const ids = list.map((m) => m.model).sort();
    expect(ids).toEqual(['qwen2.5-32b', 'qwen2.5-7b']);
  });

  test('401 from upstream becomes invalid_api_key + 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) }))
    );
    const { token, userId } = await seedAdmin();
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-bad',
      endpoint: 'https://api.openai.com/v1',
      createdBy: userId,
    });
    const a = buildApp();
    const r = await a.request(`/admin/provider-keys/${k.id}/refresh-models`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(502);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('invalid_api_key');
  });

  test('success: inserts new models, preserves existing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }),
      }))
    );
    const { token, userId } = await seedAdmin();
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-test',
      endpoint: 'https://api.openai.com/v1',
      createdBy: userId,
    });
    // Pre-seed gpt-4o so we can assert "unchanged" on the second call.
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    const a = buildApp();
    const r = await a.request(`/admin/provider-keys/${k.id}/refresh-models`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      added: number;
      unchanged: number;
      upstreamCount: number;
    };
    expect(body.upstreamCount).toBe(2);
    expect(body.added).toBe(1);
    expect(body.unchanged).toBe(1);

    const list = await modelCatalog.listForAdmin('o1');
    const ids = list.map((m) => m.model).sort();
    expect(ids).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  test('404 when provider key is from a different org', async () => {
    const { token, userId } = await seedAdmin();
    // Create another org + a key there
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2', 'Other')`);
    const k2 = await providerKeyVault.add({
      orgId: 'o2',
      provider: 'openai',
      plaintextKey: 'sk',
      endpoint: 'https://api.openai.com/v1',
      createdBy: userId,
    });
    const a = buildApp();
    const r = await a.request(`/admin/provider-keys/${k2.id}/refresh-models`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(404);
  });

  test('409 when provider key is disabled', async () => {
    const { token, userId } = await seedAdmin();
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk',
      endpoint: 'https://api.openai.com/v1',
      createdBy: userId,
    });
    await providerKeyVault.setEnabled(k.id, false);
    const a = buildApp();
    const r = await a.request(`/admin/provider-keys/${k.id}/refresh-models`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(409);
  });

  test('400 when endpoint is empty (no fallback URL)', async () => {
    const { token, userId } = await seedAdmin();
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk',
      // endpoint omitted
      createdBy: userId,
    });
    const a = buildApp();
    const r = await a.request(`/admin/provider-keys/${k.id}/refresh-models`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('empty_endpoint');
  });
});
