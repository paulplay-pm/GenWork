import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const originalEnv = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe('getEnterpriseServerUrl', () => {
  test('throws when ENTERPRISE_SERVER_URL is unset', async () => {
    delete process.env.ENTERPRISE_SERVER_URL;
    const { getEnterpriseServerUrl } = await import('./endpoints');
    expect(() => getEnterpriseServerUrl()).toThrow(/ENTERPRISE_SERVER_URL/);
  });

  test('returns trimmed env (strips trailing slash)', async () => {
    process.env.ENTERPRISE_SERVER_URL = 'http://127.0.0.1:8787/';
    const { getEnterpriseServerUrl } = await import('./endpoints');
    expect(getEnterpriseServerUrl()).toBe('http://127.0.0.1:8787');
  });

  test('passes through plain env', async () => {
    process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
    const { getEnterpriseServerUrl } = await import('./endpoints');
    expect(getEnterpriseServerUrl()).toBe('https://ent.example');
  });
});

describe('derived URL helpers', () => {
  beforeEach(() => {
    process.env.ENTERPRISE_SERVER_URL = 'http://ent';
  });

  test('getServerApiBaseUrl returns enterprise URL', async () => {
    const { getServerApiBaseUrl } = await import('./endpoints');
    expect(getServerApiBaseUrl()).toBe('http://ent');
  });

  test('getHtmlSharePublicBaseUrl joins /api/pages', async () => {
    const { getHtmlSharePublicBaseUrl } = await import('./endpoints');
    expect(getHtmlSharePublicBaseUrl()).toBe('http://ent/api/pages');
  });

  test('getUpdateCheckUrl joins /updates/latest', async () => {
    const { getUpdateCheckUrl } = await import('./endpoints');
    expect(getUpdateCheckUrl()).toBe('http://ent/updates/latest');
  });

  test('getManualUpdateCheckUrl joins /updates/latest', async () => {
    const { getManualUpdateCheckUrl } = await import('./endpoints');
    expect(getManualUpdateCheckUrl()).toBe('http://ent/updates/latest');
  });

  test('removed URLs return empty string', async () => {
    const { getFallbackDownloadUrl, getSkillStoreUrl, getKitStoreUrl, getPortalTasksUrl } =
      await import('./endpoints');
    expect(getFallbackDownloadUrl()).toBe('');
    expect(getSkillStoreUrl()).toBe('');
    expect(getKitStoreUrl()).toBe('');
    expect(getPortalTasksUrl()).toBe('');
  });
});