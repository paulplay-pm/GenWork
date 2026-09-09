import crypto from 'crypto';

/**
 * Compute the hex sha256 of a buffer. Pure — no I/O.
 */
export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Verify a downloaded zip against an expected sha256 digest.
 * Returns `true` when `expected` is null/undefined — legacy catalog rows may
 * not carry a digest (spec §12), in which case the download is accepted
 * without verification.
 */
export function verifySha256(buf: Buffer, expected: string | null | undefined): boolean {
  if (expected === null || expected === undefined) return true;
  return sha256Hex(buf) === expected;
}
