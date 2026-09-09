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
import { adminProviderKeyRoutes } from '../../src/routes/admin/providerKeys';
import { authRoutes } from '../../src/routes/auth';
import { providerKeyVault } from '../../src/vault/providerKeyVault';

const app = new Hono();
app.route('/', authRoutes);
app.route('/', adminProviderKeyRoutes);

async function seedAdmin(orgName = 'T'): Promise<{ id: string; token: string }> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1', $1)`, [orgName]);
  const u = await authService.createUser({
    orgId: 'o1',
    username: 'admin',
    password: 'pw12345678',
  });
  const token = await signToken({ sub: u.id, orgId: 'o1', roles: ['super_admin'] });
  const k = await providerKeyVault.add({
    orgId: 'o1',
    provider: 'openai',
    plaintextKey: 'sk-orig',
    endpoint: 'https://api.openai.com/v1',
    createdBy: u.id,
  });
  return { id: k.id, token };
}

describe('admin/provider-keys/:id mutations', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('admin can update description, baseUrl, label', async () => {
    const { id, token } = await seedAdmin();
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'Primary provider',
        baseUrl: 'https://api.openai.com/v2',
        label: 'prod',
      }),
    });
    expect(res.status).toBe(200);
    const r = await testPool.query<{
      description: string | null;
      endpoint: string | null;
      label: string | null;
    }>(
      'SELECT description, endpoint, label FROM provider_keys WHERE id = $1',
      [id],
    );
    expect(r.rows[0].description).toBe('Primary provider');
    expect(r.rows[0].endpoint).toBe('https://api.openai.com/v2');
    expect(r.rows[0].label).toBe('prod');
    // Successful PATCH is audited with the fields actually passed.
    const audit = await testPool.query<{ target_id: string | null; payload: unknown }>(
      `SELECT target_id, payload FROM audit_events WHERE action='provider_key_update'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].target_id).toBe(id);
    expect(audit.rows[0].payload).toEqual({
      fields: {
        description: 'Primary provider',
        endpoint: 'https://api.openai.com/v2',
        label: 'prod',
      },
      changedKey: false,
    });
  });

  test('no-op PATCH (empty body) is NOT audited as an update', async () => {
    const { id, token } = await seedAdmin();
    // An empty (or malformed) body yields `fields = {}` and the vault returns
    // `true` for a no-op update — the route must not record an audit row for
    // a change that changed nothing.
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const audit = await testPool.query<{ id: string }>(
      `SELECT id FROM audit_events WHERE action='provider_key_update'`,
    );
    expect(audit.rows).toHaveLength(0);
  });

  test('non-admin (model_admin role, no super_admin) gets 403', async () => {
    const { id } = await seedAdmin();
    const u = await authService.createUser({
      orgId: 'o1',
      username: 'mod',
      password: 'pw12345678',
    });
    const tok = await signToken({ sub: u.id, orgId: 'o1', roles: ['user'] });
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'X' }),
    });
    expect(res.status).toBe(403);
  });

  test('provider-keys are gated on provider points, not model points', async () => {
    await seedAdmin(); // o1 + a provider key + super_admin
    // model_admin carries the fine model:* + provider:* points (migration 029),
    // so it can read provider keys...
    const maTok = await signToken({ sub: 'u-ma', orgId: 'o1', roles: ['model_admin'] });
    const ok = await app.request('/admin/provider-keys?orgId=o1', {
      headers: { authorization: `Bearer ${maTok}` },
    });
    expect(ok.status).toBe(200);
    // ...but a role with only model points is denied — the gate no longer
    // keys off model points.
    await testPool.query(
      `INSERT INTO roles(id, name, permissions)
       VALUES ('models-only', 'models_only', '["model:view"]'::jsonb)`
    );
    const moTok = await signToken({ sub: 'u-mo', orgId: 'o1', roles: ['models_only'] });
    const denied = await app.request('/admin/provider-keys?orgId=o1', {
      headers: { authorization: `Bearer ${moTok}` },
    });
    expect(denied.status).toBe(403);
  });

  test('cross-org id returns 404', async () => {
    const { id } = await seedAdmin();
    // second org
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','T2')`);
    const u2 = await authService.createUser({
      orgId: 'o2',
      username: 'admin2',
      password: 'pw12345678',
    });
    const tok2 = await signToken({ sub: u2.id, orgId: 'o2', roles: ['super_admin'] });
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok2}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'X' }),
    });
    expect(res.status).toBe(404);
  });

  test('DELETE cascades to models and returns count', async () => {
    const { id, token } = await seedAdmin();
    // Insert 2 model rows for this provider
    await testPool.query(
      `INSERT INTO model_catalog(id, org_id, provider_key_id, provider, model) VALUES
        ('m1', 'o1', $1, 'openai', 'gpt-4'),
        ('m2', 'o1', $1, 'openai', 'gpt-3.5')`,
      [id],
    );
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deletedModels: number };
    expect(body.ok).toBe(true);
    expect(body.deletedModels).toBe(2);

    const r = await testPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM provider_keys WHERE id = $1',
      [id]
    );
    expect(r.rows[0].n).toBe(0);
    const r2 = await testPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM model_catalog WHERE provider_key_id = $1',
      [id]
    );
    expect(r2.rows[0].n).toBe(0);
    // Successful DELETE is audited with the provider and cascade count.
    const audit = await testPool.query<{ target_id: string | null; payload: unknown }>(
      `SELECT target_id, payload FROM audit_events WHERE action='provider_key_delete'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].target_id).toBe(id);
    expect(audit.rows[0].payload).toEqual({ provider: 'openai', deletedModels: 2 });
  });

  test('DELETE on missing id returns 404', async () => {
    const { token } = await seedAdmin();
    const res = await app.request('/admin/provider-keys/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  test('test endpoint returns failed when upstream is unreachable', async () => {
    const { id, token } = await seedAdmin();
    // Re-point endpoint at a port nothing is listening on so both
    // /health and /v1/models will fail fast.
    await testPool.query(`UPDATE provider_keys SET endpoint = $1 WHERE id = $2`, [
      'http://127.0.0.1:1',
      id,
    ]);
    const res = await app.request(`/admin/provider-keys/${id}/test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      latencyMs: number;
      lastTestAt: string;
    };
    expect(body.status).toBe('failed');
    expect(typeof body.latencyMs).toBe('number');
    expect(typeof body.lastTestAt).toBe('string');

    const r = await testPool.query<{ status: string; latency_ms: number | null }>(
      'SELECT status, latency_ms FROM provider_keys WHERE id = $1',
      [id],
    );
    expect(r.rows[0].status).toBe('failed');
    expect(typeof r.rows[0].latency_ms).toBe('number');
  });

  test('test endpoint on missing id returns 404', async () => {
    const { token } = await seedAdmin();
    const res = await app.request(
      '/admin/provider-keys/00000000-0000-0000-0000-000000000000/test',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /admin/provider-keys', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('response includes extended fields', async () => {
    const { id, token } = await seedAdmin();
    await testPool.query(
      `UPDATE provider_keys SET description = $1, status = $2, latency_ms = $3,
        last_test_at = NOW(), api_key_masked = $4 WHERE id = $5`,
      ['Note text', 'connected', 142, 'sk-••••••••abc123', id],
    );

    const res = await app.request('/admin/provider-keys?orgId=o1', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      id: string;
      description: string;
      status: string;
      latency_ms: number;
      last_test_at: string;
      api_key_masked: string;
    }>;
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.description).toBe('Note text');
    expect(row!.status).toBe('connected');
    expect(row!.latency_ms).toBe(142);
    expect(row!.last_test_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(row!.api_key_masked).toBe('sk-••••••••abc123');
  });
});
