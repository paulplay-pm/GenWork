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
const superAdmin = () => signToken({ sub: 'a', orgId: 'o1', roles: ['super_admin'] });
const member = () => signToken({ sub: 'u', orgId: 'o1', roles: ['member'] });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const json = { 'content-type': 'application/json' };

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','A')`);
});

describe('org settings (members_can_submit_skills)', () => {
  test('GET returns false by default', async () => {
    const res = await app.request('/api/admin/skill-marketplace/settings', {
      headers: auth(await superAdmin()),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ membersCanSubmit: false });
  });

  test('PATCH flips the value and writes an audit event', async () => {
    const tok = await superAdmin();
    const res = await app.request('/api/admin/skill-marketplace/settings', {
      method: 'PATCH', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ membersCanSubmit: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, membersCanSubmit: true });
    const audit = await testPool.query(
      `SELECT 1 FROM audit_events WHERE action='skill_update' AND org_id='o1'`);
    expect(audit.rowCount).toBe(1);
  });

  test('GET reflects a PATCH', async () => {
    const tok = await superAdmin();
    const patched = await app.request('/api/admin/skill-marketplace/settings', {
      method: 'PATCH', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ membersCanSubmit: true }),
    });
    expect(patched.status).toBe(200);
    const res = await app.request('/api/admin/skill-marketplace/settings', { headers: auth(tok) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ membersCanSubmit: true });
  });

  test('PATCH as member (no SkillEdit) -> 403', async () => {
    const res = await app.request('/api/admin/skill-marketplace/settings', {
      method: 'PATCH', headers: { ...auth(await member()), ...json },
      body: JSON.stringify({ membersCanSubmit: true }),
    });
    expect(res.status).toBe(403);
  });
});
