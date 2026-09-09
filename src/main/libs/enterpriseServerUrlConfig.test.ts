import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const originalEnv = { ...process.env };

let tmpRoot: string;

beforeEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  // Start clean of dev/packaged source hints so each test controls them.
  delete process.env.NODE_ENV;
  delete process.env.ELECTRON_START_URL;
  delete process.env.ENTERPRISE_SERVER_URL;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-url-'));
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Shared options pointing the resolver at the temp dir (both cwd and, when
// packaged, resourcesPath live there).
function opts(resourcesPath?: string) {
  return { cwd: tmpRoot, resourcesPath: resourcesPath ?? '' };
}

// (dev) writes <tmp>/.env with the enterprise URL line.
function writeDotEnv(url: string): void {
  fs.writeFileSync(
    path.join(tmpRoot, '.env'),
    [
      '# dev enterprise config',
      `ENTERPRISE_SERVER_URL=${url}`,
      'APPLE_ID=ignore@example.com',
    ].join('\n')
  );
}

// (dev) writes <tmp>/.enterprise-build/enterprise.json.
function writeDevBuildInfo(url: string): void {
  const dir = path.join(tmpRoot, '.enterprise-build');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'enterprise.json'),
    JSON.stringify({ serverUrl: url, generatedAt: '1970-01-01T00:00:00.000Z' })
  );
}

// (prod) writes <tmp>/res/enterprise/enterprise.json.
function writePackagedBuildInfo(url: string): string {
  const res = path.join(tmpRoot, 'res');
  const dir = path.join(res, 'enterprise');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'enterprise.json'),
    JSON.stringify({ serverUrl: url, generatedAt: '1970-01-01T00:00:00.000Z' })
  );
  return res;
}

describe('seedEnterpriseServerUrl', () => {
  test('launch-env value wins over every source', async () => {
    writeDotEnv('https://from-dotenv.example');
    const res = writePackagedBuildInfo('https://from-packaged.example');
    const { seedEnterpriseServerUrl } = await import('./enterpriseServerUrlConfig');
    const env: NodeJS.ProcessEnv = {
      ENTERPRISE_SERVER_URL: 'https://from-env.example/',
    };
    expect(seedEnterpriseServerUrl(env, opts(res))).toBe('https://from-env.example');
    expect(env.ENTERPRISE_SERVER_URL).toBe('https://from-env.example');
    // The real process env must be untouched.
    expect(process.env.ENTERPRISE_SERVER_URL).toBeUndefined();
  });

  test('trims a trailing slash from the launch-env value', async () => {
    const { seedEnterpriseServerUrl } = await import('./enterpriseServerUrlConfig');
    const env: NodeJS.ProcessEnv = { ENTERPRISE_SERVER_URL: 'https://env.example///' };
    expect(seedEnterpriseServerUrl(env, opts())).toBe('https://env.example');
    expect(env.ENTERPRISE_SERVER_URL).toBe('https://env.example');
  });

  test('reads packaged build-info in production when env is unset', async () => {
    const res = writePackagedBuildInfo('https://prod.example/');
    const { seedEnterpriseServerUrl } = await import('./enterpriseServerUrlConfig');
    const env: NodeJS.ProcessEnv = {};
    expect(seedEnterpriseServerUrl(env, opts(res))).toBe('https://prod.example');
    expect(env.ENTERPRISE_SERVER_URL).toBe('https://prod.example');
  });

  test('reads .env in development when env is unset', async () => {
    process.env.NODE_ENV = 'development';
    writeDotEnv('https://dev-dotenv.example');
    const { seedEnterpriseServerUrl } = await import('./enterpriseServerUrlConfig');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
    expect(seedEnterpriseServerUrl(env, opts())).toBe('https://dev-dotenv.example');
    expect(env.ENTERPRISE_SERVER_URL).toBe('https://dev-dotenv.example');
  });

  test('reads .enterprise-build build-info in development', async () => {
    writeDevBuildInfo('https://dev-buildinfo.example');
    const { seedEnterpriseServerUrl } = await import('./enterpriseServerUrlConfig');
    const env: NodeJS.ProcessEnv = { ELECTRON_START_URL: 'http://localhost:5175' };
    expect(seedEnterpriseServerUrl(env, opts())).toBe('https://dev-buildinfo.example');
  });

  test('does not consult .env outside development', async () => {
    // No NODE_ENV/ELECTRON_START_URL, no packaged resource: .env must be ignored.
    writeDotEnv('https://should-not-be-used.example');
    const { seedEnterpriseServerUrl } = await import('./enterpriseServerUrlConfig');
    const env: NodeJS.ProcessEnv = {};
    expect(seedEnterpriseServerUrl(env, opts())).toBeNull();
    expect(env.ENTERPRISE_SERVER_URL).toBeUndefined();
  });

  test('packaged build-info wins over dev .env when both present', async () => {
    process.env.NODE_ENV = 'development';
    writeDotEnv('https://dev-dotenv.example');
    const res = writePackagedBuildInfo('https://packaged.example');
    const { seedEnterpriseServerUrl } = await import('./enterpriseServerUrlConfig');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
    expect(seedEnterpriseServerUrl(env, opts(res))).toBe('https://packaged.example');
  });

  test('ignores a malformed URL and leaves env unset', async () => {
    const res = writePackagedBuildInfo('not-a-url');
    const { seedEnterpriseServerUrl } = await import('./enterpriseServerUrlConfig');
    const env: NodeJS.ProcessEnv = {};
    expect(seedEnterpriseServerUrl(env, opts(res))).toBeNull();
    expect(env.ENTERPRISE_SERVER_URL).toBeUndefined();
  });

  test('rejects a non-http(s) scheme', async () => {
    writePackagedBuildInfo('ftp://bad.example');
    const { seedEnterpriseServerUrl } = await import('./enterpriseServerUrlConfig');
    const env: NodeJS.ProcessEnv = {};
    expect(seedEnterpriseServerUrl(env, opts(path.join(tmpRoot, 'res')))).toBeNull();
  });

  test('returns null (unchanged behavior) when nothing is configured', async () => {
    const { seedEnterpriseServerUrl } = await import('./enterpriseServerUrlConfig');
    const env: NodeJS.ProcessEnv = {};
    expect(seedEnterpriseServerUrl(env, opts())).toBeNull();
    expect(env.ENTERPRISE_SERVER_URL).toBeUndefined();
  });
});
