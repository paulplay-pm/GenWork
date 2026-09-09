import { describe, expect, test } from 'vitest';

import { sha256Hex, verifySha256 } from './skillZipIntegrity';

describe('verifySha256', () => {
  test('matches a correct hash', () => {
    const buf = Buffer.from('hello');
    expect(verifySha256(buf, sha256Hex(buf))).toBe(true);
  });

  test('rejects a wrong hash', () => {
    const buf = Buffer.from('hello');
    expect(verifySha256(buf, 'deadbeef'.repeat(8))).toBe(false);
  });

  test('accepts when expected is absent (legacy row)', () => {
    expect(verifySha256(Buffer.from('x'), null)).toBe(true);
    expect(verifySha256(Buffer.from('x'), undefined)).toBe(true);
  });
});
