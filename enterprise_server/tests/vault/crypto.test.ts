import '../helpers/setupEnv';
import { describe, expect, test } from 'vitest';
import { encrypt, decrypt } from '../../src/vault/crypto';

// Stable 32-byte key for tests. Real key comes from env at runtime.
// setupEnv already set the master key.

describe('vault/crypto', () => {
  test('encrypt + decrypt roundtrip', () => {
    const plain = 'sk-test-1234567890';
    const cipher = encrypt(plain);
    expect(cipher).not.toBe(plain);
    expect(decrypt(cipher)).toBe(plain);
  });

  test('不同的 IV 产生不同 ciphertext', () => {
    const a = encrypt('same');
    const b = encrypt('same');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('same');
    expect(decrypt(b)).toBe('same');
  });

  test('tampered ciphertext throws', () => {
    const c = encrypt('hello');
    const tampered = c.slice(0, -2) + 'AA';
    expect(() => decrypt(tampered)).toThrow();
  });
});
