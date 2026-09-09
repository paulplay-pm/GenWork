import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('genwork-server version', () => {
  let prevVersion: string | undefined;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    prevVersion = process.env.VERSION;
    process.env.VERSION = 'v2026.10.15-test';
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    if (prevVersion === undefined) delete process.env.VERSION;
    else process.env.VERSION = prevVersion;
  });

  test('prints VERSION env when set', async () => {
    const { run } = await import('../../src/cli/version');
    run();
    expect(log).toHaveBeenCalledWith('genwork-server v2026.10.15-test');
  });
});
