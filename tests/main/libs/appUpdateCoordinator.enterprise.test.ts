import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SqliteStore } from '../../../src/main/sqliteStore';
import { AppUpdateSource, AppUpdateStatus } from '../../../src/shared/appUpdate/constants';

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  getVersion: vi.fn(),
  fetch: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  cancelActiveDownload: vi.fn(),
  sessionLoad: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mocks.getPath,
    getVersion: mocks.getVersion,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  session: {
    defaultSession: {
      fetch: mocks.fetch,
    },
  },
}));

vi.mock('../../../src/main/libs/appUpdateInstaller', () => ({
  cancelActiveDownload: mocks.cancelActiveDownload,
  downloadUpdate: mocks.downloadUpdate,
  installUpdate: mocks.installUpdate,
}));

vi.mock('../../../src/main/libs/endpoints', () => ({
  getUpdateCheckUrl: () => 'http://enterprise.test/updates/latest',
  getManualUpdateCheckUrl: () => 'http://enterprise.test/updates/latest',
  getFallbackDownloadUrl: () => '',
  isEnterpriseUpdateMode: () => true,
}));

vi.mock('../../../src/main/libs/keyfromAttribution', () => ({
  getKeyfromAttribution: () => ({ firstKeyfrom: 'none', latestKeyfrom: 'none' }),
}));

vi.mock('../../../src/main/auth/sessionStorage', () => ({
  sessionStorage: {
    configure: vi.fn(),
    save: vi.fn(),
    load: mocks.sessionLoad,
    clear: vi.fn(),
  },
}));

import { AppUpdateCoordinator } from '../../../src/main/libs/appUpdateCoordinator';

function createStoreStub(): SqliteStore {
  const map = new Map<string, unknown>();
  return {
    get: (key: string) => map.get(key),
    set: (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: (key: string) => {
      map.delete(key);
    },
  } as unknown as SqliteStore;
}

describe('AppUpdateCoordinator (enterprise mode)', () => {
  const originalPlatform = process.platform;
  let tmpDir: string;

  beforeEach(() => {
    mocks.getPath.mockReset();
    mocks.getVersion.mockReset();
    mocks.fetch.mockReset();
    mocks.downloadUpdate.mockReset();
    mocks.installUpdate.mockReset();
    mocks.cancelActiveDownload.mockReset();
    mocks.sessionLoad.mockReset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genwork-enterprise-update-test-'));
    mocks.getPath.mockReturnValue(tmpDir);
    mocks.getVersion.mockReturnValue('1.0.0');
    mocks.cancelActiveDownload.mockReturnValue(false);
    mocks.sessionLoad.mockReturnValue(null);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('enterprise endpoint is hit and parses the clean shape', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        latest: true,
        version: '2.0.0',
        date: '2026-08-27T00:00:00Z',
        changeLog: { zh: { title: '中', content: ['a'] }, en: { title: 'en', content: ['x'] } },
        macArm: { url: 'https://cdn.example.com/a.dmg' },
      }),
    });
    const coordinator = new AppUpdateCoordinator(createStoreStub());

    const result = await coordinator.checkNow({ manual: true });

    expect(result.success).toBe(true);
    expect(result.state.info?.latestVersion).toBe('2.0.0');
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith('http://enterprise.test/updates/latest')).toBe(true);
    // No query string in enterprise mode.
    expect(url.includes('?')).toBe(false);
    // Authorization header should not be present without a session.
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  test('sends Bearer token from sessionStorage when available', async () => {
    mocks.sessionLoad.mockReturnValue({
      userId: 'u',
      orgId: 'o',
      username: 'u',
      displayName: 'u',
      roles: [],
      jwt: 'enterprise-jwt',
      expiresAt: Date.now() + 60_000,
    });
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        latest: true,
        version: '2.0.0',
        date: '2026-08-27T00:00:00Z',
        changeLog: { zh: { title: '', content: [] }, en: { title: '', content: [] } },
        macArm: { url: 'https://cdn.example.com/a.dmg' },
      }),
    });
    const coordinator = new AppUpdateCoordinator(createStoreStub());

    await coordinator.checkNow({ manual: true });

    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer enterprise-jwt');
  });

  test('enterprise 401 returns no update without crashing or locking the login gate', async () => {
    // Force-import a fresh loginGate that is not shared with other test files
    // (loginGate is a module-level singleton in src/main/auth/loginGate.ts).
    const { loginGate } = await import('../../../src/main/auth/loginGate');
    loginGate.unlock({
      userId: 'u',
      orgId: 'o',
      username: 'u',
      displayName: 'u',
      roles: [],
      jwt: 'tok',
      expiresAt: Date.now() + 60_000,
    });
    mocks.fetch.mockResolvedValue({ ok: false, status: 401 });
    const coordinator = new AppUpdateCoordinator(createStoreStub());

    const result = await coordinator.checkNow({ manual: true });

    expect(result.success).toBe(true);
    expect(result.updateFound).toBe(false);
    expect(result.state.status).toBe(AppUpdateStatus.Idle);
    expect(result.state.source).toBe(AppUpdateSource.Manual);
    // The session must still be unlocked; the check failed gracefully.
    expect(loginGate.current()).not.toBeNull();
    expect(loginGate.current()?.jwt).toBe('tok');
  });

  test('enterprise mode does not append a query string to the check URL', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ latest: false }),
    });
    const coordinator = new AppUpdateCoordinator(createStoreStub());

    await coordinator.checkNow({ manual: true });

    const [url] = mocks.fetch.mock.calls[0] as [string];
    expect(url).toBe('http://enterprise.test/updates/latest');
  });

  test('enterprise Windows installer on a private LAN host is accepted via ENTERPRISE_SERVER_URL', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const previousEnterpriseUrl = process.env.ENTERPRISE_SERVER_URL;
    process.env.ENTERPRISE_SERVER_URL = 'http://192.168.10.5:8787';
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        latest: true,
        version: '2.0.0',
        date: '2026-08-27T00:00:00Z',
        changeLog: { zh: { title: '', content: [] }, en: { title: '', content: [] } },
        windowsX64: { url: 'http://192.168.10.5/installer.exe' },
      }),
    });
    try {
      const coordinator = new AppUpdateCoordinator(createStoreStub());

      const result = await coordinator.checkNow({ manual: true });

      expect(result.success).toBe(true);
      expect(result.state.info?.url).toBe('http://192.168.10.5/installer.exe');
      // No download attempted: the coordinator treats non-HTTPS URLs as
      // non-predownloadable; it should surface the Available state, not crash.
      expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    } finally {
      if (previousEnterpriseUrl === undefined) {
        delete process.env.ENTERPRISE_SERVER_URL;
      } else {
        process.env.ENTERPRISE_SERVER_URL = previousEnterpriseUrl;
      }
    }
  });
});