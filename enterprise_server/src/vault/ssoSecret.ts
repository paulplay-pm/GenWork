// enterprise_server/src/vault/ssoSecret.ts
// Vault helpers for SSO connection client secrets. Secrets are encrypted
// at rest (AES-256-GCM) and never leave the server; only a masked display
// form or a `has_secret` flag is ever exposed.
import { decrypt, encrypt } from './crypto';

export function encryptClientSecret(plaintext: string): string {
  return encrypt(plaintext);
}

export function decryptClientSecret(ciphertext: string): string {
  return decrypt(ciphertext);
}

/** Display mask for an SSO client secret: keep first 3 + last 4, mask the
 * middle with a fixed `••••`. Not a secret — purely a UI aid. Returns a
 * bare `••••` for empty or short (≤8 char) secrets so nothing is revealed. */
export function maskClientSecret(plaintext: string): string {
  if (!plaintext || plaintext.length <= 8) return '••••';
  return `${plaintext.slice(0, 3)}••••${plaintext.slice(-4)}`;
}

/** Admin-facing view of a connection row: strips the ciphertext
 * `client_secret_encrypted` entirely and adds a `has_secret` boolean.
 * The row's `client_secret_masked` column passes through untouched.
 * Never returns plaintext or ciphertext. */
export function redactConnectionSecrets<T extends Record<string, unknown>>(
  row: T,
): Omit<T, 'client_secret_encrypted'> & { has_secret: boolean } {
  const { client_secret_encrypted, ...rest } = row;
  return {
    ...rest,
    has_secret: typeof client_secret_encrypted === 'string' && client_secret_encrypted.length > 0,
  };
}
