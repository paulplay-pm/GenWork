import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const GENWORK_VAULT_MASTER_KEY = 'GENWORK_VAULT_MASTER_KEY';

function masterKey(): Buffer {
  const b64 = process.env[GENWORK_VAULT_MASTER_KEY];
  if (!b64) {
    throw new Error(`${GENWORK_VAULT_MASTER_KEY} not set`);
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) throw new Error('master key must be 32 bytes');
  return buf;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64');
}

export function decrypt(ciphertextB64: string): string {
  const buf = Buffer.from(ciphertextB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}