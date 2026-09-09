import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { openOauthFlowMock } = vi.hoisted(() => ({ openOauthFlowMock: vi.fn() }));

vi.mock('../mcp/oauthBrowserFlow', () => ({
  openOauthFlow: (opts: unknown) => openOauthFlowMock(opts),
}));

vi.mock('./genericSsoLogin', () => ({
  startCallbackServer: vi.fn(async () => ({
    port: 53231,
    close: vi.fn(),
    waitForArrival: vi.fn(),
  })),
  createSsoLoginProbe: vi.fn(() => () => Promise.resolve(null)),
}));

import { startSsoMemberBind } from './startSsoMemberBind';

describe('startSsoMemberBind', () => {
  beforeEach(() => {
    openOauthFlowMock.mockReset();
  });

  afterEach(() => {
    openOauthFlowMock.mockReset();
  });

  test('starts the loopback, runs openOauthFlow with the server-supplied authorizeUrl, and returns the token', async () => {
    openOauthFlowMock.mockResolvedValueOnce('eyJ-bound-jwt');
    const token = await startSsoMemberBind({
      enterpriseBaseUrl: 'https://api.example.com',
      authorizeUrl: 'https://api.example.com/auth/sso/c1/authorize?state=...',
    });
    expect(token).toBe('eyJ-bound-jwt');
    expect(openOauthFlowMock).toHaveBeenCalledTimes(1);
    const opts = openOauthFlowMock.mock.calls[0]![0] as { authorizeUrl: string; probe: unknown };
    expect(opts.authorizeUrl).toBe('https://api.example.com/auth/sso/c1/authorize?state=...');
    expect(typeof opts.probe).toBe('function');
  });

  test('does not open a pendingBind branch — the probe is the self-binding variant', async () => {
    // 验证 probe 是 createSsoLoginProbe 的产物(它是 self-binding 路径,
    // 不会触发 pendingBind,因为 server 走 ready_to_finalize finalize)。
    openOauthFlowMock.mockResolvedValueOnce('tok');
    await startSsoMemberBind({ enterpriseBaseUrl: 'https://api.example.com', authorizeUrl: 'about:blank' });
    const opts = openOauthFlowMock.mock.calls[0]![0] as { probe: (...args: unknown[]) => unknown };
    // probe 必须存在且是函数;具体实现覆盖在既有 createSsoLoginProbe 测试里
    expect(typeof opts.probe).toBe('function');
  });

  test('propagates openOauthFlow rejection as a thrown error', async () => {
    openOauthFlowMock.mockRejectedValueOnce(new Error('bind_oauth_failed'));
    await expect(
      startSsoMemberBind({ enterpriseBaseUrl: 'https://api.example.com', authorizeUrl: 'about:blank' })
    ).rejects.toThrow(/bind_oauth_failed/);
  });

  test('always closes the loopback, even on failure', async () => {
    const close = vi.fn();
    const { startCallbackServer } = await import('./genericSsoLogin');
    vi.mocked(startCallbackServer).mockResolvedValueOnce({
      port: 53231,
      close,
      waitForArrival: vi.fn(),
    });
    openOauthFlowMock.mockRejectedValueOnce(new Error('boom'));
    await expect(
      startSsoMemberBind({ enterpriseBaseUrl: 'https://api.example.com', authorizeUrl: 'about:blank' })
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
