import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Per-test service-up state, controlled via a mutable flag the mock reads.
let serviceUp = false;

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  process.env.DATABASE_URL = 'postgres://app:pw@h:5432/db';
  serviceUp = false;
  vi.doMock('node:child_process', () => ({
    execSync: (cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('curl')) {
        if (serviceUp) return Buffer.from('{"ok":true}');
        throw new Error('connection refused');
      }
      return Buffer.from('');
    },
    spawnSync: () => ({ status: 0 }),
  }));
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
  for (const k of ['GENWORK_ETC_DIR']) delete process.env[k];
});

describe('restore subcommand', () => {
  test('refuses when service is up and no --force', async () => {
    serviceUp = true;
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
    const { run } = await import('../../src/cli/restore.js');
    let caught = '';
    try {
      await run(['--from', 'fake.tar.gz']);
    } catch (e) {
      caught = (e as Error).message;
    }
    expect(caught).toBe('__exit_1__');
  });

  test('--force bypasses up-service refusal', async () => {
    serviceUp = true;
    // Pre-create a staged data dir so the swap step finds the file the
    // mocked tar would have produced.
    const stage = mkdtempSync(join(tmpdir(), 'genwork-restore-stage-'));
    mkdirSync(join(stage, 'data'), { recursive: true });
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        mkdtempSync: () => stage,
      };
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const { run } = await import('../../src/cli/restore.js');
    await run(['--from', 'fake.tar.gz', '--force']);
    // The test must reach pg_restore (mocked to status 0) and NOT exit(1).
    // The plan's contract is "no exit(1) when --force is used and restore succeeds."
    expect(exit).not.toHaveBeenCalledWith(1);
  });

  test('does not delete live data before tar extraction succeeds', async () => {
    // Set up a real on-disk ETC dir with a sentinel file in `data`.
    const etc = mkdtempSync(join(tmpdir(), 'genwork-restore-etc-'));
    process.env.GENWORK_ETC_DIR = etc;
    const liveData = join(etc, 'data');
    mkdirSync(liveData, { recursive: true });
    writeFileSync(join(liveData, 'sentinel.txt'), 'do-not-delete-me');
    // Pre-create a staged data dir so the swap step finds the file the
    // mocked tar would have produced.
    const stage = mkdtempSync(join(tmpdir(), 'genwork-restore-stage-'));
    mkdirSync(join(stage, 'data'), { recursive: true });
    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        mkdtempSync: () => stage,
      };
    });
    // Track every execSync invocation; if `rm -rf ${ETC}/data` runs before
    // the tar extract completes, the bug from the review is back.
    const calls: string[] = [];
    vi.doMock('node:child_process', () => ({
      execSync: (cmd: unknown) => {
        if (typeof cmd === 'string') calls.push(cmd);
        return Buffer.from('');
      },
      spawnSync: () => ({ status: 0 }),
    }));
    const { run } = await import('../../src/cli/restore.js');
    await run(['--from', 'fake.tar.gz', '--force']);
    // No call may be `rm -rf <etc>/data`. The current code did exactly
    // this on line 80 of restore.ts: it removed the live data dir BEFORE
    // the tar extract landed, so a tar failure left the operator with
    // nothing. The fix is to extract to a staging dir and atomically swap.
    const rmCall = calls.find((c) => new RegExp(`rm -rf\\s+${etc}/data`).test(c));
    expect(rmCall).toBeUndefined();
  });
});
