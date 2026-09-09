import { decrypt, encrypt } from './crypto';

/** Which per-mode field holds the secret. */
export function secretFieldFor(authMode: string): string | null {
  if (authMode === 'shared-key' || authMode === 'user-oauth' || authMode === 'client-creds') {
    return authMode === 'shared-key' ? 'apiKey' : 'clientSecret';
  }
  return null;
}

const ENC_PREFIX = '__enc__';

/** Encrypt the secret field, storing it as `__enc__<field>` and removing the
 * plaintext. Non-secret fields pass through untouched. Idempotent: if the
 * field is already encrypted it is left as-is. */
export function encryptConnectorSecrets(authConfig: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...authConfig };
  for (const mode of ['shared-key', 'user-oauth', 'client-creds'] as const) {
    const f = secretFieldFor(mode);
    if (!f) continue;
    const v = out[f];
    if (typeof v === 'string' && v.length > 0) {
      out[`${ENC_PREFIX}${f}`] = encrypt(v);
      delete out[f];
    }
  }
  return out;
}

/** Recover plaintext secret field(s) from `__enc__` ciphertexts. */
export function decryptConnectorSecrets(authConfig: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...authConfig };
  for (const f of ['apiKey', 'clientSecret']) {
    const c = out[`${ENC_PREFIX}${f}`];
    if (typeof c === 'string') {
      try {
        out[f] = decrypt(c);
      } catch {
        out[f] = null;
      }
    }
  }
  return out;
}

/** Masked view: non-secret fields pass through; secret fields become a mask
 * or a `hasSecret` marker. Never returns plaintext. */
export function maskConnectorSecrets(authConfig: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...authConfig };
  for (const f of ['apiKey', 'clientSecret']) {
    const c = out[`${ENC_PREFIX}${f}`];
    if (typeof c === 'string') {
      try {
        out[f] = `••••${decrypt(c).slice(-4)}`;
      } catch {
        out[f] = '••••';
      }
    }
    delete out[`${ENC_PREFIX}${f}`];
  }
  return out;
}

export function hasStoredSecret(authConfig: Record<string, unknown>): boolean {
  return typeof authConfig['__enc__apiKey'] === 'string' || typeof authConfig['__enc__clientSecret'] === 'string';
}
