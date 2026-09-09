import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { skillMarketplaceAdminRoutes } from '../../src/routes/skillMarketplaceAdmin';

const app = new Hono();
app.route('/', skillMarketplaceAdminRoutes);
const admin = async (org = 'o1') => signToken({ sub: 'a', orgId: org, roles: ['super_admin'] });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const json = { 'content-type': 'application/json' };
const postCategory = (tok: string, body: unknown) =>
  app.request('/api/admin/skill-marketplace/categories', {
    method: 'POST', headers: { ...auth(tok), ...json }, body: JSON.stringify(body),
  });

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','A'), ('o2','B')`);
});

describe('skill categories (org-scoped, T5 full rework)', () => {
  test('create category scoped to org; duplicate slug -> name_conflict', async () => {
    const tok = await admin();
    const r1 = await postCategory(tok, { name_zh: '设计', name_en: 'Design' });
    expect(r1.status).toBe(200);
    // category_id is a server-generated slug of name_en — the client does not supply it
    expect((await r1.json() as any).category_id).toBe('design');

    const r2 = await postCategory(tok, { name_zh: '设计', name_en: 'Design' });
    expect(r2.status).toBe(409);
    expect((await r2.json() as any).error).toBe('name_conflict');

    // R18: the create is audited (targetId = the slug)
    const audit = await testPool.query(
      `SELECT 1 FROM audit_events WHERE action='skill_category_create' AND org_id='o1' AND target_id='design'`);
    expect(audit.rowCount).toBe(1);
  });

  test('delete uncategorized -> reserved_category', async () => {
    const res = await app.request('/api/admin/skill-marketplace/categories/uncategorized', {
      method: 'DELETE', headers: auth(await admin()),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('reserved_category');
  });

  test('categories are org-isolated', async () => {
    await postCategory(await admin('o1'), { name_zh: '设计', name_en: 'Design' });
    const res = await app.request('/api/admin/skill-marketplace/categories', { headers: auth(await admin('o2')) });
    const list = (await res.json()) as any[];
    expect(list.some((c) => c.name_en === 'Design')).toBe(false);
  });

  test('R19: cross-org write isolation — o2 DELETE on o1 category -> 404, no mutation', async () => {
    const tok1 = await admin('o1');
    await postCategory(tok1, { name_zh: '设计', name_en: 'Design' });

    const res = await app.request('/api/admin/skill-marketplace/categories/design', {
      method: 'DELETE', headers: auth(await admin('o2')),
    });
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe('not_found');

    // o1's category survives the foreign delete attempt
    const list = await app.request('/api/admin/skill-marketplace/categories', { headers: auth(tok1) });
    expect(((await list.json()) as any[]).some((c) => c.id === 'design')).toBe(true);
  });

  test('R19: cross-org write isolation — o2 PUT on o1 category -> 404, no mutation', async () => {
    const tok1 = await admin('o1');
    await postCategory(tok1, { name_zh: '设计', name_en: 'Design' });

    const res = await app.request('/api/admin/skill-marketplace/categories/design', {
      method: 'PUT', headers: { ...auth(await admin('o2')), ...json },
      body: JSON.stringify({ name_zh: 'Hacked', name_en: 'Hacked' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe('not_found');

    const row = await testPool.query<{ name_zh: string; name_en: string }>(
      `SELECT name_zh, name_en FROM skill_marketplace_categories WHERE org_id='o1' AND category_id='design'`);
    expect(row.rows[0]).toEqual({ name_zh: '设计', name_en: 'Design' });
  });

  test('R17: delete re-homes to the reserved bucket even when the org lacks it (legacy zero-category org)', async () => {
    // Simulate a pre-038-trigger org: remove o1's seeded uncategorized bucket
    // so the only thing that can re-create it is the delete path's guarantee.
    await testPool.query(`DELETE FROM skill_marketplace_categories WHERE org_id='o1' AND category_id='uncategorized'`);

    const tok = await admin('o1');
    await postCategory(tok, { name_zh: '设计', name_en: 'Design' });
    // a skill living in the to-be-deleted category
    await testPool.query(
      `INSERT INTO skill_marketplace_skills(skill_id, name_en, description_en, category_id, org_id, enabled)
       VALUES ('s1','S','d','design','o1',true)`);

    const res = await app.request('/api/admin/skill-marketplace/categories/design', {
      method: 'DELETE', headers: auth(tok),
    });
    expect(res.status).toBe(204);

    // the reserved bucket was re-created for o1 ...
    const bucket = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM skill_marketplace_categories WHERE org_id='o1' AND category_id='uncategorized'`);
    expect(bucket.rows[0].n).toBe(1);
    // ... and the skill was re-homed into it (no dangling category_id).
    const moved = await testPool.query<{ category_id: string }>(
      `SELECT category_id FROM skill_marketplace_skills WHERE skill_id='s1' AND org_id='o1'`);
    expect(moved.rows[0].category_id).toBe('uncategorized');
  });

  test('PUT uncategorized -> reserved_category (R20: reserved guard is global, not just DELETE)', async () => {
    const res = await app.request('/api/admin/skill-marketplace/categories/uncategorized', {
      method: 'PUT', headers: { ...auth(await admin()), ...json },
      body: JSON.stringify({ name_zh: 'hacked' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('reserved_category');
  });
});
