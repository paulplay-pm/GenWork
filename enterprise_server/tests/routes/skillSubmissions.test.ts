// Route tests for the member-skill submission review queue (Task 8).
// Pins: the org `members_can_submit_skills` toggle gate on submit, the base64
// zip payload parsing (staged under `__sub_<id>`), approve in a transaction
// (colliding skill_id → `-2` suffix; submitted scope sanitized and brought
// over; the staged zip moved into the skill's store dir), reject (forced
// reason), withdraw (author-only), and cross-org isolation (foreign id 404s
// without leaking existence).
import '../helpers/setupEnv';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import AdmZip from 'adm-zip';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { skillStoreDir } from '../../src/lib/stateDir';
import { skillSubmissionsRoutes } from '../../src/routes/skillSubmissions';

// A valid one-entry skill zip: top-level dir `snew/` holding SKILL.md.
const zip = new AdmZip();
zip.addFile('snew/SKILL.md', Buffer.from('# x'));
const zipB64 = zip.toBuffer().toString('base64');

const app = new Hono();
app.route('/', skillSubmissionsRoutes);

const SUBMISSIONS_PATH = '/api/admin/skill-marketplace/submissions';

async function seed(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1'), ('o2', 'T2')`);
  // Dept d1 exists so the submitted scope's deptIds survive sanitization.
  await testPool.query(
    `INSERT INTO departments(id, org_id, name, parent_id, path)
     VALUES ('d1', 'o1', 'Root', NULL, '/Root')`,
  );
  // Real users so the author check and scope sanitization are realistic.
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash)
     VALUES ('u1', 'o1', 'u1', 'x'), ('u2', 'o1', 'u2', 'x')`,
  );
}

async function submitAs(
  sub: string,
  orgId: string,
  roles: string[] = ['member'],
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const tok = await signToken({ sub, orgId, roles });
  return app.request(SUBMISSIONS_PATH, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      desc: 'd',
      scope: { allCompany: false, deptIds: ['d1'], userIds: [] },
      zip: zipB64,
      ...overrides,
    }),
  });
}

async function post(tok: string, path: string, body?: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body } : {}),
  });
}

async function superAdminTok(orgId: string, sub = 'a'): Promise<string> {
  return signToken({ sub, orgId, roles: ['super_admin'] });
}

describe('skill submissions (member review queue)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seed();
  });

  test('submit: toggle on -> 201 {id}; staged zip written; submit audit row', async () => {
    await testPool.query('UPDATE orgs SET members_can_submit_skills = TRUE WHERE id = $1', ['o1']);
    const res = await submitAs('u1', 'o1');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
    expect(body).toEqual({ id: body.id });

    const audit = await testPool.query(
      `SELECT 1 FROM audit_events WHERE action = 'skill_submission_submit'`,
    );
    expect(audit.rowCount).toBe(1);

    expect(existsSync(join(skillStoreDir(`__sub_${body.id}`), 'skill.zip'))).toBe(true);
  });

  test('submit: org toggle off (default) -> 403 submission_disabled; nothing written', async () => {
    const res = await submitAs('u1', 'o1');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'submission_disabled' });
    const r = await testPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM skill_submissions',
    );
    expect(r.rows[0].n).toBe(0);
  });

  test('approve: collision -> -2 suffix; scope brought over (sanitized); skill enabled in uncategorized; submission linked; approve audit', async () => {
    await testPool.query('UPDATE orgs SET members_can_submit_skills = TRUE WHERE id = $1', ['o1']);
    // Pre-occupy the zip's name so approve must suffix -2.
    await testPool.query(
      `INSERT INTO skill_marketplace_skills
         (skill_id, name_en, description_en, category_id, source_json, org_id, scope,
          enabled, created_by)
       VALUES ('snew', 'snew', 'snew', 'uncategorized', '{}'::jsonb, 'o1',
               '{"allCompany":false,"deptIds":[],"userIds":[]}'::jsonb, TRUE, 'seed')`,
    );

    const subRes = await submitAs('u1', 'o1');
    expect(subRes.status).toBe(201);
    const { id } = (await subRes.json()) as { id: string };

    const admin = await superAdminTok('o1');
    const approve = await post(admin, `${SUBMISSIONS_PATH}/${id}/approve`);
    expect(approve.status).toBe(200);
    expect(await approve.json()).toEqual({ ok: true, id: 'snew-2' });

    const s = await testPool.query<{
      category_id: string; enabled: boolean; scope: { deptIds: string[] };
    }>(
      `SELECT category_id, enabled, scope FROM skill_marketplace_skills
       WHERE skill_id = $1 AND org_id = $2`,
      ['snew-2', 'o1'],
    );
    expect(s.rowCount).toBe(1);
    expect(s.rows[0].category_id).toBe('uncategorized');
    expect(s.rows[0].enabled).toBe(true);
    // The submitted scope's dept d1 survived sanitization (d1 exists in o1).
    expect(s.rows[0].scope.deptIds).toEqual(['d1']);

    const row = await testPool.query<{ status: string; approved_skill_id: string | null }>(
      `SELECT status, approved_skill_id FROM skill_submissions WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe('approved');
    expect(row.rows[0].approved_skill_id).toBe('snew-2');

    const audit = await testPool.query(
      `SELECT 1 FROM audit_events WHERE action = 'skill_submission_approve'`,
    );
    expect(audit.rowCount).toBe(1);

    // The zip moved out of the staged dir into the skill's store dir.
    expect(existsSync(join(skillStoreDir('snew-2'), 'skill.zip'))).toBe(true);
    expect(existsSync(skillStoreDir(`__sub_${id}`))).toBe(false);
  });

  test('reject: empty reason -> 400 reason_required; with reason -> rejected + reason stored', async () => {
    await testPool.query('UPDATE orgs SET members_can_submit_skills = TRUE WHERE id = $1', ['o1']);
    const subRes = await submitAs('u1', 'o1');
    const { id } = (await subRes.json()) as { id: string };
    const admin = await superAdminTok('o1');

    const noReason = await post(admin, `${SUBMISSIONS_PATH}/${id}/reject`, JSON.stringify({}));
    expect(noReason.status).toBe(400);
    expect(await noReason.json()).toEqual({ error: 'reason_required' });

    const ok = await post(admin, `${SUBMISSIONS_PATH}/${id}/reject`, JSON.stringify({ reason: 'nope' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });

    const row = await testPool.query<{ status: string; reject_reason: string | null }>(
      `SELECT status, reject_reason FROM skill_submissions WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe('rejected');
    expect(row.rows[0].reject_reason).toBe('nope');

    // A decided submission no longer leaks its staged zip.
    expect(existsSync(skillStoreDir(`__sub_${id}`))).toBe(false);
  });

  test('withdraw: non-author -> 403 forbidden; author -> 200 + withdrawn', async () => {
    await testPool.query('UPDATE orgs SET members_can_submit_skills = TRUE WHERE id = $1', ['o1']);
    const subRes = await submitAs('u1', 'o1');
    const { id } = (await subRes.json()) as { id: string };

    const u2 = await signToken({ sub: 'u2', orgId: 'o1', roles: ['member'] });
    const byOther = await post(u2, `${SUBMISSIONS_PATH}/${id}/withdraw`);
    expect(byOther.status).toBe(403);
    expect(await byOther.json()).toEqual({ error: 'forbidden' });

    const u1 = await signToken({ sub: 'u1', orgId: 'o1', roles: ['member'] });
    const byAuthor = await post(u1, `${SUBMISSIONS_PATH}/${id}/withdraw`);
    expect(byAuthor.status).toBe(200);
    expect(await byAuthor.json()).toEqual({ ok: true });

    const row = await testPool.query<{ status: string }>(
      `SELECT status FROM skill_submissions WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe('withdrawn');

    // A decided submission no longer leaks its staged zip.
    expect(existsSync(skillStoreDir(`__sub_${id}`))).toBe(false);
  });

  test('cross-org: o2 admin approve on an o1 submission -> 404 not_found; still pending', async () => {
    await testPool.query('UPDATE orgs SET members_can_submit_skills = TRUE WHERE id = $1', ['o1']);
    const subRes = await submitAs('u1', 'o1');
    expect(subRes.status).toBe(201);
    const { id } = (await subRes.json()) as { id: string };

    const o2Admin = await superAdminTok('o2', 'a2');
    const approve = await post(o2Admin, `${SUBMISSIONS_PATH}/${id}/approve`);
    expect(approve.status).toBe(404);
    expect(await approve.json()).toEqual({ error: 'not_found' });

    const row = await testPool.query<{ status: string }>(
      `SELECT status FROM skill_submissions WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe('pending');
  });
});
