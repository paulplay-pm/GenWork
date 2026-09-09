import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { appRelease, type ReleaseInstallers } from '../../src/models/appRelease';

async function seedOrg(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
}

const installers: ReleaseInstallers = {
  macArm: { id: 'file-mac', fileName: 'GenWork.dmg', fileSize: 10, sha256: 'mac-sha' },
  windowsX64: { id: 'file-win', fileName: 'GenWork.exe', fileSize: 20, sha256: 'win-sha' },
};

async function makeRelease(
  version: string,
  opts: { isLatest?: boolean; enabled?: boolean; installers?: ReleaseInstallers } = {},
): Promise<string> {
  const { id } = await appRelease.add('o1', {
    version,
    change_log: { zh: { title: `t-zh ${version}`, content: ['c-zh'] }, en: { title: `t-en ${version}`, content: ['c-en'] } },
    installers: opts.installers ?? installers,
  });
  if (opts.enabled === false) await appRelease.update(id, { enabled: false });
  if (opts.isLatest === true) await appRelease.setLatest(id);
  return id;
}

describe('models/appRelease (installers)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seedOrg();
  });

  test('add stores installers and listForAdmin returns them', async () => {
    await makeRelease('1.0.0');
    const list = await appRelease.listForAdmin('o1');
    expect(list[0].installers).toEqual(installers);
    expect(list[0]).not.toHaveProperty('downloads');
  });

  test('add rejects duplicate (orgId, version)', async () => {
    await makeRelease('1.0.0');
    await expect(makeRelease('1.0.0')).rejects.toThrow(/duplicate|unique|conflict/i);
  });

  test('update replaces installers', async () => {
    const id = await makeRelease('1.0.0');
    await appRelease.update(id, { installers: { windowsX64: { id: 'w', fileName: 'a.exe', fileSize: 5, sha256: 's' } } });
    const list = await appRelease.listForAdmin('o1');
    expect(list[0].installers).toEqual({ windowsX64: { id: 'w', fileName: 'a.exe', fileSize: 5, sha256: 's' } });
  });

  test('getLatestEnabled is org-scoped', async () => {
    await makeRelease('1.0.0', { isLatest: true });
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','O2')`);
    expect(await appRelease.getLatestEnabled('o2')).toBeNull();
  });

  test('setLatest rejects a release with no installer (no_installer)', async () => {
    const { id } = await appRelease.add('o1', { version: '1.0.0', change_log: {}, installers: {} });
    await expect(appRelease.setLatest(id)).rejects.toThrow('no_installer');
  });

  test('getInstallerMeta resolves a fileId to owner + metadata', async () => {
    await makeRelease('1.0.0');
    const meta = await appRelease.getInstallerMeta('file-win');
    expect(meta).toEqual({ orgId: 'o1', fileName: 'GenWork.exe', fileSize: 20, sha256: 'win-sha' });
    expect(await appRelease.getInstallerMeta('missing')).toBeNull();
  });
});
