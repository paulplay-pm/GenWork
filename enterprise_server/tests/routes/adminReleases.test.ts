import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { authService } from '../../src/auth/authService';
import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { appRelease } from '../../src/models/appRelease';
import { adminReleaseRoutes } from '../../src/routes/admin/releases';
import { authRoutes } from '../../src/routes/auth';
import { AuditAction } from '../../src/shared/enterpriseServerConstants';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  app.route('/', adminReleaseRoutes);
  return app;
}

interface SeededTokens {
  tokAdmin: string;
  tokUser: string;
}

async function seed(): Promise<SeededTokens> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
  // Seed an existing release owned by o1 whose installer ids the happy-path
  // tests below re-use. Without this NL-4's ownership check would reject
  // every test that uses a placeholder id like 'file-1'.
  await appRelease.add('o1', {
    version: '0.0.1',
    change_log: {},
    installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
  });
  await authService.createUser({ orgId: 'o1', username: 'admin', password: 'pw12345678' });
  await authService.createUser({ orgId: 'o1', username: 'plain', password: 'pw12345678' });
  const a = buildApp();
  const adminLogin = await a.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgName: 'T', username: 'admin', password: 'pw12345678' }),
  });
  const _tokAdmin = ((await adminLogin.json()) as { token: string }).token;
  // Promote to super_admin (org_admin is also fine; super_admin short-circuits any capability)
  const adminTok = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
  const userLogin = await a.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgName: 'T', username: 'plain', password: 'pw12345678' }),
  });
  return { tokAdmin: adminTok, tokUser: ((await userLogin.json()) as { token: string }).token };
}

async function listAuditActions(orgId: string): Promise<string[]> {
  const r = await testPool.query<{ action: string }>(
    `SELECT action FROM audit_events WHERE org_id=$1 ORDER BY ts`,
    [orgId]
  );
  return r.rows.map((row) => row.action);
}

