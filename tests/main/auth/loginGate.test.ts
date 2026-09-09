import { describe, expect, test, vi, beforeEach } from 'vitest';

vi.mock('../../../src/main/auth/sessionStorage', () => ({
  sessionStorage: {
    save: vi.fn(),
    load: vi.fn(),
    clear: vi.fn(),
  },
}));

import { loginGate } from '../../../src/main/auth/loginGate';
import { sessionStorage } from '../../../src/main/auth/sessionStorage';

describe('main/auth/loginGate', () => {
  beforeEach(() => {
    loginGate.lock();
    vi.mocked(sessionStorage.save).mockReset();
  });

  test('未登录拦截', () => {
    loginGate.lock();
    expect(() => loginGate.requireEnterprise()).toThrow(/not logged in/i);
  });

  test('unlock 后放行', () => {
    loginGate.unlock({
      userId: 'u1',
      orgId: 'o1',
      username: 'a',
      displayName: 'A',
      roles: ['user'],
      jwt: 'j',
      expiresAt: 0,
    });
    expect(() => loginGate.requireEnterprise()).not.toThrow();
    expect(loginGate.current()?.userId).toBe('u1');
  });

  test('lock 后 current 为 null', () => {
    loginGate.unlock({
      userId: 'u1',
      orgId: 'o1',
      username: 'a',
      displayName: 'A',
      roles: [],
      jwt: 'j',
      expiresAt: 0,
    });
    loginGate.lock();
    expect(loginGate.current()).toBeNull();
  });
});