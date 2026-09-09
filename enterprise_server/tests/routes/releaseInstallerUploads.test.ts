import '../helpers/setupEnv';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENTERPRISE_STATE_DIR = join(tmpdir(), 'ent-upload-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { existsSync, readFileSync, rmSync } from 'node:fs';

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { releaseInstallerFile, releaseInstallerUploadDir } from '../../src/lib/stateDir';
import { authRoutes } from '../../src/routes/auth';
import { releaseInstallerUploadsRoutes } from '../../src/routes/releaseInstallerUploads';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  app.route('/', releaseInstallerUploadsRoutes);
  return app;
}

// signToken is async, so build the admin token in beforeEach (not at module scope).
let auth: { authorization: string } = { authorization: 'Bearer ' };

async function seedOrg(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
}

describe('routes/releaseInstallerUploads', () => {
  beforeEach(async () => {
    rmSync(process.env.ENTERPRISE_STATE_DIR!, { recursive: true, force: true });
    await resetSchema();
    await runMigrations();
    await seedOrg();
    const adminTok = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    auth = { authorization: `Bearer ${adminTok}` };
  });

  test('init validates extension matches platform', async () => {
    const a = buildApp();
    const r = await a.request('/admin/releases/installers/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ platform: 'windowsX64', fileName: 'genwork.dmg', fileSize: 100 }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()) as any).toMatchObject({ error: 'bad_extension' });
  });

  test('full upload: init -> chunks -> complete writes the file and returns meta', async () => {
    const payload = Buffer.from('A'.repeat(5)); // 5 bytes, single chunk
    const a = buildApp();
    const init = await a.request('/admin/releases/installers/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ platform: 'windowsX64', fileName: 'genwork.exe', fileSize: 5 }),
    });
    expect(init.status).toBe(200);
    const { uploadId, chunkSize } = (await init.json()) as any;
    expect(typeof uploadId).toBe('string');
    expect(chunkSize).toBeGreaterThan(5);

    const put = await a.request(`/admin/releases/installers/${uploadId}/chunks/0`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(payload),
    });
    expect(put.status).toBe(200);
    expect((await put.json()) as any).toMatchObject({ acceptedIndex: 0, totalAccepted: 1 });

    const done = await a.request(`/admin/releases/installers/${uploadId}/complete`, {
      method: 'POST',
      headers: { ...auth },
    });
    expect(done.status).toBe(200);
    const meta = (await done.json()) as any;
    expect(meta.id).toBe(uploadId);
    expect(meta.fileName).toBe('genwork.exe');
    expect(meta.fileSize).toBe(5);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);

    const diskPath = releaseInstallerFile(uploadId, '.exe');
    expect(existsSync(diskPath)).toBe(true);
    expect(readFileSync(diskPath).toString()).toBe('AAAAA');
    // staging cleaned up
    expect(existsSync(releaseInstallerUploadDir(uploadId))).toBe(false);
  });

  test('out-of-order chunk is rejected (Review Focus #5)', async () => {
    const a = buildApp();
    const init = await a.request('/admin/releases/installers/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ platform: 'windowsX64', fileName: 'genwork.exe', fileSize: 5 }),
    });
    const { uploadId } = (await init.json()) as any;
    // Send index 1 before index 0 -> gap.
    const bad = await a.request(`/admin/releases/installers/${uploadId}/chunks/1`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(Buffer.from('x')),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()) as any).toMatchObject({ error: 'bad_order' });
  });

  test('complete with under-delivery is size_mismatch (Review Focus #5)', async () => {
    const a = buildApp();
    const init = await a.request('/admin/releases/installers/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ platform: 'windowsX64', fileName: 'genwork.exe', fileSize: 100 }),
    });
    const { uploadId } = (await init.json()) as any;
    const put = await a.request(`/admin/releases/installers/${uploadId}/chunks/0`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(Buffer.from('A'.repeat(5))),
    });
    expect(put.status).toBe(200);
    const done = await a.request(`/admin/releases/installers/${uploadId}/complete`, {
      method: 'POST',
      headers: { ...auth },
    });
    expect(done.status).toBe(400);
    expect((await done.json()) as any).toMatchObject({ error: 'size_mismatch' });
  });

  test('init is org-scoped; another org cannot complete a different org upload', async () => {
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','T2')`);
    const tokOther = await signToken({ sub: 'u2', orgId: 'o2', roles: ['super_admin'] });
    const a = buildApp();
    const init = await a.request('/admin/releases/installers/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ platform: 'windowsX64', fileName: 'genwork.exe', fileSize: 5 }),
    });
    const { uploadId } = (await init.json()) as any;
    const done = await a.request(`/admin/releases/installers/${uploadId}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokOther}` },
    });
    expect(done.status).toBe(404);
  });
});
