import fs from 'fs';
import path from 'path';

import {
  EnterpriseBuildResource,
  EnterpriseServerUrlEnv,
} from '../../shared/enterprise/constants';

/**
 * Shape of the build-time-baked enterprise build-info file
 * (`.enterprise-build/enterprise.json`, shipped to
 * `process.resourcesPath/enterprise/enterprise.json` in packaged builds).
 *
 * Mirrors the `KeyfromBuildInfo` precedent (scripts/generate-keyfrom-build-info.cjs).
 */
interface EnterpriseBuildInfo {
  serverUrl: string;
  generatedAt: string;
}

/**
 * The environment variable that the enterprise bridge reads at runtime.
 * Re-exported so callers/tests share one source of truth with the shared
 * constants (and with the CJS generator, which hardcodes the same name).
 */
export const ENTERPRISE_SERVER_URL_ENV = EnterpriseServerUrlEnv.Url;

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Normalize a candidate enterprise server URL. Returns the trimmed value
 * with the trailing slash stripped, or `null` when the value is empty or not
 * a well-formed http(s) URL. We validate the shape so a malformed value
 * (left by a careless build) never silently gets baked in and only surfaces
 * much later as a confusing network error.
 */
function normalizeServerUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return trimTrailingSlash(trimmed);
}

function readBuildInfo(filePath: string): EnterpriseBuildInfo | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as EnterpriseBuildInfo;
  } catch (error) {
    console.warn(
      `[enterpriseServerUrl] failed to read build-info at ${filePath}:`,
      error
    );
    return null;
  }
}

/**
 * Best-effort parse of a single `KEY=VALUE` line from a dotenv-style file.
 * We intentionally do not depend on `dotenv` (it is not a direct dependency and
 * the main process is not bundled by Vite). Only the one key we need is read.
 * Surrounding single/double quotes are stripped, matching dotenv behavior.
 */
function readKeyFromDotEnvFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const prefix = `${ENTERPRISE_SERVER_URL_ENV}=`;
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (!line.startsWith(prefix)) continue;
      const value = line.slice(prefix.length).trim();
      const unquoted = value.replace(/^(['"])(.*)\1$/, '$2').trim();
      return unquoted;
    }
    return null;
  } catch (error) {
    console.warn(`[enterpriseServerUrl] failed to read .env at ${filePath}:`, error);
    return null;
  }
}

function shouldUseDevelopmentSources(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'development' || Boolean(env.ELECTRON_START_URL);
}

export interface SeedOptions {
  /** Override for `process.cwd()` — defaults to the real cwd. */
  cwd?: string;
  /** Override for `process.resourcesPath` — defaults to the real value (empty in dev). */
  resourcesPath?: string;
}

/**
 * Ordered candidate sources for the enterprise server URL, most-preferred
 * first. An explicit launch-environment value always wins (see
 * `seedEnterpriseServerUrl`); this list is only consulted when that is absent.
 *
 * 1. Packaged build-info — `process.resourcesPath/enterprise/enterprise.json`
 *    (the value baked in at packaging time). In dev this path does not exist
 *    under the stock Electron resources dir, so it naturally yields nothing.
 * 2. (dev only) Project `.env` — `ENTERPRISE_SERVER_URL=...`, so `electron:dev`
 *    reads the same `.env` used for packaging secrets without any shell export.
 * 3. (dev only) Project build-info — `<cwd>/.enterprise-build/enterprise.json`,
 *    the generator output for the current platform, so dev and a local prod
 *    build can share one value.
 */
function resolveCandidateSources(
  env: NodeJS.ProcessEnv,
  options: Required<SeedOptions>
): Array<() => string | null> {
  const sources: Array<() => string | null> = [];

  const resourcesPath = options.resourcesPath || process.resourcesPath;
  if (resourcesPath) {
    const packagedPath = path.join(
      resourcesPath,
      EnterpriseBuildResource.Directory,
      EnterpriseBuildResource.Filename
    );
    sources.push(() => {
      const info = readBuildInfo(packagedPath);
      return info ? normalizeServerUrl(info.serverUrl) : null;
    });
  }

  if (shouldUseDevelopmentSources(env)) {
    const projectEnvPath = path.join(options.cwd, '.env');
    sources.push(() => readKeyFromDotEnvFile(projectEnvPath));

    const devBuildInfoPath = path.join(
      options.cwd,
      EnterpriseBuildResource.BuildDir,
      EnterpriseBuildResource.Filename
    );
    sources.push(() => {
      const info = readBuildInfo(devBuildInfoPath);
      return info ? normalizeServerUrl(info.serverUrl) : null;
    });
  }

  return sources;
}

/**
 * Seed `process.env.ENTERPRISE_SERVER_URL` from a baked/`env` source when the
 * launch environment did not already provide one.
 *
 * Precedence (highest wins):
 *   1. `ENTERPRISE_SERVER_URL` in the process environment (MDM / terminal).
 *   2. Packaged build-info resource (baked at packaging time).
 *   3. (dev) project `.env`, then (dev) project build-info.
 *
 * Returns the value that now drives `getEnterpriseServerUrl()`, or `null` when
 * nothing could be resolved — in which case the existing behavior (the
 * `getEnterpriseServerUrl` throw / the EnterpriseSetupModal) is unchanged. This
 * means a build that was produced without a configured URL still degrades to
 * the interactive setup flow rather than failing at an obscure point.
 *
 * Must run before any code path that calls `getEnterpriseServerUrl()` at
 * startup (i.e. before `bootstrapMultiTenantEnterprise` and the agent-model
 * resolution in `initApp`).
 */
export function seedEnterpriseServerUrl(
  env: NodeJS.ProcessEnv = process.env,
  options: SeedOptions = {}
): string | null {
  const fromEnv = normalizeServerUrl(env[ENTERPRISE_SERVER_URL_ENV]);
  if (fromEnv) {
    // Environment wins: normalize and re-assign so a trailing slash never
    // leaks into downstream URL building.
    env[ENTERPRISE_SERVER_URL_ENV] = fromEnv;
    return fromEnv;
  }

  const resolvedOptions: Required<SeedOptions> = {
    cwd: options.cwd ?? process.cwd(),
    resourcesPath: options.resourcesPath ?? process.resourcesPath,
  };

  for (const resolve of resolveCandidateSources(env, resolvedOptions)) {
    const candidate = normalizeServerUrl(resolve());
    if (candidate) {
      env[ENTERPRISE_SERVER_URL_ENV] = candidate;
      console.log(`[enterpriseServerUrl] seeded ${ENTERPRISE_SERVER_URL_ENV} from build/config source`);
      return candidate;
    }
  }

  return null;
}
