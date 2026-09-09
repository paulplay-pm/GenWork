import '../helpers/setupEnv';

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { scopeApi } from '../../src/auth/scopeResolver';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { stateDir } from '../../src/lib/stateDir';
import { skillMarketplaceRoutes } from '../../src/routes/skillMarketplace';

const app = new Hono();
app.route('/', skillMarketplaceRoutes);
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await scopeApi.invalidate();
  // skillStoreDir lives under the shared state dir; reset the on-disk skill
  // store so the download tests are deterministic across runs.
  rmSync(join(stateDir(), 'skill-marketplace'), { recursive: true, force: true });
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','A'), ('o2','B')`);
  await testPool.query(`INSERT INTO departments(id, org_id, name, parent_id, path) VALUES
    ('d1','o1','Root',NULL,'/Root'), ('d2','o1','Child','d1','/Root/Child')`);
  await testPool.query(`INSERT INTO users(id, org_id, username, password_hash) VALUES
    ('u-root','o1','ur','x'), ('u-child','o1','uc','x'), ('u-priv','o1','up','x')`);
  await testPool.query(`INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES
    ('u-root','d1',true), ('u-child','d2',true), ('u-priv','d1',true)`);
  await testPool.query(`INSERT INTO skill_marketplace_categories(category_id, name_zh, name_en, display_order, org_id)
    VALUES ('c1','分类一','Cat1',0,'o1')`);
});

async function skill(id: string, org: string, scope: object, enabled = true) {
  await testPool.query(
    `INSERT INTO skill_marketplace_skills(skill_id,name_en,description_en,category_id,org_id,scope,enabled,zip_sha256,zip_file_size)
     VALUES ($1,$1,'d','c1',$2,$3,$4,repeat('a',64),100)`,
    [id, org, JSON.stringify(scope), enabled],
  );
}

describe('auth gate (401 without a token)', () => {
  test('GET list -> 401', async () => {
    expect((await app.request('/api/skill-marketplace')).status).toBe(401);
  });
  test('GET download -> 401', async () => {
    expect((await app.request('/api/skill-marketplace/download/s-all')).status).toBe(401);
  });
  test('POST verify -> 401', async () => {
    const res = await app.request('/api/skill-marketplace/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 's-all' }) });
    expect(res.status).toBe(401);
  });
  test('POST events -> 401', async () => {
    const res = await app.request('/api/skill-marketplace/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 's-all', event: 'invoke' }) });
    expect(res.status).toBe(401);
  });
});

describe('public skill marketplace (org + scope filter)', () => {
  test('allCompany visible to a member', async () => {
    await skill('s-all', 'o1', { allCompany: true, deptIds: [], userIds: [] });
    const res = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    const body = (await res.json()) as any;
    expect(body.skills.map((s: any) => s.id)).toContain('s-all');
    expect('sha256' in body.skills[0]).toBe(true);
    expect('allowed_roles' in body.skills[0]).toBe(false);
  });

  test('dept scope: member in child dept sees a skill granted to root', async () => {
    await skill('s-root', 'o1', { allCompany: false, deptIds: ['d1'], userIds: [] });
    const res = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    const body = (await res.json()) as any;
    expect(body.skills.map((s: any) => s.id)).toContain('s-root');
  });

  test('member-exception scope', async () => {
    await skill('s-priv', 'o1', { allCompany: false, deptIds: [], userIds: ['u-priv'] });
    const yes = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-priv', orgId: 'o1', roles: ['member'] })) });
    const no = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    expect(((await yes.json()) as any).skills.map((s: any) => s.id)).toContain('s-priv');
    expect(((await no.json()) as any).skills.map((s: any) => s.id)).not.toContain('s-priv');
  });

  test('stale scope dept id: member in deleted dept subtree does NOT see it, no 500', async () => {
    // skill scoped to a dept id that does not exist in departments
    await skill('s-ghost', 'o1', { allCompany: false, deptIds: ['ghost-dept'], userIds: [] });
    const res = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).skills.map((s: any) => s.id)).not.toContain('s-ghost');
  });

  test('empty scope: invisible to non-superadmin, visible to superadmin', async () => {
    await skill('s-empty', 'o1', { allCompany: false, deptIds: [], userIds: [] });
    const member = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    const superadmin = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'sa', orgId: 'o1', roles: ['super_admin'] })) });
    expect(((await member.json()) as any).skills.map((s: any) => s.id)).not.toContain('s-empty');
    expect(((await superadmin.json()) as any).skills.map((s: any) => s.id)).toContain('s-empty');
  });

  test('cross-org: o2 member sees none of o1 skills (incl. allCompany)', async () => {
    await skill('s-all', 'o1', { allCompany: true, deptIds: [], userIds: [] });
    const res = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'o2user', orgId: 'o2', roles: ['member'] })) });
    expect(((await res.json()) as any).skills).toEqual([]);
  });
});

describe('download / verify / events (re-check + cross-org 404)', () => {
  beforeEach(async () => {
    // (reuse the org/dept/user/category seed from the top-level beforeEach)
    await skill('s-all', 'o1', { allCompany: true, deptIds: [], userIds: [] });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { skillStoreDir } = await import('../../src/lib/stateDir');
    mkdirSync(skillStoreDir('s-all'), { recursive: true });
    writeFileSync(path.join(skillStoreDir('s-all'), 'skill.zip'), Buffer.from('zipbytes'));
  });

  test('download 200 for authorized member', async () => {
    const res = await app.request('/api/skill-marketplace/download/s-all', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('zipbytes');
  });

  test('download cross-org -> 404 (no enumeration)', async () => {
    const res = await app.request('/api/skill-marketplace/download/s-all', { headers: auth(await signToken({ sub: 'o2user', orgId: 'o2', roles: ['member'] })) });
    expect(res.status).toBe(404);
  });

  test('verify returns allowed=true / cross-org false', async () => {
    const ok = await app.request('/api/skill-marketplace/verify', { method: 'POST', headers: { ...auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })), 'content-type': 'application/json' }, body: JSON.stringify({ name: 's-all' }) });
    const cross = await app.request('/api/skill-marketplace/verify', { method: 'POST', headers: { ...auth(await signToken({ sub: 'o2user', orgId: 'o2', roles: ['member'] })), 'content-type': 'application/json' }, body: JSON.stringify({ name: 's-all' }) });
    expect((await ok.json()) as any).toEqual({ allowed: true });
    expect((await cross.json()) as any).toEqual({ allowed: false });
  });

  test('events increments use_count_30d and never 500s', async () => {
    const res = await app.request('/api/skill-marketplace/events', { method: 'POST', headers: { ...auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })), 'content-type': 'application/json' }, body: JSON.stringify({ name: 's-all', event: 'invoke' }) });
    expect(res.status).toBe(200);
    const row = await testPool.query<any>(`SELECT use_count_30d FROM skill_marketplace_skills WHERE skill_id='s-all'`);
    expect(row.rows[0].use_count_30d).toBe(1);
  });
});
