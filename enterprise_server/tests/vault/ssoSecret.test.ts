// enterprise_server/tests/vault/ssoSecret.test.ts
import { describe, expect, test } from 'vitest';
import '../helpers/setupEnv';
import {
  encryptClientSecret,
  decryptClientSecret,
  maskClientSecret,
  redactConnectionSecrets,
} from '../../src/vault/ssoSecret';

describe('ssoSecret', () => {
  test('encrypt → decrypt round-trip', () => {
    const plain = 's3cr3t-with-some-length';
    const cipher = encryptClientSecret(plain);
    expect(cipher).not.toContain(plain);
    expect(decryptClientSecret(cipher)).toBe(plain);
  });

  test('maskClientSecret uses first-3 + dots + last-4 (mirror providerKeyVault)', () => {
    expect(maskClientSecret('abcdefghijklmnop')).toBe('abc••••mnop');
    expect(maskClientSecret('short')).toBe('••••');
  });

  test('redactConnectionSecrets strips client_secret_encrypted and keeps masked only', () => {
    const cipher = encryptClientSecret('hello-world-12');
    const row = {
      id: 'c1', org_id: 'o1', name: 'Acme', provider_type: 'generic-oidc',
      protocol: 'oidc', authorize_url: 'https://idp/x', token_url: 'https://idp/y',
      userinfo_url: null, client_id: 'cid', client_secret_encrypted: cipher,
      client_secret_masked: maskClientSecret('hello-world-12'), scopes: 'openid email',
      identity_id_field: 'sub', login_name_field: 'preferred_username',
      email_field: 'email', email_domain_whitelist: [], enabled: true,
      sort_order: 0, created_by: null, created_at: new Date(),
      updated_at: new Date(),
    };
    const redacted = redactConnectionSecrets(row);
    expect((redacted as Record<string, unknown>).client_secret_encrypted).toBeUndefined();
    expect(redacted.client_secret_masked).toBe('hel••••d-12');
  });
});
