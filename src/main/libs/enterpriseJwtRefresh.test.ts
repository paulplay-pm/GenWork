/**
 * Unit tests for the enterprise-JWT self-heal (Step 7).
 *
 * `refreshEnterpriseJwtIfDue` rotates the stored enterprise JWT only while it
 * is still valid and within the refresh window — the /auth/refresh endpoint
 * re-verifies the current token, so an already-expired JWT cannot be rotated.
 * The decision is single-flight (concurrent triggers share one in-flight
 * refresh) and the "apply" fan-out (config re-sync + dsh re-spawn) fires only
 * on a real rotation.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Session } from '../auth/sessionStorage';
import {
  _resetEnterpriseJwtRefreshForTest,
  type EnterpriseJwtRefreshDeps,
  readJwtExpMs,
  refreshEnterpriseJwtIfDue,
} from './enterpriseJwtRefresh';

// Build a JWT whose payload carries the given exp (seconds). Unsigned is fine
// — readJwtExpMs only base64url-decodes the payload, it never verifies.
function makeJwt(expSeconds: number, prefix = 'header'): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'u-1', orgId: 'org-1', exp: expSeconds }), 'utf8').toString('base64url');
  return `${prefix}.${payload}.signature`;
}

function makeDeps(overrides: {
  session?: Session | null;
  refreshToken?: string;
  refreshImpl?: () => Promise<{ token: string }>;
  now?: () => number;
  refreshWindowMs?: number;
} = {}): EnterpriseJwtRefreshDeps & {
  persistSession: ReturnType<typeof vi.fn>;
  applyConfig: ReturnType<typeof vi.fn>;
  refreshPlanCredential: ReturnType<typeof vi.fn>;
} {
  const persistSession = vi.fn();
  const applyConfig = vi.fn(async () => undefined);
  const refreshPlanCredential = vi.fn();
  const refreshImpl =
    overrides.refreshImpl ??
    (async () => ({ token: makeJwt((overrides.now?.() ?? Date.now()) / 1000 + 3600) }));
  const refresh = vi.fn(refreshImpl);
  return {
    getSession: () => overrides.session ?? null,
    refresh,
    persistSession,
    applyConfig,
    refreshPlanCredential,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.refreshWindowMs ? { refreshWindowMs: overrides.refreshWindowMs } : {}),
  };
}

const SESSION: Session = {
  userId: 'u-1',
  orgId: 'org-1',
  username: 'tester',
  displayName: 'Tester',
  roles: [],
  jwt: '',
  expiresAt: 0,
};

describe('readJwtExpMs', () => {
  test('decodes the exp claim (seconds) into ms', () => {
    expect(readJwtExpMs(makeJwt(1_700_000_000))).toBe(1_700_000_000_000);
  });

  test('returns null for malformed or claim-less tokens', () => {
    expect(readJwtExpMs('not-a-jwt')).toBeNull();
    expect(readJwtExpMs('a.b.c')).toBeNull(); // empty-ish payload
    expect(readJwtExpMs('header.' + Buffer.from('{}').toString('base64url') + '.sig')).toBeNull();
  });
});

describe('refreshEnterpriseJwtIfDue', () => {
  beforeEach(() => {
    _resetEnterpriseJwtRefreshForTest();
  });

  const now = () => 1_700_000_000_000; // fixed clock for deterministic windows
  const nowSec = now() / 1000;

  test('skips (not-due) when the JWT is well outside the refresh window', async () => {
    const deps = makeDeps({
      session: { ...SESSION, jwt: makeJwt(nowSec + 3600), expiresAt: now() + 3600_000 },
      now,
      refreshWindowMs: 10 * 60 * 1000,
    });
    const result = await refreshEnterpriseJwtIfDue(deps);
    expect(result.status).toBe('not-due');
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.persistSession).not.toHaveBeenCalled();
    expect(deps.applyConfig).not.toHaveBeenCalled();
  });

  test('rotates when within the window and fans out to config + dsh', async () => {
    const newJwt = makeJwt(nowSec + 3600);
    const deps = makeDeps({
      session: { ...SESSION, jwt: makeJwt(nowSec + 8 * 60), expiresAt: now() + 8 * 60_000 }, // 8m < 10m window
      now,
      refreshWindowMs: 10 * 60 * 1000,
      refreshImpl: async () => ({ token: newJwt }),
    });
    const result = await refreshEnterpriseJwtIfDue(deps);
    expect(result.status).toBe('refreshed');
    expect(deps.persistSession).toHaveBeenCalledOnce();
    // The persisted session carries the new JWT and a decoded new expiry.
    const persisted = deps.persistSession.mock.calls[0][0] as Session;
    expect(persisted.jwt).toBe(newJwt);
    expect(persisted.expiresAt).toBe(now() + 3600_000);
    expect(deps.applyConfig).toHaveBeenCalledOnce();
    expect(deps.refreshPlanCredential).toHaveBeenCalledOnce();
  });

  test('reports jwt-expired and does NOT attempt a doomed refresh', async () => {
    const deps = makeDeps({
      session: { ...SESSION, jwt: makeJwt(nowSec - 60), expiresAt: now() - 60_000 },
      now,
      refreshWindowMs: 10 * 60 * 1000,
    });
    const result = await refreshEnterpriseJwtIfDue(deps);
    expect(result.status).toBe('jwt-expired');
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.applyConfig).not.toHaveBeenCalled();
  });

  test('reports not-logged-in when there is no session', async () => {
    const deps = makeDeps({ session: null, now });
    const result = await refreshEnterpriseJwtIfDue(deps);
    expect(result.status).toBe('not-logged-in');
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  test('reports refresh-failed when the refresh request throws', async () => {
    const deps = makeDeps({
      session: { ...SESSION, jwt: makeJwt(nowSec + 8 * 60), expiresAt: now() + 8 * 60_000 },
      now,
      refreshWindowMs: 10 * 60 * 1000,
      refreshImpl: async () => {
        throw new Error('network down');
      },
    });
    const result = await refreshEnterpriseJwtIfDue(deps);
    expect(result.status).toBe('refresh-failed');
    expect(deps.persistSession).not.toHaveBeenCalled();
    expect(deps.applyConfig).not.toHaveBeenCalled();
  });

  test('is single-flight: concurrent triggers share one refresh', async () => {
    let resolveRefresh: (value: { token: string }) => void = () => {};
    const refreshSpy = vi.fn(() => new Promise<{ token: string }>((resolve) => {
      resolveRefresh = resolve;
    }));
    const deps = makeDeps({
      session: { ...SESSION, jwt: makeJwt(nowSec + 8 * 60), expiresAt: now() + 8 * 60_000 },
      now,
      refreshWindowMs: 10 * 60 * 1000,
      refreshImpl: refreshSpy,
    });
    const first = refreshEnterpriseJwtIfDue(deps);
    const second = refreshEnterpriseJwtIfDue(deps); // before the first settles
    expect(second).toBe(first); // same promise object → shared in-flight
    resolveRefresh({ token: makeJwt(nowSec + 3600) });
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe('refreshed');
    expect(b.status).toBe('refreshed');
    expect(refreshSpy).toHaveBeenCalledOnce(); // only one network call
  });
});
