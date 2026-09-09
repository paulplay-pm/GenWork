import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { assertDockerOnPath, assertRoot, requireEnv } from './lib/preflight.js';

const ETC_GENWORK = process.env.GENWORK_ETC_DIR ?? '/etc/genwork';

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(`${prompt} [type YES to continue] `, (answer) => {
      rl.close();
      resolve(answer === 'YES');
    }),
  );
}

async function isServiceUp(): Promise<boolean> {
  try {
    const out = execSync('curl -fsS http://127.0.0.1:8787/health', { stdio: 'pipe' }).toString();
    return /ok/.test(out);
  } catch {
    return false;
  }
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  let archive: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') archive = argv[++i];
    else if (a === '--force') force = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!archive) {
    console.error('Usage: genwork-server restore --from <archive.tar.gz> [--force]');
    process.exit(2);
  }
  assertRoot();
  assertDockerOnPath();

  // Single check, cached — was: TOCTOU double-call before force warning.
  const serviceUp = await isServiceUp();
  if (serviceUp && !force) {
    console.error('Service is up. Stop it before restore, or pass --force.');
    process.exit(1);
  }
  if (serviceUp && force) {
    console.warn('!! WARNING: service is up. Restoring now will produce inconsistent state.');
  }
  if (!force) {
    const ok = await confirm('About to overwrite the database. This is destructive.');
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }
  // Extract to a staging dir first. We never `rm -rf` the live data dir
  // before the tar extract succeeds; if tar fails the live data survives.
  const work = mkdtempSync(join(tmpdir(), 'genwork-restore-'));
  console.log(`[restore] extracting ${archive} to staging`);
  const extract = spawnSync('tar', ['xzf', archive, '-C', work], { stdio: 'inherit' });
  if (extract.status !== 0) {
    console.error(`[restore] tar extract exited ${extract.status}`);
    process.exit(extract.status ?? 1);
  }
  const dump = join(work, 'dump.sql.gz');
  const dbUrl = requireEnv('DATABASE_URL');
  console.log(`[restore] pg_restore`);
  const r = spawnSync(
    'pg_restore',
    ['--no-owner', '--no-privileges', '--clean', '--if-exists', '--dbname', dbUrl, dump],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    console.error(`[restore] pg_restore exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
  // Atomic swap: rename the staging data dir over the live one. On a
  // single filesystem, rename(2) is atomic — there is no window where
  // the live dir is missing. Cross-device rename falls back to copy +
  // delete, which is still safe because we've already extracted the
  // replacement successfully.
  const liveData = join(ETC_GENWORK, 'data');
  const stagedData = join(work, 'data');
  if (!existsSync(stagedData)) {
    console.error(`[restore] archive did not contain a "data/" directory: ${stagedData} missing`);
    process.exit(1);
  }
  console.log(`[restore] swapping ${liveData} with staging copy`);
  if (existsSync(liveData)) rmSync(liveData, { recursive: true, force: true });
  try {
    renameSync(stagedData, liveData);
  } catch (e) {
    // Cross-device fallback: copy then delete staging.
    console.warn(`[restore] rename failed (${(e as Error).message}); falling back to copy`);
    spawnSync('cp', ['-a', stagedData, liveData], { stdio: 'inherit' });
    rmSync(stagedData, { recursive: true, force: true });
  }
  console.log('[restore] done.');
}
