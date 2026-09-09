import { execSync as realExecSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let tmp: string;

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.spyOn(realExecSync, 'call').mockImplementation(((..._args: unknown[]) => {
    return Buffer.from('/usr/bin/docker');
  }) as never);
  // Strong secrets
  process.env.JWT_SECRET = 'x'.repeat(40);
  process.env.GENWORK_VAULT_MASTER_KEY = 'y'.repeat(40);
  process.env.DATABASE_URL = 'postgres://app:secret@host:5432/appdb';
  process.env.POSTGRES_SUPERUSER_URL = 'postgres://postgres:pw@host:5432/postgres';
  // Per-test scratch: tmp root, redirected data dir, and fake install dir
  tmp = mkdtempSync(join(tmpdir(), 'genwork-init-'));
  process.env.INIT_DATA_DIR = join(tmp, 'data');
  mkdirSync(process.env.INIT_DATA_DIR, { recursive: true });
  process.env.INIT_SKIP_SYMLINK = '1';
  const fakeInstall = mkdtempSync(join(tmp, 'install-'));
  writeFileSync(join(fakeInstall, 'docker-compose.yml'), 'name: t\n');
  writeFileSync(join(fakeInstall, 'caddyfile.example'), ':80 {}\n');
  process.env.INSTALL_DIR = fakeInstall;
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  for (const k of ['INIT_DATA_DIR', 'INSTALL_DIR', 'INIT_SKIP_SYMLINK']) delete process.env[k];
  vi.restoreAllMocks();
});

describe('init subcommand', () => {
  test('refuses when role == superuser role', async () => {
    process.env.DATABASE_URL = 'postgres://postgres:pw@host:5432/appdb';
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = await import('../../src/cli/init.js');
    await run([]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('same role'));
  });

  test('refuses when data dir is already initialized', async () => {
    writeFileSync(join(tmp, 'data', 'compose.yml'), 'services:\n  app:\n    image: x\n', { recursive: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = await import('../../src/cli/init.js');
    await run([]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('already initialized'));
  });

  test('--force bypasses already-initialized check', async () => {
    writeFileSync(join(tmp, 'data', 'compose.yml'), 'services:\n  app:\n    image: x\n', { recursive: true });
    vi.doMock('pg', () => ({
      Client: vi.fn().mockImplementation(() => ({
        connect: () => Promise.resolve(),
        query: vi
          .fn()
          .mockRejectedValueOnce({ code: '42710' }) // role exists
          .mockRejectedValueOnce({ code: '42P04' }) // db exists
          .mockResolvedValue({ rows: [] }),
        end: () => Promise.resolve(),
      })),
    }));
    const { run } = await import('../../src/cli/init.js');
    await run(['--force']);
    expect(existsSync(join(tmp, 'data', 'current-version'))).toBe(true);
  });

  test('refuses weak JWT_SECRET', async () => {
    process.env.JWT_SECRET = 'short';
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = await import('../../src/cli/init.js');
    await run([]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('JWT_SECRET'));
  });

  test('symlink target points to a real file inside the install dir', async () => {
    // Build a realistic install dir: the symlink target must be a real file.
    delete process.env.INIT_SKIP_SYMLINK;
    const fakeInstall = mkdtempSync(join(tmp, 'real-install-'));
    const binDir = join(fakeInstall, 'cli', 'dist');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(fakeInstall, 'docker-compose.yml'), 'name: t\n');
    writeFileSync(join(fakeInstall, 'caddyfile.example'), ':80 {}\n');
    writeFileSync(join(binDir, 'index.js'), '#!/usr/bin/env node\n');
    process.env.INSTALL_DIR = fakeInstall;
    // init.ts hard-codes /usr/local/bin/genwork-server, which is not
    // writable in CI. The surface we can test is the path-resolution
    // function — the symlink target must be derived from the install
    // dir and the file at the resolved path must exist on disk.
    const { resolveInstallBin } = await import('../../src/cli/init.js');
    expect(resolveInstallBin(fakeInstall)).toBe(join(binDir, 'index.js'));
    expect(existsSync(join(binDir, 'index.js'))).toBe(true);
  });

  test('logs a warning when the symlink step fails', async () => {
    // Force the symlink to throw; the warning must surface.
    delete process.env.INIT_SKIP_SYMLINK;
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        symlinkSync: () => {
          throw new Error('read-only filesystem');
        },
      };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.doMock('pg', () => ({
      Client: vi.fn().mockImplementation(() => ({
        connect: () => Promise.resolve(),
        query: vi
          .fn()
          .mockRejectedValueOnce({ code: '42710' })
          .mockRejectedValueOnce({ code: '42P04' })
          .mockResolvedValue({ rows: [] }),
        end: () => Promise.resolve(),
      })),
    }));
    const { run } = await import('../../src/cli/init.js');
    await run([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not create'));
  });

  test('rejects --config (dead flag is gone)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = await import('../../src/cli/init.js');
    await run(['--config', '/tmp/x.env']);
    expect(exit).toHaveBeenCalledWith(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Unknown arg'));
  });
});
