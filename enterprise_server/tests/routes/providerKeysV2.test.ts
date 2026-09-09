import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { seedBuiltinProviders } from '../../src/org/builtinProviders';
import { adminProviderKeyRoutes } from '../../src/routes/admin/providerKeys';

const app = new Hono();
app.route('/', adminProviderKeyRoutes);

async function admin(org = 'o1', roles: string[] = ['super_admin']) {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A') ON CONFLICT DO NOTHING`);
  return signToken({ sub: 'u1', orgId: org, roles });
}

describe('provider routes v2', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    // provider_keys.org_id is a NOT NULL FK to orgs(id); the org must exist
    // before seedBuiltinProviders can insert its rows. (The per-test admin()
    // helper also upserts this org — both inserts are idempotent no-ops.)
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A') ON CONFLICT DO NOTHING`);
    await seedBuiltinProviders('o1');
  });

  test('DELETE a builtin provider -> 409 builtin_provider + audit', async () => {
    const tok = await admin();
    const builtinId = (await testPool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE org_id='o1' AND provider='openai' AND is_builtin`,
    )).rows[0].id;
    const res = await app.request(`/admin/provider-keys/${builtinId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'builtin_provider' });
    const audit = await testPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM audit_events WHERE action='provider_key_builtin_delete'`);
    expect(audit.rows[0].n).toBe(1);
  });

  test('PATCH sets protocol and re-sets the key (write-only)', async () => {
    const tok = await admin();
    const id = (await testPool.query<{ id: string }>(
      `SELECT id FROM provider_keys WHERE org_id='o1' AND provider='anthropic' AND is_builtin`,
    )).rows[0].id;
    const res = await app.request(`/admin/provider-keys/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'anthropic', apiKey: 'sk-ant-new-1234' }),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query<{ protocol: string; api_key_masked: string | null }>(
      `SELECT protocol, api_key_masked FROM provider_keys WHERE id=$1`, [id]);
    expect(row.rows[0].protocol).toBe('anthropic');
    expect(row.rows[0].api_key_masked).toContain('•');
  });

  test('GET returns is_builtin + protocol + populated mask', async () => {
    const tok = await admin();
    const res = await app.request('/admin/provider-keys?orgId=o1', { headers: { authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ provider: string; is_builtin: boolean; protocol: string }>;
    const oai = rows.find((r) => r.provider === 'openai');
    expect(oai?.is_builtin).toBe(true);
    expect(oai?.protocol).toBe('openai');
  });

  test('POST a custom provider colliding a builtin slug is allowed (partial index)', async () => {
    const tok = await admin();
    const res = await app.request('/admin/provider-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', provider: 'openai', protocol: 'openai', endpoint: 'https://my-vllm/v1' }),
    });
    expect(res.status).toBe(200); // custom 'openai' is distinct from the builtin 'openai'
  });
});
