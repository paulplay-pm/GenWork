import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let execSyncCalls: Array<[unknown, unknown]> = [];
let spawnSyncCalls: Array<[unknown, unknown]> = [];

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  process.env.DATABASE_URL = 'postgres://app:pw@h:5432/db';
  execSyncCalls = [];
  spawnSyncCalls = [];
  vi.doMock('node:child_process', () => ({
    execSync: (cmd: unknown) => {
      execSyncCalls.push([cmd, undefined]);
      return Buffer.from('');
    },
    spawnSync: (cmd: unknown, args: unknown) => {
      spawnSyncCalls.push([cmd, args]);
      return { status: 0 };
    },
  }));
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
  vi.doUnmock('node:child_process');
});

describe('backup subcommand', () => {
  test('invokes pg_dump with --no-owner and tar with arg array', async () => {
    const { run } = await import('../../src/cli/backup.js');
    await run([]);
    const dumpCall = spawnSyncCalls.find(([c]) => c === 'pg_dump');
    expect(dumpCall).toBeDefined();
    const args = dumpCall![1] as string[];
    expect(args).toEqual(expect.arrayContaining(['--no-owner', '--no-privileges', '--format=custom']));
    // tar must be invoked via spawnSync with an arg array, NOT execSync
    // with a shell-interpolated string (which would let an operator-
    // controlled --out escape the shell).
    const tarCall = spawnSyncCalls.find(([c]) => c === 'tar');
    expect(tarCall).toBeDefined();
    const execTar = execSyncCalls.find(([c]) => typeof c === 'string' && (c as string).startsWith('tar'));
    expect(execTar).toBeUndefined();
  });

  test('--out overrides default filename via arg array (no shell)', async () => {
    const { run } = await import('../../src/cli/backup.js');
    await run(['--out', '/tmp/backup-custom.tar.gz']);
    const tarCall = spawnSyncCalls.find(([c]) => c === 'tar');
    expect(tarCall).toBeDefined();
    const args = tarCall![1] as string[];
    expect(args[0]).toBe('czf');
    expect(args).toContain('/tmp/backup-custom.tar.gz');
  });

  test('--out with shell metacharacters is passed literally, not interpreted', async () => {
    // If the source used execSync(`tar czf ${out} ...`), the `;` in `out`
    // would terminate the command and run the trailing `id` in a shell.
    // With spawnSync arg-array form, the metacharacter is part of the
    // path argument and is not interpreted.
    const { run } = await import('../../src/cli/backup.js');
    await run(['--out', '/tmp/$(id).tar.gz']);
    const tarCall = spawnSyncCalls.find(([c]) => c === 'tar');
    expect(tarCall).toBeDefined();
    const args = tarCall![1] as string[];
    expect(args).toContain('/tmp/$(id).tar.gz');
  });
});
