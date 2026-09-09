import '../helpers/setupEnv';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set ENTERPRISE_STATE_DIR BEFORE the IIFE in src/lib/stateDir.ts captures it.
// NOTE: in ESM, imports are hoisted above this statement; vi.mock() is also
// hoisted (above all imports). The existing upload test relies on the same
// pattern: `releaseInstallerUploadsRoutes` and the test code both resolve
// paths through the captured `_stateDir`, so they stay internally consistent
// regardless of what that captured value actually is.
//
// The test then operates entirely through `releaseInstallerUploadDir(...)`,
// `releaseInstallerUploadDirs()`, and `sweepStaleReleaseUploads()` from
// `src/lib/stateDir.ts` so it sees the same tree the production code does.
process.env.ENTERPRISE_STATE_DIR = join(
  tmpdir(),
  'ent-staging-gc-' + Date.now() + '-' + Math.random().toString(36).slice(2),
);

import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import {
  releaseInstallerUploadDir,
  releaseInstallerUploadDirs,
  sweepStaleReleaseUploads,
} from '../../src/lib/stateDir';

const STALE_ID = 'stale-uuid-0000-0000-0000-000000000001';
const FRESH_ID = 'fresh-uuid-0000-0000-0000-000000000002';

// Resolve the actual on-disk staging root the captured `_stateDir` points at,
// so we can wipe leaked prior-run dirs (NL-3 spec §6 — staging dirs may
// accumulate across runs and the sweep is the only thing that clears them).
const stagingRoot = join(releaseInstallerUploadDir('sentinel'), '..');

beforeAll(() => {
  rmSync(stagingRoot, { recursive: true, force: true });
});

afterEach(() => {
  // Each test starts from a known-empty staging root so the second test's
  // "no staging dirs" assertion is unaffected by leftover state from the
  // first test.
  rmSync(stagingRoot, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(stagingRoot, { recursive: true, force: true });
});

describe('sweepStaleReleaseUploads (NL-3, spec §6)', () => {
  test('removes staging dirs older than 24h, keeps fresh ones, returns the count removed', async () => {
    // Seed two staging dirs: one 48h old, one brand-new.
    const staleDir = releaseInstallerUploadDir(STALE_ID);
    const freshDir = releaseInstallerUploadDir(FRESH_ID);
    mkdirSync(staleDir, { recursive: true });
    mkdirSync(freshDir, { recursive: true });

    const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
    const staleMtime = new Date(Date.now() - FORTY_EIGHT_HOURS_MS);
    utimesSync(staleDir, staleMtime, staleMtime);

    expect(existsSync(staleDir)).toBe(true);
    expect(existsSync(freshDir)).toBe(true);
    expect(releaseInstallerUploadDirs().sort()).toEqual([staleDir, freshDir].sort());

    const removed = await sweepStaleReleaseUploads(24 * 60 * 60 * 1000);

    expect(removed).toBe(1);
    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
  });

  test('returns 0 when there are no staging dirs', async () => {
    expect(releaseInstallerUploadDirs()).toEqual([]);
    const removed = await sweepStaleReleaseUploads();
    expect(removed).toBe(0);
  });
});