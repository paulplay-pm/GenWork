import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('start subcommand', () => {
  const prevDryRun = process.env.GENWORK_MIGRATE_DRY_RUN;
  const prevSuperuser = process.env.POSTGRES_SUPERUSER_URL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (prevDryRun === undefined) delete process.env.GENWORK_MIGRATE_DRY_RUN;
    else process.env.GENWORK_MIGRATE_DRY_RUN = prevDryRun;
    if (prevSuperuser === undefined) delete process.env.POSTGRES_SUPERUSER_URL;
    else process.env.POSTGRES_SUPERUSER_URL = prevSuperuser;
  });

  test('skips serve() in dry-run mode', async () => {
    process.env.GENWORK_MIGRATE_DRY_RUN = '1';

    // Stub the runMigrationsOnce + serve modules so we never touch Postgres
    // or bind a port. The dry-run branch must return before serve() is called.
    const runMigrations = vi.fn().mockResolvedValue(undefined);
    const serve = vi.fn();
    const endPool = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../src/cli/lib/runMigrations.js', () => ({ runMigrationsOnce: runMigrations }));
    vi.doMock('../../src/server.js', () => ({ serve }));
    vi.doMock('../../src/db/pool.js', () => ({ pool: { end: endPool, query: vi.fn() } }));

    const { run } = await import('../../src/cli/start.js');

    await expect(run()).resolves.toBeUndefined();

    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(serve).not.toHaveBeenCalled();
    expect(endPool).toHaveBeenCalledTimes(1);
  });
});
