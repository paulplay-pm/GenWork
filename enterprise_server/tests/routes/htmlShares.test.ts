import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { htmlSharesRoutes } from '../../src/routes/htmlShares';

const app = new Hono();
app.route('/', htmlSharesRoutes);

const tokenFor = async (sub: string, orgId: string): Promise<string> =>
  signToken({ sub, orgId, roles: ['user'] });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('htmlShares routes', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('POST creates a row and returns publicUrl', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'My report',
        sourceType: 'html_file',
        sourceSha256: 'abc123',
        clientSourceKey: 'k1',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { shareId: string; publicUrl: string; expiresAt: string | null };
    expect(body.shareId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.publicUrl).toContain(`/api/pages/${body.shareId}`);
    expect(body.expiresAt).toBeNull();
  });

  test('POST with accessMode=org stores access_mode=org atomically', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Org only',
        sourceType: 'html_file',
        sourceSha256: 'abc123',
        clientSourceKey: 'k-org',
        accessMode: 'org',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { shareId: string; accessMode: string };
    expect(body.accessMode).toBe('org');
    const row = await testPool.query<{ access_mode: string }>(
      `SELECT access_mode FROM html_shares WHERE share_id = $1`,
      [body.shareId]
    );
    expect(row.rows[0]?.access_mode).toBe('org');
  });

  test('POST with no accessMode defaults access_mode=public (never code)', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Default',
        sourceType: 'html_file',
        sourceSha256: 'abc123',
        clientSourceKey: 'k-def',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { shareId: string; accessMode: string };
    expect(body.accessMode).toBe('public');
    const row = await testPool.query<{ access_mode: string }>(
      `SELECT access_mode FROM html_shares WHERE share_id = $1`,
      [body.shareId]
    );
    expect(row.rows[0]?.access_mode).toBe('public');
  });

  test('POST with a legacy accessMode=code is normalized to public', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Legacy code',
        sourceType: 'html_file',
        sourceSha256: 'abc123',
        clientSourceKey: 'k-code',
        accessMode: 'code',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { shareId: string; accessMode: string };
    expect(body.accessMode).toBe('public');
    const row = await testPool.query<{ access_mode: string }>(
      `SELECT access_mode FROM html_shares WHERE share_id = $1`,
      [body.shareId]
    );
    expect(row.rows[0]?.access_mode).toBe('public');
  });

  test('POST returns 400 when title missing', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    expect(res.status).toBe(400);
  });

  test('GET returns 404 for missing share', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/html-shares/00000000-0000-0000-0000-000000000000', {
      headers: auth(tok),
    });
    expect(res.status).toBe(404);
  });

  test('GET returns 404 for share in another org', async () => {
    const tokA = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tokA), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };
    const tokB = await tokenFor('u2', 'o2');
    const res = await app.request(`/api/html-shares/${shareId}`, { headers: auth(tokB) });
    expect(res.status).toBe(404);
  });

  test('DELETE returns 401 for non-owner', async () => {
    const tokA = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tokA), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };
    const tokB = await tokenFor('u2', 'o1');
    const res = await app.request(`/api/html-shares/${shareId}`, { method: 'DELETE', headers: auth(tokB) });
    expect(res.status).toBe(401);
  });

  test('DELETE returns 200 and removes row for owner', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };
    const del = await app.request(`/api/html-shares/${shareId}`, { method: 'DELETE', headers: auth(tok) });
    expect(del.status).toBe(200);
    const after = await app.request(`/api/html-shares/${shareId}`, { headers: auth(tok) });
    expect(after.status).toBe(404);
  });

  test('GET /quota returns { used, quota: 100 }', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/html-shares/quota', { headers: auth(tok) });
    expect(res.status).toBe(200);
    const body = await res.json() as { used: number; quota: number };
    expect(body.used).toBe(0);
    expect(body.quota).toBe(100);
  });
});
