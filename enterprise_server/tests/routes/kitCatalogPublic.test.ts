import '../helpers/setupEnv';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { kitStoreDir } from '../../src/lib/stateDir';
import { kitCatalogRoutes } from '../../src/routes/kitCatalog';

const app = new Hono();
app.route('/', kitCatalogRoutes);

/** Insert a kit row directly (kit_catalog has no FK to users/departments). */
async function mkKit(slug: string, scope: object, enabled = true): Promise<void> {
  await testPool.query(
    `INSERT INTO kit_catalog (slug, org_id, name_en, name_zh, description_en, description_zh, scope, enabled, try_asking, skill_list)
     VALUES ($1, 'o1', $2, $2, 'D', 'D', $3, $4, '[]', '[]')`,
    [slug, slug, JSON.stringify(scope), enabled],
  );
}

/** Minimal org + dept tree + users + memberships (mirror mcpMarketplaceScope.test.ts).
 *   rd -> /rd (parent); fe -> /rd/fe (child); sales -> /sales (sibling). */
async function seed(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1')`);
  await testPool.query(
    `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES
       ('rd', 'o1', '研发', NULL, '/rd'),
       ('fe', 'o1', '前端', 'rd', '/rd/fe'),
       ('sales', 'o1', '销售', NULL, '/sales')`);
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash, display_name) VALUES
       ('u2', 'o1', 'u2', 'x', 'U2'),
       ('u3', 'o1', 'u3', 'x', 'U3'),
       ('admin', 'o1', 'admin', 'x', 'Admin')`);
  await testPool.query(
    `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES
       ('u2', 'fe', true),
       ('u3', 'sales', true)`);
  await mkKit('all', { allCompany: true, deptIds: [], userIds: [] });
  await mkKit('rdkit', { allCompany: false, deptIds: ['rd'], userIds: [] });     // granted to PARENT rd
  await mkKit('saleskit', { allCompany: false, deptIds: ['sales'], userIds: [] }); // sibling
  await mkKit('off', { allCompany: true, deptIds: [], userIds: [] }, false);   // disabled
}

const tok = (sub: string, roles: string[] = ['member']) => signToken({ sub, orgId: 'o1', roles });
async function list(sub: string, roles: string[] = ['member']): Promise<{ kits: Array<{ id: string }> }> {
  const res = await app.request('/api/kits', { headers: { authorization: `Bearer ${await tok(sub, roles)}` } });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ kits: Array<{ id: string }> }>;
}

describe('kitCatalogRoutes (scope-based)', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); await seed(); });

  test('returns 401 without a token', async () => {
    expect((await app.request('/api/kits')).status).toBe(401);
  });

  test('a member in fe (under rd) sees the all-company + subtree-granted kits, not the sibling or disabled', async () => {
    const ids = (await list('u2')).kits.map((k) => k.id).sort();
    expect(ids).toEqual(['all', 'rdkit']);   // not saleskit (sibling), not off (disabled)
  });

  test('a member in sales sees all + saleskit, NOT the rd-subtree kit', async () => {
    const ids = (await list('u3')).kits.map((k) => k.id).sort();
    expect(ids).toEqual(['all', 'saleskit']);
  });

  test('super_admin sees every ENABLED kit regardless of scope, never the disabled one', async () => {
    const ids = (await list('admin', ['super_admin'])).kits.map((k) => k.id).sort();
    expect(ids).toEqual(['all', 'rdkit', 'saleskit']);
  });

  test('an all-company kit is downloadable and the wire bundle path is relative', async () => {
    const dir = kitStoreDir('all');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'kit.zip'), 'ZIPBYTES');
    const dl = await app.request('/api/kits/download/all', { headers: { authorization: `Bearer ${await tok('u2')}` } });
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('ZIPBYTES');
    const body = (await (await app.request('/api/kits', { headers: { authorization: `Bearer ${await tok('u2')}` } })).json()) as
      { kits: Array<{ id: string; skills: { bundle: string } }> };
    expect(body.kits.find((k) => k.id === 'all')!.skills.bundle).toBe('/api/kits/download/all');
  });

  test('a dept-scoped kit is NOT downloadable by an out-of-scope member (404)', async () => {
    const dl = await app.request('/api/kits/download/saleskit', { headers: { authorization: `Bearer ${await tok('u2')}` } });
    expect(dl.status).toBe(404);
  });
});
