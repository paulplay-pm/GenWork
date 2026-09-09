import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { authService } from '../../src/auth/authService';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { appRelease } from '../../src/models/appRelease';
import { authRoutes } from '../../src/routes/auth';
import { updatesRoutes } from '../../src/routes/updates';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  app.route('/', updatesRoutes);
  return app;
}

async function login(): Promise<string> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
  await authService.createUser({ orgId: 'o1', username: 'alice', password: 'pw12345678' });
  const a = buildApp();
  const r = await a.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgName: 'T', username: 'alice', password: 'pw12345678' }),
  });
  return ((await r.json()) as { token: string }).token;
}

describe('routes/updates (installers)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('401 without bearer token', async () => {
    const a = buildApp();
    const r = await a.request('/updates/latest');
    expect(r.status).toBe(401);
  });

  test('{ latest: false } when org has no release', async () => {
    const tok = await login();
    const a = buildApp();
    const r = await a.request('/updates/latest', { headers: { authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ latest: false });
  });

  test('emits a server-relative installer URL per platform that exists', async () => {
    const tok = await login();
    const { id } = await appRelease.add('o1', {
      version: '1.2.3',
      published_at: '2026-08-27T00:00:00Z',
      change_log: { zh: { title: 'zh', content: ['a'] }, en: { title: 'en', content: ['b'] } },
      installers: {
        macArm: { id: 'mac-file', fileName: 'GenWork.dmg', fileSize: 100, sha256: 'x' },
        windowsX64: { id: 'win-file', fileName: 'GenWork.exe', fileSize: 200, sha256: 'y' },
      },
    });
    await appRelease.setLatest(id);
    const a = buildApp();
    const r = await a.request('/updates/latest', { headers: { authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, any>;
    expect(body.latest).toBe(true);
    expect(body.version).toBe('1.2.3');
    expect(body.date).toBe('2026-08-27T00:00:00.000Z');
    expect(body.changeLog).toEqual({ zh: { title: 'zh', content: ['a'] }, en: { title: 'en', content: ['b'] } });
    // The route derives its origin from c.req.url; for a relative test request
    // Hono normalizes that to http://localhost (Response.url itself is unset by
    // c.json). Same base host sso.desktop.test.ts relies on.
    const origin = 'http://localhost';
    expect(body.macArm).toEqual({ url: `${origin}/downloads/app-releases/mac-file.dmg` });
    expect(body.windowsX64).toEqual({ url: `${origin}/downloads/app-releases/win-file.exe` });
    expect(body).not.toHaveProperty('macIntel');
  });

  test('omits a platform URL when that platform has no installer (Review Focus #4)', async () => {
    const tok = await login();
    const { id } = await appRelease.add('o1', {
      version: '1.2.3',
      change_log: {},
      installers: { windowsX64: { id: 'win-file', fileName: 'GenWork.exe', fileSize: 200, sha256: 'y' } },
    });
    await appRelease.setLatest(id);
    const a = buildApp();
    const r = await a.request('/updates/latest', { headers: { authorization: `Bearer ${tok}` } });
    const body = (await r.json()) as Record<string, any>;
    expect(body).toHaveProperty('windowsX64');
    expect(body).not.toHaveProperty('macArm');
  });

  test('disabled latest is not exposed', async () => {
    const tok = await login();
    const { id } = await appRelease.add('o1', {
      version: '1.2.4',
      change_log: {},
      installers: { macArm: { id: 'm', fileName: 'a.dmg', fileSize: 1, sha256: 's' } },
    });
    await appRelease.setLatest(id);
    await appRelease.update(id, { enabled: false });
    const a = buildApp();
    const r = await a.request('/updates/latest', { headers: { authorization: `Bearer ${tok}` } });
    expect(await r.json()).toEqual({ latest: false });
  });

  test('cross-org isolation', async () => {
    await login();
    const { id } = await appRelease.add('o1', {
      version: '1.0.0',
      change_log: {},
      installers: { macArm: { id: 'm', fileName: 'a.dmg', fileSize: 1, sha256: 's' } },
    });
    await appRelease.setLatest(id);
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','T2')`);
    await authService.createUser({ orgId: 'o2', username: 'bob', password: 'pw12345678' });
    const a = buildApp();
    const loginB = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'T2', username: 'bob', password: 'pw12345678' }),
    });
    const tokB = ((await loginB.json()) as { token: string }).token;
    const rB = await a.request('/updates/latest', { headers: { authorization: `Bearer ${tokB}` } });
    expect(await rB.json()).toEqual({ latest: false });
  });
});
