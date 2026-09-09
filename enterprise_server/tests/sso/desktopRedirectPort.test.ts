// enterprise_server/tests/sso/desktopRedirectPort.test.ts
// Unit tests for the SSO_DESKTOP_REDIRECT_PORT resolver. The full
// HTTP surface (GET /auth/sso/redirect-port + the authorize handler's
// redirect_uri) is covered by tests/routes/sso.public.test.ts and
// tests/routes/sso.desktop.test.ts respectively; this file pins the
// helper's precedence and validation rules in isolation.
import { describe, expect, test } from 'vitest';

import {
  getDesktopRedirectPort,
  resolveDesktopRedirectPort,
  SSO_DESKTOP_REDIRECT_PORT_DEFAULT,
} from '../../src/sso/desktopRedirectPort';

describe('sso/desktopRedirectPort', () => {
  test('returns the env value when SSO_DESKTOP_REDIRECT_PORT is a valid port', () => {
    const r = resolveDesktopRedirectPort({ SSO_DESKTOP_REDIRECT_PORT: '60000' } as NodeJS.ProcessEnv);
    expect(r).toEqual({ port: 60000, fromEnv: true });
  });

  test('returns port=null when SSO_DESKTOP_REDIRECT_PORT is unset (caller decides default)', () => {
    const r = resolveDesktopRedirectPort({} as NodeJS.ProcessEnv);
    expect(r).toEqual({ port: null, fromEnv: false });
  });

  test('non-integer env value is rejected', () => {
    const r = resolveDesktopRedirectPort({ SSO_DESKTOP_REDIRECT_PORT: 'not-a-port' } as NodeJS.ProcessEnv);
    expect(r).toEqual({ port: null, fromEnv: false });
  });

  test('out-of-range env value (>65535) is rejected', () => {
    const r = resolveDesktopRedirectPort({ SSO_DESKTOP_REDIRECT_PORT: '99999' } as NodeJS.ProcessEnv);
    expect(r).toEqual({ port: null, fromEnv: false });
  });

  test('out-of-range env value (0) is rejected', () => {
    const r = resolveDesktopRedirectPort({ SSO_DESKTOP_REDIRECT_PORT: '0' } as NodeJS.ProcessEnv);
    expect(r).toEqual({ port: null, fromEnv: false });
  });

  test('empty-string env value is treated as unset', () => {
    const r = resolveDesktopRedirectPort({ SSO_DESKTOP_REDIRECT_PORT: '' } as NodeJS.ProcessEnv);
    expect(r).toEqual({ port: null, fromEnv: false });
  });

  test('surrounding whitespace does not break parsing', () => {
    // A line like "SSO_DESKTOP_REDIRECT_PORT= 60000 " is rare but the
    // resolver must not silently break on it (Node's --env-file
    // trims, but a shell export may not).
    const r = resolveDesktopRedirectPort({ SSO_DESKTOP_REDIRECT_PORT: ' 60000 ' } as NodeJS.ProcessEnv);
    expect(r).toEqual({ port: 60000, fromEnv: true });
  });

  test('getDesktopRedirectPort returns the env value when valid', () => {
    expect(getDesktopRedirectPort({ SSO_DESKTOP_REDIRECT_PORT: '60000' } as NodeJS.ProcessEnv)).toBe(60000);
  });

  test('getDesktopRedirectPort returns the default when env is unset/invalid', () => {
    expect(getDesktopRedirectPort({} as NodeJS.ProcessEnv)).toBe(SSO_DESKTOP_REDIRECT_PORT_DEFAULT);
    expect(getDesktopRedirectPort({ SSO_DESKTOP_REDIRECT_PORT: 'garbage' } as NodeJS.ProcessEnv)).toBe(SSO_DESKTOP_REDIRECT_PORT_DEFAULT);
    expect(getDesktopRedirectPort({ SSO_DESKTOP_REDIRECT_PORT: '99999' } as NodeJS.ProcessEnv)).toBe(SSO_DESKTOP_REDIRECT_PORT_DEFAULT);
  });

  test('default is 53231 (matches the desktop build-time default)', () => {
    expect(SSO_DESKTOP_REDIRECT_PORT_DEFAULT).toBe(53231);
  });
});
