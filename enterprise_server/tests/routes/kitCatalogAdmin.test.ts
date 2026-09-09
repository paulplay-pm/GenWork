import '../helpers/setupEnv';

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import AdmZip from 'adm-zip';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { kitStoreDir } from '../../src/lib/stateDir';
import { kitCatalogAdminRoutes } from '../../src/routes/kitCatalogAdmin';

const app = new Hono();
app.route('/', kitCatalogAdminRoutes);

const CT = { 'content-type': 'application/json' };
const zipBuf = (): Buffer => { const z = new AdmZip(); z.addFile('s1/SKILL.md', Buffer.from('# a')); return Buffer.from(z.toBuffer()); };

describe('kitCatalogAdminRoutes', () => {
  let orgId: string;
  let superToken: string;
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    const r = await testPool.query('INSERT INTO orgs(id, name) VALUES ($1,$2) RETURNING id', [`org-${randomUUID().slice(0, 8)}`, 'T']);
    orgId = r.rows[0].id as string;
    superToken = await signToken({ sub: 'admin', orgId, roles: ['super_admin'] });
  });
  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });

  test('401 without a token', async () => {
    expect((await app.request('/api/admin/kits')).status).toBe(401);
  });

  test('super_admin can list (empty) and create a category', async () => {
    const list = await app.request('/api/admin/kits', { headers: auth(superToken) });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    const res = await app.request('/api/admin/kits/categories', {
      method: 'POST', headers: { ...auth(superToken), ...CT },
      body: JSON.stringify({ name_zh: '工程', name_en: 'Engineering' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { category_id: string }).category_id).toBe('engineering');
  });

  test('create a kit via parse-zip + commit; duplicate slug -> 409', async () => {
    await app.request('/api/admin/kits/categories', {
      method: 'POST', headers: { ...auth(superToken), ...CT },
      body: JSON.stringify({ name_zh: '工程', name_en: 'Engineering' }),
    });
    // parse-zip stages the zip and returns a tempToken (NO slug — flat zip).
    const parse = await app.request('/api/admin/kits/parse-zip', {
      method: 'POST', headers: { ...auth(superToken), 'content-type': 'application/octet-stream' },
      body: zipBuf(),
    });
    const p = (await parse.json()) as { size: number; tempToken: string };
    expect(parse.status).toBe(200);
    // Each create consumes (and then deletes) its staged zip, so the duplicate
    // check only runs when we hand it a FRESHLY staged zip. Hence commit takes
    // its own tempToken.
    const commit = (tempToken: string, slug: string) => app.request('/api/admin/kits', {
      method: 'POST', headers: { ...auth(superToken), ...CT },
      body: JSON.stringify({ tempToken, slug, name_en: 'Engineering', name_zh: '工程', category_id: 'engineering', scope: { allCompany: true, deptIds: [], userIds: [] } }),
    });
    let res = await commit(p.tempToken, 'engineering');
    expect(res.status).toBe(200);
    expect(existsSync(join(kitStoreDir('engineering'), 'kit.zip'))).toBe(true);
    const list = await app.request('/api/admin/kits', { headers: auth(superToken) });
    expect((await list.json()) as unknown[]).toHaveLength(1);

    // A second create with the same slug, on a fresh staged zip -> 409 slug_conflict.
    const parse2 = await app.request('/api/admin/kits/parse-zip', {
      method: 'POST', headers: { ...auth(superToken), 'content-type': 'application/octet-stream' },
      body: zipBuf(),
    });
    const p2 = (await parse2.json()) as { tempToken: string };
    res = await commit(p2.tempToken, 'engineering');
    expect(res.status).toBe(409);
  });

  test('rejects a zip with no SKILL.md (400, not 413)', async () => {
    const z = new AdmZip(); z.addFile('only/readme.txt', Buffer.from('x'));
    const res = await app.request('/api/admin/kits/parse-zip', {
      method: 'POST', headers: { ...auth(superToken), 'content-type': 'application/octet-stream' },
      body: z.toBuffer(),
    });
    expect(res.status).toBe(400);
  });
});
