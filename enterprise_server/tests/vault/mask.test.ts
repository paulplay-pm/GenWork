import '../helpers/setupEnv';

import { describe, expect, test } from 'vitest';

import { encrypt } from '../../src/vault/crypto';
import { maskCredential } from '../../src/vault/mask';

describe('maskCredential', () => {
  test('masks to last 4 of the decrypted plaintext', () => {
    expect(maskCredential(encrypt('wk-abc-93bd'))).toBe('••••93bd');
  });
  test('returns null for empty input', () => {
    expect(maskCredential(null)).toBeNull();
    expect(maskCredential(undefined)).toBeNull();
    expect(maskCredential('')).toBeNull();
  });
  test('returns null when the decrypted value is empty', () => {
    expect(maskCredential(encrypt(''))).toBeNull();
  });
  test('returns generic mask when decrypt throws', () => {
    expect(maskCredential('not-valid-base64-ciphertext!!!')).toBe('••••');
  });
});
