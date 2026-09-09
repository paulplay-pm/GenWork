import '../helpers/setupEnv';

import { describe, expect, test } from 'vitest';

import {
  decryptConnectorSecrets,
  encryptConnectorSecrets,
  hasStoredSecret,
  maskConnectorSecrets,
  secretFieldFor,
} from '../../src/vault/connectorSecret';

describe('secretFieldFor', () => {
  test('maps auth modes to their secret field', () => {
    expect(secretFieldFor('shared-key')).toBe('apiKey');
    expect(secretFieldFor('user-oauth')).toBe('clientSecret');
    expect(secretFieldFor('client-creds')).toBe('clientSecret');
    expect(secretFieldFor('user-key')).toBeNull();
    expect(secretFieldFor('sso')).toBeNull();
    expect(secretFieldFor('none')).toBeNull();
  });
});

describe('encryptConnectorSecrets', () => {
  test('stores ciphertext under __enc__<field> and strips the plaintext', () => {
    const enc = encryptConnectorSecrets({ apiKey: 'sk-live-9f3a', clientId: 'cli_123' });
    expect(enc['apiKey']).toBeUndefined();
    expect(typeof enc['__enc__apiKey']).toBe('string');
    expect(enc['__enc__apiKey']).not.toBe('sk-live-9f3a');
    expect(enc['clientId']).toBe('cli_123');
  });

  test('is idempotent: a second call on encrypted input is a no-op', () => {
    const first = encryptConnectorSecrets({ apiKey: 'sk-live-9f3a' });
    const second = encryptConnectorSecrets(first);
    expect(second).toEqual(first);
  });

  test('encrypt then decrypt returns the original plaintext', () => {
    const enc = encryptConnectorSecrets({ apiKey: 'sk-live-9f3a' });
    const dec = decryptConnectorSecrets(enc);
    expect(dec['apiKey']).toBe('sk-live-9f3a');
  });

  test('decrypts the clientSecret field for oauth-style modes', () => {
    const enc = encryptConnectorSecrets({ clientSecret: 'cs-abcdef', clientId: 'cli_9' });
    const dec = decryptConnectorSecrets(enc);
    expect(dec['clientSecret']).toBe('cs-abcdef');
    expect(dec['clientId']).toBe('cli_9');
  });
});

describe('maskConnectorSecrets', () => {
  test('encrypt→mask round-trip: mask is •••• + last 4, __enc__ keys stripped', () => {
    const enc = encryptConnectorSecrets({ apiKey: 'sk-live-9f3a', clientId: 'cli_123' });
    const masked = maskConnectorSecrets(enc);
    expect(masked['apiKey']).toBe('••••9f3a');
    expect('__enc__apiKey' in masked).toBe(false);
    expect(masked['clientId']).toBe('cli_123');
  });

  test('non-secret fields pass through unchanged', () => {
    const enc = encryptConnectorSecrets({ clientId: 'cli_42' });
    const masked = maskConnectorSecrets(enc);
    expect(masked['clientId']).toBe('cli_42');
    expect(masked['apiKey']).toBeUndefined();
  });
});

describe('hasStoredSecret', () => {
  test('true after encrypt, false for an empty config', () => {
    expect(hasStoredSecret({})).toBe(false);
    const enc = encryptConnectorSecrets({ apiKey: 'sk-live-9f3a' });
    expect(hasStoredSecret(enc)).toBe(true);
  });

  test('true for the clientSecret field as well', () => {
    const enc = encryptConnectorSecrets({ clientSecret: 'cs-abcdef' });
    expect(hasStoredSecret(enc)).toBe(true);
  });
});
