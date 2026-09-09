import '../helpers/setupEnv';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENTERPRISE_STATE_DIR = join(tmpdir(), 'ent-dl-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { releaseInstallerFile } from '../../src/lib/stateDir';
import { appRelease } from '../../src/models/appRelease';
import { releaseDownloadsRoutes } from '../../src/routes/releaseDownloads';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', releaseDownloadsRoutes);
  return app;
}

const FILE_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';
const CONTENT = Buffer.from('0123456789AB'); // 12 bytes

async function seedInstaller(orgId: string): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('${orgId}','T')`);
  const { id } = await appRelease.add(orgId, {
    version: '9.9.9',
    change_log: {},
    installers: { windowsX64: { id: FILE_ID, fileName: 'genwork.exe', fileSize: CONTENT.length, sha256: 'x' } },
  });
  await appRelease.setLatest(id);
  // Write the on-disk file the download route will serve.
  const p = releaseInstallerFile(FILE_ID, '.exe');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, CONTENT);
}

const userTok = async (orgId: string): Promise<string> =>
  signToken({ sub: 'u1', orgId, roles: ['user'] });

describe('routes/releaseDownloads', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('200 serves full file with attachment headers', async () => {
    await seedInstaller('o1');
    const tok = await userTok('o1');
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/' + FILE_ID + '.exe', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('content-length')).toBe(String(CONTENT.length));
    expect(r.headers.get('content-disposition')).toContain('genwork.exe');
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe(CONTENT.toString());
  });

  test('206 serves a byte range with Content-Range', async () => {
    await seedInstaller('o1');
    const tok = await userTok('o1');
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/' + FILE_ID + '.exe', {
      headers: { authorization: `Bearer ${tok}`, range: 'bytes=4-7' },
    });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 4-7/12');
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('4567');
  });

  test('416 for an unsatisfiable range', async () => {
    await seedInstaller('o1');
    const tok = await userTok('o1');
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/' + FILE_ID + '.exe', {
      headers: { authorization: `Bearer ${tok}`, range: 'bytes=999-' },
    });
    expect(r.status).toBe(416);
  });

  test('401 without a token (Review Focus #3)', async () => {
    await seedInstaller('o1');
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/' + FILE_ID + '.exe');
    expect(r.status).toBe(401);
  });

  test('403 cross-org download (Review Focus #1)', async () => {
    await seedInstaller('o1');
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','T2')`);
    const tokOther = await signToken({ sub: 'u2', orgId: 'o2', roles: ['user'] });
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/' + FILE_ID + '.exe', {
      headers: { authorization: `Bearer ${tokOther}` },
    });
    expect(r.status).toBe(403);
  });

  test('404 for an unknown fileId', async () => {
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
    const tok = await userTok('o1');
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/ffffffff-0000-0000-0000-000000000000.exe', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(r.status).toBe(404);
  });
});
