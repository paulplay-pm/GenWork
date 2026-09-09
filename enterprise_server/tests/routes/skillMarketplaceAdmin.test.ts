import '../helpers/setupEnv';

import AdmZip from 'adm-zip';
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
const zip = (top: string, skillMd = '---\nversion: 1.0.0\n---\n# x') =>
  (() => { const z = new AdmZip(); z.addFile(`${top}/SKILL.md`, Buffer.from(skillMd)); return z.toBuffer(); })();

// Seed a skill row directly (bypasses the two-stage parse-zip flow) so the
// category/zip-upload/slug-guard tests can place a skill in a known category
// without round-tripping a zip. scope is left to the column default.
async function seedOneSkill(name: string, org = 'o1') {
  await testPool.query(
    `INSERT INTO skill_marketplace_skills(skill_id, name_en, description_en, category_id, org_id, enabled)
     VALUES ($1,$1,'d','c1',$2,true)`,
    [name, org],
  );
}

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','A'), ('o2','B')`);
  await testPool.query(`INSERT INTO skill_marketplace_categories(category_id, name_zh, name_en, display_order, org_id)
    VALUES ('c1','分类一','Cat1',0,'o1')`);
});

describe('categories', () => {
  test('create, list, update, delete; delete re-homes skills; reserved 409', async () => {
    const tok = await admin();
    // create a fresh org-scoped category (o1)
    let res = await app.request('/api/admin/skill-marketplace/categories', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ category_id: 'design', name_zh: '设计', name_en: 'Design' }),
    });
    expect(res.status).toBe(200);

    // org-scoped list shows it
    res = await app.request('/api/admin/skill-marketplace/categories', { headers: auth(tok) });
    const cats = await res.json() as Array<{ id: string }>;
    expect(cats.map(c => c.id)).toContain('design');

    // a skill in design (seeded directly), then delete the category -> re-homed to o1's reserved bucket
    await seedOneSkill('s1');
    await testPool.query(`UPDATE skill_marketplace_skills SET category_id='design' WHERE skill_id='s1' AND org_id='o1'`);
    res = await app.request('/api/admin/skill-marketplace/categories/design', { method: 'DELETE', headers: auth(tok) });
    expect(res.status).toBe(204);
    const moved = await testPool.query<{ category_id: string }>(`SELECT category_id FROM skill_marketplace_skills WHERE skill_id='s1'`);
    expect(moved.rows[0].category_id).toBe('uncategorized');

    // deleting the reserved bucket is rejected
    res = await app.request('/api/admin/skill-marketplace/categories/uncategorized', { method: 'DELETE', headers: auth(tok) });
    expect(res.status).toBe(409);
  });

  test('unknown category on skill create -> 400', async () => {
    const tok = await admin();
    const p = await app.request('/api/admin/skill-marketplace/skills/parse-zip', {
      method: 'POST', headers: { ...auth(tok), 'content-type': 'application/zip' }, body: new Uint8Array(zip('pdf-tool')),
    });
    const { tempToken } = (await p.json()) as any;
    const res = await app.request('/api/admin/skill-marketplace/skills', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ tempToken, category_id: 'nope', scope: { allCompany: true } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('unknown_category');
  });

  test('invalid body (missing tempToken) on skill create -> 400', async () => {
    const tok = await admin();
    const res = await app.request('/api/admin/skill-marketplace/skills', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ category_id: 'c1', scope: { allCompany: true } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_body');
  });
});

