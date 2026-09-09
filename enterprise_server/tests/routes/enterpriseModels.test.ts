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
import { enterpriseModelsRoutes } from '../../src/routes/enterpriseModels';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', enterpriseModelsRoutes);
  return app;
}

async function tokenFor(
  orgId: string,
  userId: string,
  roles: string[] = ['user'],
): Promise<string> {
  return signToken({ sub: userId, orgId, roles });
}

describe('routes/enterpriseModels', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1', 'T', 'UTC')`);
    await testPool.query(
      `INSERT INTO users(id, org_id, username, password_hash) VALUES ('root', 'o1', 'r', 'x')`,
    );
  });

  test('401 without JWT', async () => {
    const a = buildApp();
    const r = await a.request('/enterprise-models');
    expect(r.status).toBe(401);
  });

  test('returns only org-A models when authenticated as org-A user', async () => {
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o2', 'Other', 'UTC')`);
    const kA = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-A',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: kA.id,
      provider: 'openai',
      model: 'gpt-4o',
    });
    const kB = await providerKeyVault.add({
      orgId: 'o2',
      provider: 'anthropic',
      plaintextKey: 'sk-B',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o2',
      providerKeyId: kB.id,
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
    });

    const a = buildApp();
    const tok = await tokenFor('o1', 'root');
    const r = await a.request('/enterprise-models', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { models: Array<{ provider: string; model: string }> };
    expect(body.models).toHaveLength(1);
    expect(body.models[0].model).toBe('gpt-4o');
    expect(body.models[0].provider).toBe('openai');
  });

  test('response carries _k field set to decrypted key per model', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-DECRYPT-ME',
      endpoint: 'https://api.openai.com/v1',
      createdBy: 'root',
    });
    const m = await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });

    const a = buildApp();
    const tok = await tokenFor('o1', 'root');
    const r = await a.request('/enterprise-models', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      models: Array<{ id: string; model: string; endpoint: string | null; _k: string | null }>;
    };
    expect(body.models).toHaveLength(1);
    expect(body.models[0].id).toBe(m.id);
    expect(body.models[0].endpoint).toBe('https://api.openai.com/v1');
    expect(body.models[0]._k).toBe('sk-DECRYPT-ME');
  });

  test('_k is null when key cannot be decrypted (model still in catalog)', async () => {
    const k = await providerKeyVault.add({
      orgId: 'o1',
      provider: 'openai',
      plaintextKey: 'sk-ok',
      createdBy: 'root',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'gpt-4o',
    });

    // Simulate decrypt failure by stubbing the vault (the model row stays
    // visible; only `_k` becomes null).
    const a = buildApp();
    const vault = await import('../../src/vault/providerKeyVault');
    vi.spyOn(vault.providerKeyVault, 'getDecrypted').mockImplementation(async () => {
      throw new Error('simulated decrypt failure');
    });

    const tok = await tokenFor('o1', 'root');
    const r = await a.request('/enterprise-models', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { models: Array<{ _k: string | null }> };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]._k).toBeNull();
  });

  test('audit row written per call', async () => {
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
      model: 'gpt-4o',
    });
    await modelCatalog.add({
      orgId: 'o1',
      providerKeyId: k.id,
      provider: 'openai',
      model: 'o1-mini',
    });

    const before = await testPool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_events WHERE action='enterprise_models_sync'`,
    );
    const beforeN = Number(before.rows[0]?.c ?? 0);

    const a = buildApp();
    const tok = await tokenFor('o1', 'root');
    const r = await a.request('/enterprise-models', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(r.status).toBe(200);

    const after = await testPool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_events WHERE action='enterprise_models_sync'`,
    );
    const afterN = Number(after.rows[0]?.c ?? 0);
    expect(afterN).toBe(beforeN + 1);

    const rows = await testPool.query<{
      action: string;
      user_id: string;
      payload: unknown;
    }>(
      `SELECT action, user_id, payload FROM audit_events WHERE action='enterprise_models_sync' ORDER BY ts DESC LIMIT 1`,
    );
    expect(rows.rows).toHaveLength(1);
    const payload = rows.rows[0].payload as { model_count: number };
    expect(payload.model_count).toBe(2);
  });

  test('response has correct capability fields', async () => {
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
      model: 'gpt-4o',
      displayName: 'GPT-4o',
      quotaPerDay: 5000,
      // types drives the synthesized booleans; the column is legacy and the
      // read path ignores it.
      types: ['chat', 'vision', 'reasoning'],
      capabilities: {
        supports_image: false,
        supports_video: false,
        supports_thinking: false,
        context_window: 200000,
        max_tokens: 16384,
      },
    });

    const a = buildApp();
    const tok = await tokenFor('o1', 'root');
    const r = await a.request('/enterprise-models', {
      headers: { authorization: `Bearer ${tok}` },
    });
    const body = (await r.json()) as {
      models: Array<{
        displayName: string | null;
        quotaPerDay: number | null;
        capabilities: {
          supports_image: boolean;
          supports_video: boolean;
          supports_thinking: boolean;
          context_window: number | null;
          max_tokens: number | null;
        };
      }>;
    };
    expect(body.models[0].displayName).toBe('GPT-4o');
    expect(body.models[0].quotaPerDay).toBe(5000);
    expect(body.models[0].capabilities.supports_image).toBe(true);
    expect(body.models[0].capabilities.supports_thinking).toBe(true);
    expect(body.models[0].capabilities.context_window).toBe(200000);
    expect(body.models[0].capabilities.max_tokens).toBe(16384);
  });
});
