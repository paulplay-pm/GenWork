import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { adminModelRoutes } from '../../src/routes/admin/models';

const app = new Hono();
app.route('/', adminModelRoutes);

describe('model routes: multi-type', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','A')`);
    await testPool.query(`INSERT INTO provider_keys(id, org_id, provider, is_builtin) VALUES ('p1','o1','openai', true)`);
  });

  test('POST with types[] stores the set + mapped legacy type', async () => {
    const tok = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1', providerKeyId: 'p1', provider: 'openai', model: 'm-x',
        types: ['chat', 'vision', 'reasoning'],
        capabilities: { contextWindow: 200000, temperature: 0.7, topP: 0.9 },
      }),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query<{ types: string[]; type: string }>(
      `SELECT types, type FROM model_catalog WHERE org_id='o1' AND model='m-x'`);
    expect(row.rows[0].types).toEqual(['chat', 'vision', 'reasoning']);
    expect(row.rows[0].type).toBe('chat'); // mapped from types[0]
  });

  test('POST rejects an out-of-set type', async () => {
    const tok = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', providerKeyId: 'p1', provider: 'openai', model: 'm-bad', types: ['chat', 'bogus'] }),
    });
    expect(res.status).toBe(400);
  });

  test('GET returns types[]', async () => {
    const tok = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    await app.request('/admin/models', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o1', providerKeyId: 'p1', provider: 'openai', model: 'm-g', types: ['asr', 'tts'] }),
    });
    const res = await app.request('/admin/models?orgId=o1', { headers: { authorization: `Bearer ${tok}` } });
    const rows = (await res.json()) as Array<{ model: string; types: string[] }>;
    expect(rows.find((r) => r.model === 'm-g')?.types).toEqual(['asr', 'tts']);
  });
});
