import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { assertDockerOnPath, assertRoot } from './lib/preflight.js';

const COMPOSE = process.env.COMPOSE_FILE ?? '/etc/genwork/compose.yml';
const PREVIOUS_VERSION_FILE = process.env.PREVIOUS_VERSION_FILE ?? '/etc/genwork/previous-version';
const CURRENT_VERSION_FILE = process.env.CURRENT_VERSION_FILE ?? '/etc/genwork/current-version';
const HEALTH_TIMEOUT_MS = Number(process.env.UPGRADE_HEALTH_TIMEOUT_MS ?? 30_000);
const HEALTH_POLL_MS = Number(process.env.UPGRADE_HEALTH_POLL_MS ?? 1_000);

function readComposeImage(): string {
  const text = readFileSync(COMPOSE, 'utf8');
  const m = text.match(/^(\s*)image:\s*(\S+)\s*$/m);
  if (!m) throw new Error(`Could not find "image:" line in ${COMPOSE}`);
  return m[2];
}

function writeComposeImage(image: string): void {
  const text = readFileSync(COMPOSE, 'utf8');
  const updated = text.replace(/^(\s*)image:\s*\S+\s*$/m, `$1image: ${image}`);
  writeFileSync(COMPOSE, updated);
}

function recordVersion(previous: string, current: string): void {
  writeFileSync(PREVIOUS_VERSION_FILE, previous);
  writeFileSync(CURRENT_VERSION_FILE, current);
}

async function pollHealth(): Promise<{ healthy: boolean; lastError: string }> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = 'healthcheck timed out before any response';
  while (Date.now() < deadline) {
    try {
      // curl has no operator-controlled fields, so a shell-form is safe
      // here. We keep the literal command unchanged.
      const out = execSync('curl -fsS http://127.0.0.1:8787/health', { stdio: 'pipe' }).toString();
      if (/ok/.test(out)) return { healthy: true, lastError };
    } catch (e) {
      // Capture the last failure for the rollback branch — silently
      // swallowing means an operator has no idea why the upgrade rolled
      // back. spec §5.5 / §7 require the captured log to be printed.
      lastError = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return { healthy: false, lastError };
}

// spawnSync arg-array form for any command that takes operator-controlled
// values (--to / IMAGE_REPO / COMPOSE_FILE). Was: execSync(`docker ... ${newImage}`)
// — a `;` in --to would have run an arbitrary command.
function runDocker(args: string[]): void {
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`docker ${args.join(' ')} exited ${r.status}`);
  }
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  let to: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--to') to = argv[++i];
    else {
      console.error(`Unknown arg: ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!to) {
    console.error('Usage: genwork-server upgrade --to <version>');
    process.exit(2);
  }

  assertRoot();
  assertDockerOnPath();

  const repo = process.env.IMAGE_REPO ?? 'enterprise-server';
  const newImage = `${repo}:${to}`;

  try {
    const previousImage = readComposeImage();

    console.log(`[upgrade] pulling ${newImage}`);
    runDocker(['pull', newImage]);

    console.log('[upgrade] dry-run pre-migration');
    runDocker([
      'run',
      '--rm',
      '--env-file',
      '.env',
      '-e',
      'GENWORK_MIGRATE_DRY_RUN=1',
      newImage,
      'genwork-server',
      'migrate',
    ]);

    console.log(`[upgrade] swapping image to ${newImage}`);
    writeComposeImage(newImage);
    console.log('[upgrade] restarting container');
    runDocker(['compose', '-f', COMPOSE, 'up', '-d']);

    const { healthy, lastError } = await pollHealth();
    if (!healthy) {
      console.error(
        `[upgrade] healthcheck failed; rolling back to ${previousImage}. ` +
          `Last healthcheck error: ${lastError}`,
      );
      writeComposeImage(previousImage);
      runDocker(['compose', '-f', COMPOSE, 'up', '-d']);
      console.error(
        '[upgrade] FAILED — image rolled back; database untouched (pre-migration was dry-run)',
      );
      process.exit(1);
    }
    recordVersion(previousImage, newImage);
    console.log(`[upgrade] complete: ${previousImage} → ${newImage}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[upgrade] ${msg}`);
    process.exit(1);
  }
}
