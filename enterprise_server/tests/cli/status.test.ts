import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let tmp: string;

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  tmp = mkdtempSync(join(tmpdir(), 'genwork-status-'));
  process.env.COMPOSE_FILE = join(tmp, 'compose.yml');
  process.env.CURRENT_VERSION_FILE = join(tmp, 'current-version');
  writeFileSync(process.env.CURRENT_VERSION_FILE, 'v2026.11.1');
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  for (const k of ['COMPOSE_FILE', 'CURRENT_VERSION_FILE']) delete process.env[k];
  vi.restoreAllMocks();
});

describe('status subcommand', () => {
  test('exits 2 when compose ps shows nothing', async () => {
    vi.doMock('node:child_process', () => ({
      execSync: () => Buffer.from(''),
    }));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const { run } = await import('../../src/cli/status.js');
    await run();
    expect(exit).toHaveBeenCalledWith(2);
  });

  test('exits 0 when health endpoint returns ok', async () => {
    vi.doMock('node:child_process', () => ({
      execSync: (cmd: string) => {
        if (cmd.includes('compose')) return Buffer.from('"State":"running"');
        if (cmd.includes('curl')) return Buffer.from('{"ok":true}');
        return Buffer.from('');
      },
    }));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const { run } = await import('../../src/cli/status.js');
    await run();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
