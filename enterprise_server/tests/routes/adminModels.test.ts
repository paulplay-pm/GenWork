import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations,testPool } from '../../src/db/testDb';
import { modelCatalog, ModelType } from '../../src/models/modelCatalog';
import { adminModelRoutes } from '../../src/routes/admin/models';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

async function token(orgId: string, userId: string): Promise<string> {
  return signToken({ sub: userId, orgId, roles: ['model_admin'] });
}

const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

describe('routes/admin/models (type field)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1','T','UTC') ON CONFLICT DO NOTHING`);
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1','o1','u','x') ON CONFLICT DO NOTHING`);
  });

  async function keyId(): Promise<string> {
    const k = await providerKeyVault.add({ orgId: 'o1', provider: 'vllm', plaintextKey: 'k', label: 'p', createdBy: 'u1' });
    return k.id;
  }

  test('defaults to chat when type is not provided', async () => {
    const a = new Hono();
    a.route('/', adminModelRoutes);
    const t = await token('o1', 'u1');
    const pk = await keyId();

    const res = await a.request('/admin/models', {
      method: 'POST',
      headers: auth(t),
      body: JSON.stringify({ orgId: 'o1', providerKeyId: pk, provider: 'vllm', model: 'llama' }),
    });
    expect(res.status).toBe(200);

    const { id } = (await res.json()) as { id: string };
    const listed = await modelCatalog.listForAdmin('o1');
    expect(listed.find((m) => m.id === id)?.type).toBe(ModelType.Chat);
  });

  test('persists an explicit type on create', async () => {
    const a = new Hono();
    a.route('/', adminModelRoutes);
    const t = await token('o1', 'u1');
    const pk = await keyId();

    const res = await a.request('/admin/models', {
      method: 'POST',
      headers: auth(t),
      body: JSON.stringify({
        orgId: 'o1',
        providerKeyId: pk,
        provider: 'vllm',
        model: 'llama',
        type: 'vision',
      }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const listed = await modelCatalog.listForAdmin('o1');
    expect(listed.find((m) => m.id === id)?.type).toBe(ModelType.Vision);
  });

  test('PATCH updates type', async () => {
    const a = new Hono();
    a.route('/', adminModelRoutes);
    const t = await token('o1', 'u1');
    const pk = await keyId();
    const created = await modelCatalog.add({ orgId: 'o1', providerKeyId: pk, provider: 'vllm', model: 'llama' });

    const res = await a.request(`/admin/models/${created.id}?orgId=o1`, {
      method: 'PATCH',
      headers: auth(t),
      body: JSON.stringify({ type: 'embedding' }),
    });
    expect(res.status).toBe(200);
    const listed = await modelCatalog.listForAdmin('o1');
    expect(listed.find((m) => m.id === created.id)?.type).toBe(ModelType.Embedding);
  });

  test('PATCH rejects an invalid type', async () => {
    const a = new Hono();
    a.route('/', adminModelRoutes);
    const t = await token('o1', 'u1');
    const pk = await keyId();
    const created = await modelCatalog.add({ orgId: 'o1', providerKeyId: pk, provider: 'vllm', model: 'llama' });

    const res = await a.request(`/admin/models/${created.id}?orgId=o1`, {
      method: 'PATCH',
      headers: auth(t),
      body: JSON.stringify({ type: 'quantum' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('validation_error');
  });
});
