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
import { adminModelRoutes } from '../../src/routes/admin/models';
import { authRoutes } from '../../src/routes/auth';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

const app = new Hono();
app.route('/', authRoutes);
app.route('/', adminModelRoutes);

async function seedModel(): Promise<{ providerId: string; modelId: string; token: string }> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
  const u = await authService.createUser({
    orgId: 'o1',
    username: 'admin',
    password: 'pw12345678',
  });
  const token = await signToken({ sub: u.id, orgId: 'o1', roles: ['super_admin'] });
  const k = await providerKeyVault.add({
    orgId: 'o1',
    provider: 'openai',
    plaintextKey: 'sk-test',
    endpoint: 'https://api.openai.com/v1',
    createdBy: u.id,
  });
  const m = await testPool.query<{ id: string }>(
    `INSERT INTO model_catalog(id, org_id, provider, provider_key_id, model) VALUES ($1,'o1','openai',$2,'gpt-4') RETURNING id`,
    [crypto.randomUUID(), k.id]
  );
  return { providerId: k.id, modelId: m.rows[0]!.id, token };
}

describe('PATCH /admin/models/:id', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('admin can update display_name, enabled, and capabilities', async () => {
    const { modelId, token } = await seedModel();
    const res = await app.request(`/admin/models/${modelId}?orgId=o1`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'GPT-4 (Custom)',
        enabled: false,
        capabilities: {
          temperature: 0.7,
          topP: 0.9,
          maxOutputTokens: 4096,
          supportsImage: true,
          supportsVideo: false,
          supportsThinking: true,
        },
      }),
    });
    expect(res.status).toBe(200);
    const r = await testPool.query<{
      display_name: string | null;
      enabled: boolean;
      temperature: number | null;
      top_p: number | null;
      max_output_tokens: number | null;
      supports_image: boolean;
      supports_video: boolean;
      supports_thinking: boolean;
    }>(
      `SELECT display_name, enabled, temperature, top_p, max_output_tokens,
              supports_image, supports_video, supports_thinking
         FROM model_catalog WHERE id = $1`,
      [modelId]
    );
    expect(r.rows[0].display_name).toBe('GPT-4 (Custom)');
    expect(r.rows[0].enabled).toBe(false);
    expect(Number(r.rows[0].temperature)).toBe(0.7);
    expect(Number(r.rows[0].top_p)).toBe(0.9);
    expect(r.rows[0].max_output_tokens).toBe(4096);
    expect(r.rows[0].supports_image).toBe(true);
    expect(r.rows[0].supports_video).toBe(false);
    expect(r.rows[0].supports_thinking).toBe(true);
  });

  test('non-admin gets 403', async () => {
    const { modelId } = await seedModel();
    const u = await authService.createUser({
      orgId: 'o1',
      username: 'mod',
      password: 'pw12345678',
    });
    const tok = await signToken({ sub: u.id, orgId: 'o1', roles: ['user'] });
    const res = await app.request(`/admin/models/${modelId}?orgId=o1`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
  });

  test('cross-org id returns 404', async () => {
    const { modelId } = await seedModel();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','T2')`);
    const u2 = await authService.createUser({
      orgId: 'o2',
      username: 'a2',
      password: 'pw12345678',
    });
    const tok2 = await signToken({ sub: u2.id, orgId: 'o2', roles: ['super_admin'] });
    const res = await app.request(`/admin/models/${modelId}?orgId=o2`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok2}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  test('rejects temperature > 2 with 400', async () => {
    const { modelId, token } = await seedModel();
    const res = await app.request(`/admin/models/${modelId}?orgId=o1`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: { temperature: 5 } }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /admin/models/:id', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('DELETE removes the model row', async () => {
    const { modelId, token } = await seedModel();
    const res = await app.request(`/admin/models/${modelId}?orgId=o1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const r = await testPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM model_catalog WHERE id = $1',
      [modelId]
    );
    expect(r.rows[0].n).toBe(0);
  });

  test('DELETE on missing id returns 404', async () => {
    const { token } = await seedModel();
    const res = await app.request(
      '/admin/models/00000000-0000-0000-0000-000000000000?orgId=o1',
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }
    );
    expect(res.status).toBe(404);
  });
});

describe('GET/POST /admin/models with params', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('POST persists params and GET returns them', async () => {
    const { providerId, token } = await seedModel();
    const res = await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1',
        providerKeyId: providerId,
        provider: 'openai',
        model: 'gpt-4-turbo',
        displayName: 'GPT-4 Turbo',
        capabilities: {
          temperature: 0.5,
          topP: 0.95,
          maxOutputTokens: 8192,
          supportsImage: true,
          supportsVideo: false,
          supportsThinking: false,
        },
      }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(created.id).toBeTruthy();

    const list = await app.request('/admin/models?orgId=o1', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as Array<{
      id: string;
      model: string;
      temperature: number;
      top_p: number;
      max_output_tokens: number;
      supports_image: boolean;
      supports_thinking: boolean;
    }>;
    const found = rows.find((r) => r.id === created.id);
    expect(found).toBeDefined();
    expect(found!.temperature).toBe(0.5);
    expect(found!.top_p).toBe(0.95);
    expect(found!.max_output_tokens).toBe(8192);
    expect(found!.supports_image).toBe(true);
    expect(found!.supports_thinking).toBe(false);
  });

  test('POST with duplicate (providerKeyId, model) returns 409', async () => {
    const { providerId, token } = await seedModel();
    // First create
    const r1 = await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1',
        providerKeyId: providerId,
        provider: 'openai',
        model: 'gpt-4-dup',
        capabilities: {},
      }),
    });
    expect(r1.status).toBe(200);
    // Second create with same model
    const r2 = await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1',
        providerKeyId: providerId,
        provider: 'openai',
        model: 'gpt-4-dup',
        capabilities: {},
      }),
    });
    expect(r2.status).toBe(409);
  });
});