describe('routes/admin/releases', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('GET 403 for non org_admin / non super_admin', async () => {
    const { tokUser } = await seed();
    const a = buildApp();
    const r = await a.request('/admin/releases?orgId=o1', {
      headers: { authorization: `Bearer ${tokUser}` },
    });
    expect(r.status).toBe(403);
  });

  test('POST creates a release and writes audit row', async () => {
    const { tokAdmin } = await seed();
    const a = buildApp();
    const r = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({
        orgId: 'o1',
        version: '1.2.0',
        changeLog: { zh: { title: 't', content: ['a'] } },
        installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    const actions = await listAuditActions('o1');
    expect(actions).toContain(AuditAction.ReleaseCreate);
  });

  test('POST rejects malformed installer with 422', async () => {
    const { tokAdmin } = await seed();
    const a = buildApp();
    const r = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({
        orgId: 'o1',
        version: '1.0.0',
        changeLog: {},
        installers: { macArm: { id: '', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
      }),
    });
    expect(r.status).toBe(422);
  });

  test('POST rejects duplicate version with 409', async () => {
    const { tokAdmin } = await seed();
    const a = buildApp();
    const payload = {
      orgId: 'o1',
      version: '1.0.0',
      changeLog: {},
      installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
    };
    const r1 = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify(payload),
    });
    expect(r1.status).toBe(200);
    const r2 = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify(payload),
    });
    expect(r2.status).toBe(409);
  });

  test('POST set-latest toggles is_latest and audits', async () => {
    const { tokAdmin } = await seed();
    const a = buildApp();
    const created = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({
        orgId: 'o1',
        version: '1.0.0',
        changeLog: {},
        installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
      }),
    });
    const { id } = (await created.json()) as { id: string };
    const setLatest = await a.request(`/admin/releases/${id}/set-latest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokAdmin}` },
    });
    expect(setLatest.status).toBe(200);
    const list = await a.request('/admin/releases?orgId=o1', {
      headers: { authorization: `Bearer ${tokAdmin}` },
    });
    const rows = (await list.json()) as Array<{ id: string; is_latest: boolean }>;
    expect(rows.find((row) => row.id === id)?.is_latest).toBe(true);
    const actions = await listAuditActions('o1');
    expect(actions).toContain(AuditAction.ReleaseSetLatest);
  });

  test('set-latest on disabled release is 422', async () => {
    const { tokAdmin } = await seed();
    const a = buildApp();
    const created = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({
        orgId: 'o1',
        version: '1.0.0',
        changeLog: {},
        installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
      }),
    });
    const { id } = (await created.json()) as { id: string };
    await a.request(`/admin/releases/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({ enabled: false }),
    });
    const r = await a.request(`/admin/releases/${id}/set-latest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokAdmin}` },
    });
    expect(r.status).toBe(422);
  });

  test('POST rejects macArm with .exe fileName with 400 bad_extension (NL-4)', async () => {
    const { tokAdmin } = await seed();
    const a = buildApp();
    const r = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({
        orgId: 'o1',
        version: '1.0.0',
        changeLog: {},
        installers: { macArm: { id: 'file-1', fileName: 'foo.exe', fileSize: 10, sha256: 's' } },
      }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: string; issues: { platform: string } }).toEqual({ error: 'bad_extension', issues: { platform: 'macArm' } });
  });

  test('POST rejects windowsX64 with .dmg fileName with 400 bad_extension (NL-4)', async () => {
    const { tokAdmin } = await seed();
    const a = buildApp();
    const r = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({
        orgId: 'o1',
        version: '1.0.0',
        changeLog: {},
        installers: { windowsX64: { id: 'file-1', fileName: 'foo.dmg', fileSize: 10, sha256: 's' } },
      }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: string; issues: { platform: string } }).toEqual({ error: 'bad_extension', issues: { platform: 'windowsX64' } });
  });

  test('POST rejects unknown installer id with 400 installer_not_found (NL-4)', async () => {
    const { tokAdmin } = await seed();
    const a = buildApp();
    const r = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({
        orgId: 'o1',
        version: '1.0.0',
        changeLog: {},
        // fileName matches the platform extension so the extension check passes;
        // the id is what does not exist.
        installers: { macArm: { id: 'ffffffff-0000-0000-0000-000000000000', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
      }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: string; issues: { platform: string } }).toEqual({ error: 'installer_not_found', issues: { platform: 'macArm' } });
  });

  test('POST rejects cross-org installer id with 400 installer_not_found (NL-4, no leak)', async () => {
    // Seed two orgs: o1 (caller) and o2 (owner of the installer).
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','T2')`);
    const { id: otherReleaseId } = await appRelease.add('o2', {
      version: '0.0.1',
      change_log: {},
      // o2 owns this installer file id.
      installers: { macArm: { id: 'foreign-file', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
    });
    expect(otherReleaseId).toBeTruthy();

    const { tokAdmin } = await seed(); // o1 admin token
    const a = buildApp();
    const r = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({
        orgId: 'o1',
        version: '1.0.0',
        changeLog: {},
        // o1 admin tries to claim o2's installer.
        installers: { macArm: { id: 'foreign-file', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
      }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; issues?: { platform?: string } };
    expect(body.error).toBe('installer_not_found');
    // No leak: same envelope shape whether the id is unknown OR belongs to
    // someone else. The platform key is informational; the owner org is not.
    expect(body).not.toHaveProperty('orgId');
  });

  test('POST accepts an installer id owned by the same org (NL-4 happy path)', async () => {
    // Seed an existing release owned by o1 whose installer id the admin then
    // re-uses on a new release. Before NL-4 the id was never validated, so any
    // arbitrary UUID would have published — even ones the org never uploaded.
    const { tokAdmin } = await seed();
    const existing = await appRelease.add('o1', {
      version: '0.9.0',
      change_log: {},
      installers: { macArm: { id: 'owned-file', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
    });
    expect(existing.id).toBeTruthy();

    const a = buildApp();
    const r = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({
        orgId: 'o1',
        version: '1.0.0',
        changeLog: {},
        installers: { macArm: { id: 'owned-file', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
      }),
    });
    expect(r.status).toBe(200);
  });

  test('PATCH and DELETE work and audit', async () => {
    const { tokAdmin } = await seed();
    const a = buildApp();
    const created = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({
        orgId: 'o1',
        version: '1.0.0',
        changeLog: {},
        installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
      }),
    });
    const { id } = (await created.json()) as { id: string };
    const patch = await a.request(`/admin/releases/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    const del = await a.request(`/admin/releases/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokAdmin}` },
    });
    expect(del.status).toBe(200);
    const actions = await listAuditActions('o1');
    expect(actions).toContain(AuditAction.ReleaseUpdate);
    expect(actions).toContain(AuditAction.ReleaseDelete);
  });
});