import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { roleVocabularyRoutes } from '../../src/routes/roleVocabulary';

const app = new Hono();
app.route('/', roleVocabularyRoutes);
const tokenFor = (sub: string, orgId: string, roles: string[] = []) => signToken({ sub, orgId, roles });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function seedRoles(): Promise<void> {
  await testPool.query('INSERT INTO orgs(id, name) VALUES (\'o1\', \'T\') ON CONFLICT DO NOTHING');
  await testPool.query(`INSERT INTO roles(id, name, description, permissions)
    VALUES ('r1', 'engineer', NULL, '[]'::jsonb) ON CONFLICT DO NOTHING`);
  await testPool.query(`INSERT INTO roles(id, name, description, permissions)
    VALUES ('r2', 'qa', NULL, '[]'::jsonb) ON CONFLICT DO NOTHING`);
  await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles)
    VALUES ('u1', 'o1', 'u1', 'x', '["org_admin","engineer"]'::jsonb) ON CONFLICT DO NOTHING`);
  await testPool.query(`INSERT INTO users(id, org_id, username, password_hash, extra_roles)
    VALUES ('u2', 'o1', 'u2', 'x', '["support"]'::jsonb) ON CONFLICT DO NOTHING`);
}

describe('GET /api/roles/vocabulary', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); await seedRoles(); });

  test('returns the union of extra_roles + inherits_roles + core constants', async () => {
    const tok = await tokenFor('a', 'o1', ['org_admin']);
    const res = await app.request('/api/roles/vocabulary', { headers: auth(tok) });
    expect(res.status).toBe(200);
    const body = await res.json() as { roles: string[] };
    // org_admin, engineer, qa, support (from users) + engineer,qa (roles)
    // + core constants. Deduped + sorted.
    for (const r of ['org_admin', 'engineer', 'qa', 'support', 'super_admin', 'model_admin']) {
      expect(body.roles).toContain(r);
    }
    // sorted
    expect(body.roles).toEqual([...body.roles].sort());
    // no duplicates
    expect(new Set(body.roles).size).toBe(body.roles.length);
  });

  test('403 for a non org_admin token', async () => {
    const tok = await tokenFor('u', 'o1', ['user']);
    const res = await app.request('/api/roles/vocabulary', { headers: auth(tok) });
    expect(res.status).toBe(403);
  });

  test('401 without a token', async () => {
    const res = await app.request('/api/roles/vocabulary');
    expect(res.status).toBe(401);
  });
});
