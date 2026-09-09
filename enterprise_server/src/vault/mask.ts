import { decrypt } from './crypto';

/**
 * Produce a short masked form of an encrypted credential for display.
 * Decrypts, then returns `••••<last4>`. Returns `null` when there is no
 * credential to mask, and a bare `••••` if decryption fails (we never surface
 * the plaintext, and we never leak an exception to the caller).
 */
export function maskCredential(cipher: string | null | undefined): string | null {
  if (!cipher) return null;
  try {
    const plain = decrypt(cipher);
    if (!plain) return null;
    return '••••' + plain.slice(-4);
  } catch {
    return '••••';
  }
}
