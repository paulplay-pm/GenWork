import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('assertDockerOnPath', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let execSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    execSyncMock = vi.fn();
    vi.doMock('node:child_process', () => ({ execSync: execSyncMock }));
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.doUnmock('node:child_process');
  });

  test('returns silently when docker is present', async () => {
    execSyncMock.mockReturnValue(Buffer.from('/usr/bin/docker'));
    const { assertDockerOnPath } = await import('../../src/cli/lib/preflight');
    expect(() => assertDockerOnPath()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('exits 1 when docker is missing', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    const { assertDockerOnPath } = await import('../../src/cli/lib/preflight');
    assertDockerOnPath();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
