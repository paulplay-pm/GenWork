import { describe, expect, test } from 'vitest';
import crypto from 'crypto';

import {
  buildGenericAuthorizeUrl,
  buildTokenExchangeBody,
  createPkce,
  parseTokenResponse,
} from './genericOauthFlow';

describe('createPkce', () => {
  test('produces a base64url verifier/challenge/state and the challenge is S256 of the verifier', () => {
    const { verifier, challenge, state } = createPkce();
    // The IdP receives the verifier STRING (base64url) and computes
    // BASE64URL(SHA256(code_verifier)) per RFC 7636 §4.2 — so the challenge
    // must hash the string itself, not the underlying raw bytes.
    const expectChallenge = crypto
      .createHash('sha256')
      .update(verifier)   // the base64url string itself — what the IdP receives
      .digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    expect(challenge).toBe(expectChallenge);
    expect(verifier).not.toMatch(/[+/=]/);
    expect(state).not.toMatch(/[+/=]/);
  });
});

describe('buildGenericAuthorizeUrl', () => {
  test('carries the standard PKCE params and scopes, url-encoded', () => {
    const url = buildGenericAuthorizeUrl({
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      clientId: 'cid 1',
      redirectUri: 'http://localhost:54321/callback',
      scopes: ['openid', 'email'],
      state: 'ST',
      challenge: 'CH',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://idp.example.com/oauth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid 1');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:54321/callback');
    expect(u.searchParams.get('scope')).toBe('openid email');
    expect(u.searchParams.get('state')).toBe('ST');
    expect(u.searchParams.get('code_challenge')).toBe('CH');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
  test('omits the scope param when there are no scopes', () => {
    const url = buildGenericAuthorizeUrl({
      authorizeUrl: 'https://idp/x', clientId: 'c', redirectUri: 'http://l', state: 's', challenge: 'ch',
    });
    expect(new URL(url).searchParams.get('scope')).toBeNull();
  });
});

describe('buildTokenExchangeBody', () => {
  test('encodes grant_type=authorization_code with code, verifier, client_id and no secret', () => {
    const body = buildTokenExchangeBody({ code: 'C0DE', codeVerifier: 'V0', clientId: 'CID' });
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('C0DE');
    expect(params.get('code_verifier')).toBe('V0');
    expect(params.get('client_id')).toBe('CID');
    expect(body).not.toContain('client_secret');
  });
});

describe('parseTokenResponse', () => {
  test('returns access_token from a valid JSON response', () => {
    expect(parseTokenResponse(JSON.stringify({ access_token: 'at-1', token_type: 'Bearer' }))).toBe('at-1');
  });
  test('throws when access_token is missing', () => {
    expect(() => parseTokenResponse(JSON.stringify({ error: 'invalid_grant' }))).toThrow();
  });
});
