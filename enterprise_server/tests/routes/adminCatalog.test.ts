import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { modelCatalog } from '../../src/models/modelCatalog';
import { catalogRoutes } from '../../src/routes/admin/catalog';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', catalogRoutes);
  return app;
}

async function userToken(orgId: string, userId: string): Promise<string> {
  // A non-admin, non-super_admin token — the catalog endpoint must accept
  // any authenticated user (the desktop calls it at startup).
  return signToken({ sub: userId, orgId, roles: ['user'] });
}

async function adminToken(orgId: string, userId: string): Promise<string> {
  return signToken({ sub: userId, orgId, roles: ['model_admin'] });
}

describe('routes/admin/catalog', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'Test')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('root', 'o1', 'r', 'x')`,
    );
  });

  test('GET /admin/catalog requires auth (no token → 401)', async () => {
    const a = buildApp();
    const res = await a.request('/admin/catalog');
    expect(res.status).toBe(401);
  });

  test('普通用户可读 (不需要 model_admin / super_admin)', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-test',
      label: 'prod',
      createdBy: 'root',
      region: 'global',
      defaultBaseUrl: 'https://api.openai.com/v1',
      website: 'https://platform.openai.com',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
      displayName: 'GPT-4o',
      // types drives the synthesized supportsImage; the legacy column is
      // ignored on the read path, so the column is set to false here.
      types: ['chat', 'vision'],
      capabilities: {
        supports_image: false,
        supports_video: false,
        supports_thinking: false,
        context_window: 128000,
        max_tokens: 8192,
      },
    });

    const a = buildApp();
    const tok = await userToken('o1', 'u1');
    const res = await a.request('/admin/catalog', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      providers: Array<{ provider: string; region: string; defaultBaseUrl: string }>;
      models: Array<{ model: string; supportsImage: boolean; contextWindow: number }>;
    };
    expect(j.providers).toHaveLength(1);
    expect(j.providers[0].provider).toBe('openai');
    expect(j.providers[0].region).toBe('global');
    expect(j.models).toHaveLength(1);
    expect(j.models[0].supportsImage).toBe(true);
    expect(j.models[0].contextWindow).toBe(128000);
  });

  test('只返回 enabled 的 provider 和 enabled + 非 policy-disabled 的 model', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'k',
      createdBy: 'root',
    });
    const k2 = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'anthropic',
      plaintextKey: 'k',
      createdBy: 'root',
    });
    await providerKeyVault.setEnabled(k2.id, false);
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    const m2 = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'o1-preview',
    });
    // policy-disable m2
    await modelCatalog.setModelDisabled('o1', m2.id, true, 'root');

    const a = buildApp();
    const tok = await adminToken('o1', 'root');
    const res = await a.request('/admin/catalog', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      providers: Array<{ provider: string }>;
      models: Array<{ model: string }>;
    };
    expect(j.providers.map(p => p.provider).sort()).toEqual(['openai']);
    expect(j.models.map(m => m.model).sort()).toEqual(['gpt-4o']);
  });

  test('response 永远不包含 api_key 或 encrypted 字段', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-SECRET-DO-NOT-LEAK',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });

    const a = buildApp();
    const tok = await userToken('o1', 'u1');
    const res = await a.request('/admin/catalog', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('sk-SECRET-DO-NOT-LEAK');
    expect(body).not.toContain('api_key_encrypted');
    expect(body).not.toContain('provider_key_id');
  });

  test('types[] includes vision synthesizes supportsImage=true even when column is false', async () => {
    // Mirror the enterpriseModels synthesis: the admin drawer enables vision
    // via the types chip, but the desktop reads supportsImage. Without
    // synthesis the chip path leaves the desktop showing vision as disabled.
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-x',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'm3',
      types: ['chat', 'vision'],
      capabilities: { supports_image: false, supports_thinking: false },
    });
    const a = buildApp();
    const tok = await userToken('o1', 'u1');
    const res = await a.request('/admin/catalog', {
      headers: { authorization: `Bearer ${tok}` },
    });
    const j = (await res.json()) as {
      models: Array<{ model: string; supportsImage: boolean; supportsThinking: boolean }>;
    };
    const row = j.models.find(m => m.model === 'm3')!;
    expect(row.supportsImage).toBe(true);
    expect(row.supportsThinking).toBe(false);
  });

  test('跨 org 隔离: 不能读到其它 org 的 provider/model', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o2', 'Other')`);
    await providerKeyVault.add({
      orgId: 'o2',
      provider: 'anthropic',
      plaintextKey: 'k',
      createdBy: 'root',
    });
    const a = buildApp();
    const tok = await userToken('o1', 'u1');
    const res = await a.request('/admin/catalog', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      providers: unknown[];
      models: unknown[];
    };
    expect(j.providers).toHaveLength(0);
    expect(j.models).toHaveLength(0);
  });
});