describe('skill_id slug guard', () => {
  // skill_id doubles as a filesystem path segment (skillStoreDir) and as the
  // content-disposition filename on the public download route. Post-T4 the id
  // is derived from the zip's top-level directory (no longer client-supplied),
  // so the guard now lives in parseSkillZip: a non-slug top-level dir must be
  // rejected (invalid_name) before any side effect.
  test('non-slug zip top-level dir is rejected with 400 and creates no row', async () => {
    const tok = await admin();
    const z = new AdmZip(); z.addFile('.hidden/SKILL.md', '# x');
    const res = await app.request('/api/admin/skill-marketplace/skills/parse-zip', {
      method: 'POST', headers: { ...auth(tok), 'content-type': 'application/zip' }, body: new Uint8Array(z.toBuffer()),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_name');
    const rows = await testPool.query<{ n: number | string }>(`SELECT count(*) AS n FROM skill_marketplace_skills`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});

describe('zip upload', () => {
  test('rejects an empty body (400) and a good zip (200)', async () => {
    const tok = await admin();
    await seedOneSkill('s1');
    let res = await app.request('/api/admin/skill-marketplace/skills/s1/zip', {
      method: 'POST', headers: auth(tok), body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('empty');

    // a valid zip whose top-level dir matches the existing skill id overwrites
    res = await app.request('/api/admin/skill-marketplace/skills/s1/zip', {
      method: 'POST', headers: { ...auth(tok), 'content-type': 'application/zip' },
      body: new Uint8Array(zip('s1')),
    });
    expect(res.status).toBe(200);
  });

  test('rejects a zip without SKILL.md (400 bad_zip)', async () => {
    const tok = await admin();
    await seedOneSkill('s4');
    const z = new AdmZip(); z.addFile('s4/other.txt', 'hi');
    const res = await app.request('/api/admin/skill-marketplace/skills/s4/zip', {
      method: 'POST', headers: { ...auth(tok), 'content-type': 'application/zip' }, body: z.toBuffer(),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('bad_zip');
  });
});

describe('skill admin (org scope + scope sanitize + audit)', () => {
  test('parse-zip returns name/version/sha256/tempToken', async () => {
    const res = await app.request('/api/admin/skill-marketplace/skills/parse-zip', {
      method: 'POST', headers: { ...auth(await admin()), 'content-type': 'application/zip' }, body: new Uint8Array(zip('pdf-tool')),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBe('pdf-tool');
    expect(body.version).toBe('1.0.0');
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.tempToken).toBe('string');
  });

  test('parse-zip name_conflict when name already exists', async () => {
    await testPool.query(`INSERT INTO skill_marketplace_skills(skill_id, name_en, description_en, category_id, org_id, enabled) VALUES ('pdf-tool','pdf-tool','d','c1','o1',true)`);
    const res = await app.request('/api/admin/skill-marketplace/skills/parse-zip', {
      method: 'POST', headers: { ...auth(await admin()), 'content-type': 'application/zip' }, body: new Uint8Array(zip('pdf-tool')),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('name_conflict');
  });

  test('POST /skills two-stage insert + scope sanitized (invalid dept dropped) + audit', async () => {
    await testPool.query(`INSERT INTO departments(id, org_id, name, parent_id, path) VALUES ('d1','o1','R',NULL,'/R')`);
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1','o1','u1','x')`);
    const p = await app.request('/api/admin/skill-marketplace/skills/parse-zip', { method: 'POST', headers: { ...auth(await admin()), 'content-type': 'application/zip' }, body: new Uint8Array(zip('pdf-tool')) });
    const { tempToken } = (await p.json()) as any;
    const res = await app.request('/api/admin/skill-marketplace/skills', {
      method: 'POST',
      headers: { ...auth(await admin()), 'content-type': 'application/json' },
      body: JSON.stringify({ tempToken, category_id: 'c1', desc: 'desc', scope: { allCompany: false, deptIds: ['d1', 'ghost-dept'], userIds: ['u1', 'ghost-user'] } }),
    });
    expect(res.status).toBe(200);
    const { skill_id } = (await res.json()) as any;
    expect(skill_id).toBe('pdf-tool');
    const row = await testPool.query<any>(`SELECT scope FROM skill_marketplace_skills WHERE skill_id='pdf-tool' AND org_id='o1'`);
    expect(row.rows[0].scope.deptIds).toEqual(['d1']);      // ghost-dept dropped
    expect(row.rows[0].scope.userIds).toEqual(['u1']);      // ghost-user dropped
    const audit = await testPool.query(`SELECT 1 FROM audit_events WHERE action='skill_create' AND target_id='pdf-tool'`);
    expect(audit.rowCount).toBe(1);
  });

  test('PATCH toggle writes enabled + audit skill_toggle', async () => {
    await seedOneSkill('pdf-tool');
    const res = await app.request('/api/admin/skill-marketplace/skills/pdf-tool', {
      method: 'PATCH', headers: { ...auth(await admin()), 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query<any>(`SELECT enabled FROM skill_marketplace_skills WHERE skill_id='pdf-tool'`);
    expect(row.rows[0].enabled).toBe(false);
    const audit = await testPool.query(`SELECT 1 FROM audit_events WHERE action='skill_toggle' AND target_id='pdf-tool'`);
    expect(audit.rowCount).toBe(1);
  });

  test('PATCH empty_patch -> 400', async () => {
    await seedOneSkill('pdf-tool');
    const res = await app.request('/api/admin/skill-marketplace/skills/pdf-tool', {
      method: 'PATCH', headers: { ...auth(await admin()), 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('empty_patch');
  });

  test('re-upload name_mismatch when top dir != existing name', async () => {
    await seedOneSkill('pdf-tool');
    const res = await app.request('/api/admin/skill-marketplace/skills/pdf-tool/zip', {
      method: 'POST', headers: { ...auth(await admin()), 'content-type': 'application/zip' }, body: new Uint8Array(zip('other-name')),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('name_mismatch');
  });

  test('GET /skills is org-scoped (o1 skill invisible to o2 admin)', async () => {
    await seedOneSkill('pdf-tool', 'o1');
    const res = await app.request('/api/admin/skill-marketplace/skills', { headers: auth(await admin('o2')) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any[]).length).toBe(0);
  });
});
