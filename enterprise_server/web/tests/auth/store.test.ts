import { beforeEach,describe, expect, test } from 'vitest';

import { isTokenExpired, readStoredSession, useAuthStore } from '../../src/auth/store';

function makeJwt(claims: { sub?: string; orgId?: string; roles: string[] }): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: claims.sub ?? 'u1',
      orgId: claims.orgId ?? 'o1',
      roles: claims.roles,
    })
  ).toString('base64url');
  return `header.${payload}.sig`;
}

function makeJwtWithExp(exp: number | undefined): string {
  const body: Record<string, unknown> = { sub: 'u1', orgId: 'o1', roles: ['org_admin'] };
  if (exp !== undefined) body.exp = exp;
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `header.${payload}.sig`;
}

describe('auth/store', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
  });

  test('login persists token + decodes claims', () => {
    const token = makeJwt({ roles: ['org_admin', 'user'] });
    useAuthStore.getState().login(token);
    const s = useAuthStore.getState();
    expect(s.token).toBe(token);
    expect(s.claims?.sub).toBe('u1');
    expect(s.claims?.orgId).toBe('o1');
    expect(s.claims?.roles).toEqual(['org_admin', 'user']);
  });

  test('hasCapability true for granted role; super_admin grants all', () => {
    useAuthStore.getState().login(makeJwt({ roles: ['org_admin'] }));
    expect(useAuthStore.getState().hasCapability('org_admin')).toBe(true);
    expect(useAuthStore.getState().hasCapability('model_admin')).toBe(false);

    useAuthStore.getState().login(makeJwt({ roles: ['super_admin'] }));
    expect(useAuthStore.getState().hasCapability('model_admin')).toBe(true);
    expect(useAuthStore.getState().hasCapability('org_admin')).toBe(true);
  });

  test('logout clears state', () => {
    useAuthStore.getState().login(makeJwt({ roles: ['user'] }));
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().claims).toBeNull();
  });

  test('unauthenticated: hasCapability false', () => {
    expect(useAuthStore.getState().hasCapability('org_admin')).toBe(false);
  });
});

describe('auth/store persistence', () => {
  const TOKEN_KEY = 'genwork.enterprise.auth.token';
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
  });

  test('login writes the token to localStorage; logout removes it', () => {
    useAuthStore.getState().login(makeJwt({ roles: ['org_admin'] }));
    expect(localStorage.getItem(TOKEN_KEY)).not.toBeNull();
    expect(useAuthStore.getState().token).toBe(localStorage.getItem(TOKEN_KEY));

    useAuthStore.getState().logout();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
  });

  test('readStoredSession restores a stored, non-expired token + claims', () => {
    const token = makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    localStorage.setItem(TOKEN_KEY, token);
    const s = readStoredSession();
    expect(s.token).toBe(token);
    expect(s.claims?.roles).toEqual(['org_admin']);
  });

  test('readStoredSession returns empty when nothing is stored', () => {
    const s = readStoredSession();
    expect(s.token).toBeNull();
    expect(s.claims).toBeNull();
  });

  test('readStoredSession drops an expired token (removes it from storage)', () => {
    const token = makeJwtWithExp(Math.floor(Date.now() / 1000) - 10);
    localStorage.setItem(TOKEN_KEY, token);
    const s = readStoredSession();
    expect(s.token).toBeNull();
    expect(s.claims).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  test('isTokenExpired: past exp → true, future/absent exp → false', () => {
    expect(isTokenExpired(makeJwtWithExp(Math.floor(Date.now() / 1000) - 1))).toBe(true);
    expect(isTokenExpired(makeJwtWithExp(Math.floor(Date.now() / 1000) + 3600))).toBe(false);
    expect(isTokenExpired(makeJwt({ roles: ['user'] }))).toBe(false); // no exp → not treated as expired
    expect(isTokenExpired('not.a.jwt')).toBe(false);
  });
});