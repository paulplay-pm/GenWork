import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let tmp: string;

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  tmp = mkdtempSync(join(tmpdir(), 'genwork-upgrade-'));
  process.env.COMPOSE_FILE = join(tmp, 'compose.yml');
  process.env.PREVIOUS_VERSION_FILE = join(tmp, 'previous-version');
  process.env.CURRENT_VERSION_FILE = join(tmp, 'current-version');
  // Shorten health-poll loops so tests don't wait 30s
  process.env.UPGRADE_HEALTH_TIMEOUT_MS = '50';
  process.env.UPGRADE_HEALTH_POLL_MS = '10';
  writeFileSync(
    process.env.COMPOSE_FILE,
    'services:\n  app:\n    image: enterprise-server:old\n',
  );
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  for (const k of [
    'COMPOSE_FILE',
    'PREVIOUS_VERSION_FILE',
    'CURRENT_VERSION_FILE',
    'UPGRADE_HEALTH_TIMEOUT_MS',
    'UPGRADE_HEALTH_POLL_MS',
  ]) {
    delete process.env[k];
  }
  vi.restoreAllMocks();
});

describe('upgrade subcommand', () => {
  // Helper: mock both execSync (curl) and spawnSync (docker arg-array).
  function mockChild(execBehavior: (cmd: string) => Buffer | never) {
    vi.doMock('node:child_process', () => ({
      execSync: (cmd: string) => {
        const r = execBehavior(cmd);
        if (r instanceof Buffer) return r;
        throw new Error('unreachable');
      },
      spawnSync: () => ({ status: 0 }),
    }));
  }

  test('happy path: swaps image, polls health, records version', async () => {
    mockChild((cmd) => (cmd.includes('curl') ? Buffer.from('{"ok":true}') : Buffer.from('')));
    const { run } = await import('../../src/cli/upgrade.js');
    await run(['--to', 'v2026.11.1']);
    const text = readFileSync(process.env.COMPOSE_FILE!, 'utf8');
    expect(text).toContain('image: enterprise-server:v2026.11.1');
    expect(text).not.toContain('image: enterprise-server:old');
  });

  test('rollback on healthcheck timeout', async () => {
    mockChild((cmd) => {
      if (cmd.includes('curl')) throw new Error('connection refused');
      return Buffer.from('');
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = await import('../../src/cli/upgrade.js');
    await run(['--to', 'v2026.11.1']);
    const text = readFileSync(process.env.COMPOSE_FILE!, 'utf8');
    expect(text).toContain('image: enterprise-server:old'); // rolled back
    expect(exit).toHaveBeenCalledWith(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('rolled back'));
  });

  test('rollback message includes the last healthcheck error', async () => {
    mockChild((cmd) => {
      if (cmd.includes('curl')) throw new Error('connect ECONNREFUSED 127.0.0.1:8787');
      return Buffer.from('');
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = await import('../../src/cli/upgrade.js');
    await run(['--to', 'v2026.11.1']);
    expect(exit).toHaveBeenCalledWith(1);
    // The captured curl error must surface so the operator can diagnose
    // the failure (was: silently swallowed; spec §5.5/§7 require it).
    expect(err).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  test('docker pull uses spawnSync arg-array, not a shell template', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    vi.doMock('node:child_process', () => ({
      execSync: (cmd: string) => {
        if (cmd.includes('curl')) return Buffer.from('{"ok":true}');
        return Buffer.from('');
      },
      spawnSync: (cmd: string, args: string[] = []) => {
        calls.push({ cmd, args });
        return { status: 0 };
      },
    }));
    const { run } = await import('../../src/cli/upgrade.js');
    await run(['--to', 'v2026.11.1']);
    // Find the docker pull call and assert it was an arg-array, not a
    // shell template. Was: `docker pull ${newImage}` interpolated into
    // a shell — a `;` in --to would have executed an arbitrary command.
    const pull = calls.find((c) => c.cmd === 'docker' && c.args[0] === 'pull');
    expect(pull).toBeDefined();
    expect(pull!.args).toContain('enterprise-server:v2026.11.1');
  });
});
