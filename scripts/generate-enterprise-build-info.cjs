'use strict';

// Generate the build-time enterprise build-info file that bakes the enterprise
// server base URL into the packaged app.
//
// Resolves `ENTERPRISE_SERVER_URL` from the build environment (preferred) or,
// as a fallback, the project `.env`, and writes `.enterprise-build/enterprise.json`.
// `electron-builder-config.cjs` invokes this at load time, and `electron-builder.json`
// ships the directory into the app's resources (`process.resourcesPath/enterprise/enterprise.json`).
// The runtime seed (`src/main/libs/enterpriseServerUrlConfig.ts`) reads it at
// startup, so the desktop no longer requires the user to enter the URL in the
// GUI — a launch-environment `ENTERPRISE_SERVER_URL` still overrides the baked
// value.
//
// Because both the build (this script) and the dev runtime read the same
// `.env`, one file configures the URL for `npm run dist:*` and `npm run electron:dev`.
//
// Mirrors the `KEYFROM` precedent (scripts/generate-keyfrom-build-info.cjs):
// this file is best-effort. When no URL is configured it writes nothing and
// the runtime degrades to the interactive EnterpriseSetupModal rather than
// failing the build.

const fs = require('fs');
const path = require('path');

const ENV_NAME = 'ENTERPRISE_SERVER_URL';
const OUTPUT_DIR = path.join(__dirname, '..', '.enterprise-build');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'enterprise.json');
const ENV_FILE = path.join(__dirname, '..', '.env');

function normalizeServerUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return trimmed;
}

// Minimal dotenv-style reader for the single key we need (no dependency).
// Strips surrounding quotes to match dotenv behavior. Returns null when the
// file is absent or the key is not present.
function readServerUrlFromEnvFile() {
  try {
    if (!fs.existsSync(ENV_FILE)) return null;
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    const prefix = `${ENV_NAME}=`;
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || !line.startsWith(prefix)) continue;
      const value = line.slice(prefix.length).trim().replace(/^(['"])(.*)\1$/, '$2').trim();
      return value;
    }
    return null;
  } catch (error) {
    console.warn(`[Enterprise] failed to read ${ENV_NAME} from .env:`, error);
    return null;
  }
}

function main() {
  // The build environment wins (e.g. `ENTERPRISE_SERVER_URL=... npm run dist:mac`);
  // otherwise fall back to the project `.env` so one config file drives both the
  // packaged build and local `electron:dev`.
  const candidate = normalizeServerUrl(process.env[ENV_NAME])
    ?? normalizeServerUrl(readServerUrlFromEnvFile());

  if (!candidate) {
    // Nothing configured: leave any stale file alone for the reader to ignore
    // (the reader validates), and emit a note so the operator knows the value
    // was not baked in.
    console.warn(
      `[Enterprise] ${ENV_NAME} is not set (env or .env); the packaged app will fall back to the ` +
        'interactive enterprise-setup screen at first launch.'
    );
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUTPUT_PATH,
    `${JSON.stringify({ serverUrl: candidate, generatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  console.log(`[Enterprise] baked ${ENV_NAME} as ${candidate}`);
}

main();
