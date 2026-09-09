// enterprise_server/tests/sso/ssoLoginContext.test.ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { type SsoLoginContext,ssoLoginContextStore } from '../../src/sso/ssoLoginContext';

describe('sso/ssoLoginContext', () => {
  beforeEach(() => { ssoLoginContextStore.delete('s1'); ssoLoginContextStore.delete('s2'); });

  test('set + get + delete round-trip', () => {
    const ctx: SsoLoginContext = {
      kind: 'pending_bind', orgId: 'o1', connectionId: 'c1',
      externalId: 'ext-1', email: null, loginName: null,
      returnTarget: 'console',
      redirectUri: 'http://x', codeVerifier: 'v',
      expiresAt: new Date(Date.now() + 60_000),
    };
    ssoLoginContextStore.set('s1', ctx);
    expect(ssoLoginContextStore.get('s1')).toEqual(ctx);
    expect(ssoLoginContextStore.delete('s1')).toBe(true);
    expect(ssoLoginContextStore.get('s1')).toBeUndefined();
  });

  test('expired entry is invisible to get', () => {
    const expired: SsoLoginContext = {
      kind: 'pending_bind', orgId: 'o1', connectionId: 'c1',
      externalId: 'ext-1', email: null, loginName: null,
      returnTarget: 'console',
      redirectUri: null, codeVerifier: null,
      expiresAt: new Date(Date.now() - 1),
    };
    ssoLoginContextStore.set('s2', expired);
    expect(ssoLoginContextStore.get('s2')).toBeUndefined();
    // cleanup happened implicitly on get
  });

  test('size() reflects non-expired entries only', () => {
    const live: SsoLoginContext = {
      kind: 'self_binding', orgId: 'o1', connectionId: 'c1',
      userId: 'u1', redirectUri: null, codeVerifier: null,
      returnTarget: 'console',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const expired: SsoLoginContext = {
      kind: 'pending_bind', orgId: 'o1', connectionId: 'c1',
      externalId: 'ext', email: null, loginName: null,
      returnTarget: 'console',
      redirectUri: null, codeVerifier: null,
      expiresAt: new Date(Date.now() - 1),
    };
    ssoLoginContextStore.set('live', live);
    ssoLoginContextStore.set('exp', expired);
    expect(ssoLoginContextStore.size()).toBe(1);
    ssoLoginContextStore.delete('live');
  });

  test('kind transitions: pending_bind -> ready_to_finalize -> deleted', () => {
    const pending: SsoLoginContext = {
      kind: 'pending_bind', orgId: 'o1', connectionId: 'c1',
      externalId: 'ext-1', email: null, loginName: null,
      returnTarget: 'console',
      redirectUri: 'http://x', codeVerifier: 'v',
      expiresAt: new Date(Date.now() + 60_000),
    };
    ssoLoginContextStore.set('s3', pending);
    expect(ssoLoginContextStore.get('s3')?.kind).toBe('pending_bind');

    // Task 5 calls this transition: change kind in place, keep entry.
    const ready: SsoLoginContext = {
      ...pending, kind: 'ready_to_finalize', boundUserId: 'u1',
    };
    ssoLoginContextStore.set('s3', ready);
    expect(ssoLoginContextStore.get('s3')?.kind).toBe('ready_to_finalize');

    // Task 4 deletes the entry after issuing the token.
    ssoLoginContextStore.delete('s3');
    expect(ssoLoginContextStore.get('s3')).toBeUndefined();
  });
});
