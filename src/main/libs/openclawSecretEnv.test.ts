import { describe, expect, test } from 'vitest';

import { collectReferencedEnvVarNames, pickReferencedSecretEnvVars } from './openclawSecretEnv';

describe('collectReferencedEnvVarNames', () => {
  test('extracts OpenClaw env placeholders from serialized config', () => {
    const refs = collectReferencedEnvVarNames({
      models: {
        providers: {
          openai: { apiKey: '${GENWORK_APIKEY_OPENAI}' },
          server: { apiKey: '${GENWORK_PROXY_TOKEN}' },
        },
      },
      ignored: '${not-uppercase}',
    });

    expect([...refs].sort()).toEqual([
      'GENWORK_APIKEY_OPENAI',
      'GENWORK_PROXY_TOKEN',
    ]);
  });
});

describe('pickReferencedSecretEnvVars', () => {
  test('ignores dynamic secrets that are not referenced by openclaw config', () => {
    const referenced = new Set(['GENWORK_PROXY_TOKEN']);

    const before = pickReferencedSecretEnvVars({
      GENWORK_APIKEY_SERVER: 'old-access-token',
      GENWORK_PROXY_TOKEN: 'stable-proxy-token',
    }, referenced);
    const after = pickReferencedSecretEnvVars({
      GENWORK_APIKEY_SERVER: 'new-access-token',
      GENWORK_PROXY_TOKEN: 'stable-proxy-token',
    }, referenced);

    expect(before).toEqual({ GENWORK_PROXY_TOKEN: 'stable-proxy-token' });
    expect(JSON.stringify(before)).toBe(JSON.stringify(after));
  });

  test('keeps referenced secret changes visible for restart decisions', () => {
    const referenced = new Set(['GENWORK_APIKEY_OPENAI']);

    const before = pickReferencedSecretEnvVars({
      GENWORK_APIKEY_OPENAI: 'sk-old',
      GENWORK_APIKEY_SERVER: 'old-access-token',
    }, referenced);
    const after = pickReferencedSecretEnvVars({
      GENWORK_APIKEY_OPENAI: 'sk-new',
      GENWORK_APIKEY_SERVER: 'new-access-token',
    }, referenced);

    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
  });
});
