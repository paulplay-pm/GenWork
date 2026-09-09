import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertDockerOnPath, assertRoot, requireEnv } from './lib/preflight.js';

const ETC_GENWORK = process.env.GENWORK_ETC_DIR ?? '/etc/genwork';

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  let out = `./genwork-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else {
      console.error(`Unknown arg: ${argv[i]}`);
      process.exit(2);
    }
  }
  assertRoot();
  assertDockerOnPath();
  const dbUrl = requireEnv('DATABASE_URL');
  const work = mkdtempSync(join(tmpdir(), 'genwork-backup-'));
  const dump = join(work, 'dump.sql.gz');
  console.log(`[backup] pg_dump → ${dump}`);
  const dumpRes = spawnSync(
    'pg_dump',
    ['--no-owner', '--no-privileges', '--format=custom', `--file=${dump}`, dbUrl],
    { stdio: 'inherit' },
  );
  if (dumpRes.status !== 0) {
    console.error(`[backup] pg_dump failed with exit ${dumpRes.status}`);
    process.exit(dumpRes.status ?? 1);
  }
  // Arg-array form: operator-controlled `out` is one argv element, not a
  // shell string. Was: `tar czf ${out} -C ${ETC_GENWORK} data ${dump}` —
  // a `;` or backtick in `out` would run an arbitrary command.
  console.log(`[backup] tar → ${out}`);
  const tarRes = spawnSync(
    'tar',
    ['czf', out, '-C', ETC_GENWORK, 'data', dump],
    { stdio: 'inherit' },
  );
  if (tarRes.status !== 0) {
    console.error(`[backup] tar failed with exit ${tarRes.status}`);
    process.exit(tarRes.status ?? 1);
  }
  console.log(`[backup] wrote ${out}`);
}
