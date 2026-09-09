// enterprise_server/tests/sso/oauth.test.ts
import '../helpers/setupEnv';

import { SignJWT } from 'jose';
import { describe, expect, test } from 'vitest';

import { buildAuthorizeUrl, verifyIdToken } from '../../src/sso/oauth';
import type { SsoConnectionRow } from '../../src/sso/types';

function baseConn(overrides: Partial<SsoConnectionRow> = {}): SsoConnectionRow {
  return {
    id: 'c1', org_id: 'o1', name: 'Acme',
    provider_type: 'generic-oidc', protocol: 'oidc',
    authorize_url: 'https://idp.example/authorize', token_url: 'https://idp.example/token',
    userinfo_url: 'https://idp.example/userinfo',
    client_id: 'cid', client_secret_encrypted: null, client_secret_masked: null,
    scopes: 'openid email', identity_id_field: 'sub', login_name_field: 'preferred_username',
    email_field: 'email', email_domain_whitelist: [], require_prebinding: false,
    enabled: true, sort_order: 0,
    created_by: null, created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}

describe('sso/oauth', () => {
  test('buildAuthorizeUrl attaches PKCE params + state + scopes', () => {
    const url = buildAuthorizeUrl(baseConn(), 'state-xyz', 'challenge-abc');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://idp.example/authorize');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBeTruthy();
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('state-xyz');
    expect(u.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('openid email');
  });

  test('verifyIdToken parses a signed JWS payload (HS256 with client_secret)', async () => {
    const secret = new TextEncoder().encode('a-shared-secret-of-sufficient-length');
    const tok = await new SignJWT({ sub: 'id-1', email: 'a@x.com', preferred_username: 'a' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
    const claims = await verifyIdToken(baseConn({ client_secret_encrypted: 'whatever' }), tok, 'a-shared-secret-of-sufficient-length');
    expect(claims.sub).toBe('id-1');
    expect(claims.email).toBe('a@x.com');
  });
});
