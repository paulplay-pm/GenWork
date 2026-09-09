import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { assertDockerOnPath } from './lib/preflight.js';

const COMPOSE = process.env.COMPOSE_FILE ?? '/etc/genwork/compose.yml';
const CURRENT_VERSION_FILE = process.env.CURRENT_VERSION_FILE ?? '/etc/genwork/current-version';

async function tryHealth(): Promise<{ ok: boolean; latencyMs: number | null }> {
  const start = Date.now();
  try {
    const out = execSync('curl -fsS http://127.0.0.1:8787/health', { stdio: 'pipe' }).toString();
    return { ok: /ok/.test(out), latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: null };
  }
}

function readPs(): string {
  try {
    return execSync(`docker compose -f ${COMPOSE} ps --format json`, { stdio: 'pipe' }).toString();
  } catch {
    return '';
  }
}

export async function run(): Promise<void> {
  assertDockerOnPath();
  const ps = readPs();
  const running = /Up|running/.test(ps) || /"State":"running"/.test(ps);
  if (!running) {
    console.log('Service: not running');
    process.exit(2);
  }
  const health = await tryHealth();
  const version = existsSync(CURRENT_VERSION_FILE)
    ? readFileSync(CURRENT_VERSION_FILE, 'utf8').trim()
    : 'unknown';
  console.log('Service: running');
  console.log(
    `Health:  ${health.ok ? 'ok' : 'unhealthy'}${
      health.latencyMs != null ? ` (${health.latencyMs}ms)` : ''
    }`,
  );
  console.log(`Version: ${version}`);
  process.exit(health.ok ? 0 : 1);
}
