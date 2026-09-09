import { beforeEach, describe, expect, test, vi } from 'vitest';

import { PRESETS } from '../../../enterprise_server/src/sso/providerPresets';

interface FailLoadArgs {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

interface MockWindow {
  webContents: {
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    emitDidFailLoad: (args: FailLoadArgs) => void;
    emitDidFinishLoad: () => void;
    loadURL: ReturnType<typeof vi.fn>;
  };
  on: (event: string, cb: () => void) => void;
  isDestroyed: () => boolean;
  close: () => void;
  loadURL: ReturnType<typeof vi.fn>;
  _opts?: unknown;
  _destroyed?: boolean;
  _closed?: boolean;
  _url?: string;
}

const lastWindows: MockWindow[] = [];

// Bookkeeping for the request filter tests. Each call to
// `partition.webRequest.onBeforeRequest(listener)` pushes the
// listener onto `webRequestListeners`; each settle-time call to
// `partition.webRequest.onBeforeRequest(null)` pops the most
// recently-registered listener. After every openOauthFlow settles,
// the live listener count must return to 0.
const webRequestListeners: Array<unknown> = [];
const onBeforeRequestCalls: Array<unknown> = [];
const onBeforeRedirectListeners: Array<unknown> = [];
const onBeforeRedirectCalls: Array<unknown> = [];
export const __testWebRequest = {
  listeners: webRequestListeners,
  onBeforeRequestCalls,
  redirectListeners: onBeforeRedirectListeners,
  onBeforeRedirectCalls,
  reset(): void {
    webRequestListeners.length = 0;
    onBeforeRequestCalls.length = 0;
    onBeforeRedirectListeners.length = 0;
    onBeforeRedirectCalls.length = 0;
  },
};

vi.mock('electron', () => {
  class MockBrowserWindow {
    public webContents: MockWindow['webContents'];
    public loadURL: MockWindow['loadURL'];
    public _destroyed = false;
    public _closed = false;
    public _opts: unknown;
    public _url: string | undefined;
    public _autoFinishLoad = true;
    private closedCallbacks: Array<() => void> = [];
    private didFinishLoadCallbacks: Array<() => void> = [];
    private didFailLoadCallbacks: Array<(args: FailLoadArgs) => void> = [];

    constructor(opts: unknown) {
      this._opts = opts;
      this.webContents = {
        on: (event: string, cb: (...args: unknown[]) => void) => {
          if (event === 'did-finish-load') {
            // By default, auto-fire did-finish-load asynchronously so
            // the existing tests still work. A test that wants to
            // exercise the loadURL deadline flips `autoFinishLoad`
            // on the mock instance before awaiting openOauthFlow.
            if (this._autoFinishLoad) {
              // Re-check the flag at fire time (microtasks drain at the
              // next await, so the test sets the flag right after scheduling
              // this microtask but before it drains).
              queueMicrotask(() => {
                if (this._autoFinishLoad) cb();
              });
            } else {
              this.didFinishLoadCallbacks.push(cb);
            }
          } else if (event === 'did-fail-load') {
            this.didFailLoadCallbacks.push(cb as (args: FailLoadArgs) => void);
          }
        },
        // Electron's did-fail-load is emitted with positional args:
        //   (event, errorCode, errorDescription, validatedURL, isMainFrame, frameProcessId, frameRoutingId)
        // Our test helper takes a single object for ergonomics and unpacks
        // it into the positional shape the listener expects.
        emitDidFailLoad: (args: FailLoadArgs) => {
          for (const cb of this.didFailLoadCallbacks) {
            cb(
              {} as unknown,  // event
              args.errorCode,
              args.errorDescription,
              args.validatedURL,
              args.isMainFrame,
            );
          }
        },
        emitDidFinishLoad: () => {
          for (const cb of this.didFinishLoadCallbacks) cb();
        },
        loadURL: vi.fn(async (url: string) => {
          this._url = url;
        }),
      };
      this.loadURL = this.webContents.loadURL;
      lastWindows.push(this as unknown as MockWindow);
    }

    on(event: string, cb: () => void) {
      if (event === 'closed') {
        this.closedCallbacks.push(cb);
      }
    }

    isDestroyed() {
      return this._destroyed;
    }

    close() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._closed = true;
      for (const cb of this.closedCallbacks) cb();
    }
  }

  const sessionMock = {
    fromPartition: vi.fn((_name: string) => ({
      webRequest: {
        onBeforeRequest: (listener: unknown) => {
          onBeforeRequestCalls.push(listener);
          if (listener === null) {
            // Production code calls `webRequest.onBeforeRequest(null)`
            // in settle() to deregister. Pop the most-recently
            // registered listener so the live count returns to 0.
            webRequestListeners.pop();
          } else {
            webRequestListeners.push(listener);
          }
        },
        onBeforeRedirect: (listener: unknown) => {
          onBeforeRedirectCalls.push(listener);
          if (listener === null) {
            onBeforeRedirectListeners.pop();
          } else {
            onBeforeRedirectListeners.push(listener);
          }
        },
      },
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    })),
  };

  return {
    BrowserWindow: MockBrowserWindow,
    session: sessionMock,
  };
});

// Import after vi.mock so the mock is in place.
import { deriveIdpAllowlist, openOauthFlow } from './oauthBrowserFlow';

describe('openOauthFlow', () => {
  beforeEach(() => {
    lastWindows.length = 0;
  });

  test('resolves with the credential when probe returns one', async () => {
    const result = await openOauthFlow({
      title: 'Test',
      authorizeUrl: 'https://example.com/auth',
      probe: async () => 'secret-token',
      pollIntervalMs: 10,
      timeoutMs: 1_000,
    });
    expect(result).toBe('secret-token');

    // The window was constructed with safe webPreferences.
    const win = lastWindows[0];
    const opts = win._opts as { webPreferences: { sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean; partition: string } };
    expect(opts.webPreferences.sandbox).toBe(true);
    expect(opts.webPreferences.contextIsolation).toBe(true);
    expect(opts.webPreferences.nodeIntegration).toBe(false);
    expect(opts.webPreferences.partition).toBe('genwork-sso-oauth');
    // The window was closed after settlement.
    expect(win._closed).toBe(true);
  });

  test('uses a stable partition name across two openOauthFlow calls (no per-attempt UUID)', async () => {
    // Two SSO attempts in the same session must share the same partition
    // — the per-attempt `oauth-${crypto.randomUUID()}` design is what
    // crashed the main process under load. Both BrowserWindows carry the
    // same named partition so Chromium reuses one network process.
    await openOauthFlow({
      title: 'First',
      authorizeUrl: 'https://example.com/a',
      probe: async () => 'token-1',
      pollIntervalMs: 10,
      timeoutMs: 1_000,
    });
    await openOauthFlow({
      title: 'Second',
      authorizeUrl: 'https://example.com/b',
      probe: async () => 'token-2',
      pollIntervalMs: 10,
      timeoutMs: 1_000,
    });
    const partitions = lastWindows.map(
      (w) => (w._opts as { webPreferences: { partition: string } }).webPreferences.partition
    );
    expect(partitions).toEqual(['genwork-sso-oauth', 'genwork-sso-oauth']);
  });

  test('rejects when timeout elapses with no credential', async () => {
    const p = openOauthFlow({
      title: 'Test Timeout',
      authorizeUrl: 'https://example.com/auth',
      probe: async () => null,
      pollIntervalMs: 10,
      timeoutMs: 50,
    });
    await expect(p).rejects.toThrow(/Test Timeout timed out\./);
  });

  test('rejects on a main-frame did-fail-load with a descriptive error', async () => {
    // The user's trace: `electron: Failed to load URL: <feishu authorize>
    // with error: ERR_INTERNET_DISCONNECTED`. Without a did-fail-load
    // handler, the auth window sits at the neterror page for 5
    // minutes (timeoutMs) before the user gets any signal. With the
    // handler, the flow rejects immediately with the Chromium
    // error code and description so the SSO login IPC can surface
    // it to the UI.
    const p = openOauthFlow({
      title: 'SSO sign-in',
      authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
      probe: async () => null,
      pollIntervalMs: 10,
      timeoutMs: 5_000,
    });
    // openOauthFlow is `async`, so its body runs on a microtask.
    // Wait for the BrowserWindow to be constructed and the
    // did-fail-load listener attached before firing the event.
    await new Promise((r) => queueMicrotask(r));
    // Fire did-fail-load with the same error code Chromium reports
    // for an offline network state. (ERR_INTERNET_DISCONNECTED == -106)
    lastWindows[0]!.webContents.emitDidFailLoad({
      errorCode: -106,
      errorDescription: 'ERR_INTERNET_DISCONNECTED',
      validatedURL: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
      isMainFrame: true,
    });
    await expect(p).rejects.toThrow(/SSO sign-in failed to load \(-106 ERR_INTERNET_DISCONNECTED\)/);
    // The window was closed as part of the rejection path.
    expect(lastWindows[0]!._closed).toBe(true);
  });

  test('ignores sub-frame did-fail-load (favicons, third-party scripts)', async () => {
    // Chromium fires did-fail-load for sub-frames too (e.g. an
    // embedded favicon 404). Only main-frame failures should
    // settle the flow; a sub-frame failure must not abort a
    // perfectly good authorize URL load.
    const p = openOauthFlow({
      title: 'SSO sign-in',
      authorizeUrl: 'https://example.com/auth',
      probe: vi.fn(async () => 'token-after-sub-frame-fail'),
      pollIntervalMs: 10,
      timeoutMs: 1_000,
    });
    // Wait for did-finish-load to fire (it's a microtask) so the
    // window is fully initialized, then emit a sub-frame failure.
    await new Promise((r) => queueMicrotask(r));
    lastWindows[0]!.webContents.emitDidFailLoad({
      errorCode: -106,
      errorDescription: 'ERR_INTERNET_DISCONNECTED',
      validatedURL: 'https://example.com/favicon.ico',
      isMainFrame: false,
    });
    // The flow should still resolve normally — the sub-frame
    // failure was filtered.
    await expect(p).resolves.toBe('token-after-sub-frame-fail');
  });

  test('ignores ERR_ABORTED did-fail-load (a newer load superseded this one)', async () => {
    // ERR_ABORTED (-3) fires when a navigation is interrupted by
    // a subsequent loadURL call (e.g. the user clicks a link that
    // navigates the window, or a refresh). The flow is still in
    // flight and a later did-finish-load will arrive — settling
    // here would falsely reject the user's still-valid attempt.
    const p = openOauthFlow({
      title: 'SSO sign-in',
      authorizeUrl: 'https://example.com/auth',
      probe: vi.fn(async () => 'token-after-abort'),
      pollIntervalMs: 10,
      timeoutMs: 1_000,
    });
    await new Promise((r) => queueMicrotask(r));
    lastWindows[0]!.webContents.emitDidFailLoad({
      errorCode: -3,
      errorDescription: 'ERR_ABORTED',
      validatedURL: 'https://example.com/auth',
      isMainFrame: true,
    });
    await expect(p).resolves.toBe('token-after-abort');
  });

  test('settles with sso_authorize_timeout when loadURL never finishes', async () => {
    // A Feishu authorize page that hangs (e.g. user force-closed the
    // window before the network process could complete TLS) must not
    // pin the main process against the 5-minute outer timeout. The new
    // 20 s loadURL deadline catches this case.
    vi.useFakeTimers();
    try {
      // Suppress the mock's auto did-finish-load so the deadline can fire.
      // The flag must be set SYNCHRONOUSLY (before any `await`), because
      // the mock's queueMicrotask-based auto-fire drains at the first
      // await point inside the test and we need the late-check inside
      // the mock to see the flag as false.
      const p = openOauthFlow({
        title: 'Feishu hung',
        authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/index',
        probe: vi.fn(async () => null),
        pollIntervalMs: 10,
        timeoutMs: 60_000,
        loadTimeoutMs: 5_000,
      }).catch((e) => e as Error);
      // Synchronously disable auto-fire on the just-created window
      // (before any await, so the late-check sees the flag).
      lastWindows[lastWindows.length - 1]!._autoFinishLoad = false;
      // Drain microtasks so the BrowserWindow's setup is observable.
      await new Promise((r) => queueMicrotask(r));
      // Advance past the loadURL deadline.
      await vi.advanceTimersByTimeAsync(5_500);
      const err = await p;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('sso_authorize_timeout');
      expect(lastWindows[lastWindows.length - 1]!._closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does NOT settle with sso_authorize_timeout when did-finish-load fires first', async () => {
    // Slow IdPs (Okta / Azure AD on first-time corporate-MFA enrollment)
    // can take 30+ s to render. The deadline is the *loadURL* step only;
    // once the page renders, the timer must be cleared and the outer
    // 5-minute timeout is the only bound.
    vi.useFakeTimers();
    try {
      const p = openOauthFlow({
        title: 'Slow Okta',
        authorizeUrl: 'https://example.okta.com/oauth2/v1/authorize',
        probe: vi.fn(async () => 'slow-token'),
        pollIntervalMs: 10,
        timeoutMs: 60_000,
        loadTimeoutMs: 1_000,
      });
      await new Promise((r) => queueMicrotask(r));
      // Suppress auto-finish, then manually fire it after 1.5s (past the
      // 1 s loadTimeoutMs but well before the 60 s outer timeout).
      lastWindows[lastWindows.length - 1]!._autoFinishLoad = false;
      await vi.advanceTimersByTimeAsync(1_500);
      lastWindows[lastWindows.length - 1]!.webContents.emitDidFinishLoad();
      // Advance well past where the deadline would have fired.
      await vi.advanceTimersByTimeAsync(10_000);
      // The flow resolves with the probe's credential, NOT with the
      // timeout error.
      const result = await p;
      expect(result).toBe('slow-token');
    } finally {
      vi.useRealTimers();
    }
  });

  test('settle guard prevents double-settle when did-fail-load and the deadline fire together', async () => {
    // If did-fail-load and the loadURL deadline both fire in the same
    // tick, the flow must settle exactly once. Without the `if (settled)
    // return` guard, the second call would be a no-op (the promise is
    // already settled), but the test pins the behavior so a future
    // refactor cannot silently re-introduce double-rejection.
    vi.useFakeTimers();
    try {
      const settleSpy = vi.fn();
      const p = openOauthFlow({
        title: 'Race',
        authorizeUrl: 'https://example.com/auth',
        probe: vi.fn(async () => null),
        pollIntervalMs: 10,
        timeoutMs: 60_000,
        loadTimeoutMs: 1_000,
      });
      p.catch(settleSpy);
      await new Promise((r) => queueMicrotask(r));
      const win = lastWindows[lastWindows.length - 1]!;
      win._autoFinishLoad = false;
      // Fire did-fail-load (transport error) and advance past the deadline
      // in the same tick. The mock's did-fail-load handler synchronously
      // settles, so the deadline's later fire is a no-op.
      win.webContents.emitDidFailLoad({
        errorCode: -106,
        errorDescription: 'ERR_INTERNET_DISCONNECTED',
        validatedURL: 'https://example.com/auth',
        isMainFrame: true,
      });
      await vi.advanceTimersByTimeAsync(1_500);
      // The flow rejected exactly once, with the did-fail-load error
      // (not sso_authorize_timeout — that path was correctly skipped).
      expect(settleSpy).toHaveBeenCalledTimes(1);
      expect((settleSpy.mock.calls[0]![0] as Error).message).toMatch(
        /Race failed to load \(-106 ERR_INTERNET_DISCONNECTED\)/
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('webRequest listener cancels requests to *.doubleclick.net (third-party tracking)', async () => {
    __testWebRequest.reset();
    const p = openOauthFlow({
      title: 'Feishu',
      authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/index',
      probe: vi.fn(async () => null),  // never resolves; keeps the flow open
      pollIntervalMs: 100_000,          // disable polling
      timeoutMs: 100_000,               // disable outer timeout
      loadTimeoutMs: 100_000,           // disable loadURL deadline
    });
    // Wait for the BrowserWindow to be constructed and the listener
    // installed. The install happens synchronously inside the
    // executor, so a microtask drain is enough.
    await new Promise((r) => queueMicrotask(r));
    expect(__testWebRequest.listeners).toHaveLength(1);
    const listener = __testWebRequest.listeners[0] as (
      details: { url?: string },
      callback: (response: { cancel: boolean }) => void
    ) => void;
    // Simulate Chromium firing a request to a tracking host.
    const cb = vi.fn();
    listener({ url: 'https://ad.doubleclick.net/ddm/activity' }, cb);
    // The listener canceled the request.
    expect(cb).toHaveBeenCalledWith({ cancel: true });
    // Now close the flow to release the listener (avoids leaking into
    // the next test).
    p.catch(() => undefined);
    lastWindows[lastWindows.length - 1]!.close();
    await p.catch(() => undefined);
  });

  test('webRequest listener allows requests to accounts.feishu.cn (IdP-owned)', async () => {
    __testWebRequest.reset();
    const p = openOauthFlow({
      title: 'Feishu',
      authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/index',
      probe: vi.fn(async () => null),
      pollIntervalMs: 100_000,
      timeoutMs: 100_000,
      loadTimeoutMs: 100_000,
    });
    await new Promise((r) => queueMicrotask(r));
    const listener = __testWebRequest.listeners[0] as (
      details: { url?: string },
      callback: (response: { cancel: boolean }) => void
    ) => void;
    const cb = vi.fn();
    listener({ url: 'https://accounts.feishu.cn/page/login' }, cb);
    expect(cb).toHaveBeenCalledWith({ cancel: false });
    p.catch(() => undefined);
    lastWindows[lastWindows.length - 1]!.close();
    await p.catch(() => undefined);
  });

  // Regression: 2026-10-14 production log showed
  //   blocked non-IdP request to sf3-scmcdn-cn.feishucdn.com in SSO sign-in
  //   blocked non-IdP request to www.googletagmanager.com in SSO sign-in
  // The first is Feishu's own static-asset CDN — without it, the
  // authorize page sticks on its loading illustration because its JS
  // bundle never arrives. The second is Google Analytics and must
  // STAY blocked. The per-IdP `resourceEtld1s` table distinguishes
  // IdP infrastructure from third-party tracking.
  test('webRequest listener allows Feishu CDN subdomains (feishucdn.com) and still blocks third-party tracking (regression)', async () => {
    __testWebRequest.reset();
    const p = openOauthFlow({
      title: 'SSO sign-in',
      authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/index',
      probe: vi.fn(async () => null),
      pollIntervalMs: 100_000,
      timeoutMs: 100_000,
      loadTimeoutMs: 100_000,
    });
    await new Promise((r) => queueMicrotask(r));
    const listener = __testWebRequest.listeners[0] as (
      details: { url?: string },
      callback: (response: { cancel: boolean }) => void
    ) => void;
    // Feishu's own static CDN — allowed.
    const cb1 = vi.fn();
    listener({ url: 'https://sf3-scmcdn-cn.feishucdn.com/static/foo.js' }, cb1);
    expect(cb1).toHaveBeenCalledWith({ cancel: false });
    // Another Feishu CDN host shape — also allowed.
    const cb2 = vi.fn();
    listener({ url: 'https://static-exp.feishucdn.com/asset/main.css' }, cb2);
    expect(cb2).toHaveBeenCalledWith({ cancel: false });
    // Google Analytics — still blocked (third-party tracking).
    const cb3 = vi.fn();
    listener({ url: 'https://www.googletagmanager.com/gtag/js?id=GA-XYZ' }, cb3);
    expect(cb3).toHaveBeenCalledWith({ cancel: true });
    // DoubleClick — still blocked.
    const cb4 = vi.fn();
    listener({ url: 'https://ad.doubleclick.net/ddm/activity' }, cb4);
    expect(cb4).toHaveBeenCalledWith({ cancel: true });
    p.catch(() => undefined);
    lastWindows[lastWindows.length - 1]!.close();
    await p.catch(() => undefined);
  });

  // Regression: runtime 2026-10-14 log showed
  //   [OAuthFlow] blocked non-IdP request to accounts.feishu.cn in SSO sign-in
  //   "SSO sign-in" failed to load https://accounts.feishu.cn/open-apis/authen/v1/authorize?...
  // The authorize URL is itself under accounts.feishu.cn (not just a
  // sub-resource) — the listener must allow the main-frame navigation,
  // not just a sub-frame asset.
  test('webRequest listener allows the main-frame authorize URL on accounts.feishu.cn (regression)', async () => {
    __testWebRequest.reset();
    const p = openOauthFlow({
      title: 'SSO sign-in',
      authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?app_id=1&redirect_uri=http%3A%2F%2Flocalhost%3A5175%2Fcb&state=xyz',
      probe: vi.fn(async () => null),
      pollIntervalMs: 100_000,
      timeoutMs: 100_000,
      loadTimeoutMs: 100_000,
    });
    await new Promise((r) => queueMicrotask(r));
    const listener = __testWebRequest.listeners[0] as (
      details: { url?: string },
      callback: (response: { cancel: boolean }) => void
    ) => void;
    const cb = vi.fn();
    listener(
      {
        url: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?app_id=1&redirect_uri=http%3A%2F%2Flocalhost%3A5175%2Fcb&state=xyz',
      },
      cb
    );
    expect(cb).toHaveBeenCalledWith({ cancel: false });
    p.catch(() => undefined);
    lastWindows[lastWindows.length - 1]!.close();
    await p.catch(() => undefined);
  });

  // Regression: 2026-10-14 production log showed
  //   filter installed for "SSO sign-in" etld1="0.1" ... authorizeHost=127.0.0.1
  //   blocked non-IdP request to accounts.feishu.cn in SSO sign-in (etld1="0.1")
  // Root cause: the desktop SSO flow's `authorizeUrl` is the enterprise
  // server (`https://api.example/auth/sso/.../authorize` or
  // `http://127.0.0.1:53231/...` in dev), which 302s to the real IdP.
  // The listener's allowlist was derived from the initial URL only.
  // The onBeforeRedirect listener must observe the 302 and grow the
  // allowlist to include the IdP's eTLD+1 before the redirect is
  // followed.
  test('webRequest listener allows redirected IdP host when initial authorizeUrl is the enterprise server (regression)', async () => {
    __testWebRequest.reset();
    const p = openOauthFlow({
      title: 'SSO sign-in',
      // In dev, buildAuthorizeUrl points at the local enterprise
      // server on 127.0.0.1; in prod, at the api.* domain. Either
      // way, the host is NOT the IdP — the IdP is only reached
      // after a 302.
      authorizeUrl: 'http://127.0.0.1:53231/auth/sso/feishu/authorize?orgName=acme',
      probe: vi.fn(async () => null),
      pollIntervalMs: 100_000,
      timeoutMs: 100_000,
      loadTimeoutMs: 100_000,
    });
    await new Promise((r) => queueMicrotask(r));
    const redirectListener = __testWebRequest.redirectListeners[0] as (
      details: { url?: string; statusCode?: number; redirectURL?: string }
    ) => void;
    const requestListener = __testWebRequest.listeners[0] as (
      details: { url?: string },
      callback: (response: { cancel: boolean }) => void
    ) => void;

    // Step 1: server responds 302 with Location pointing at the IdP.
    // onBeforeRedirect is a notification, not a request/response
    // pair — it has no callback, just observes the redirect.
    redirectListener({
      url: 'http://127.0.0.1:53231/auth/sso/feishu/authorize?orgName=acme',
      statusCode: 302,
      redirectURL: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?...',
    });

    // Step 2: the BrowserWindow follows the redirect; the request
    // listener sees the IdP host. It must be allowed.
    const cb2 = vi.fn();
    requestListener(
      { url: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?...' },
      cb2
    );
    expect(cb2).toHaveBeenCalledWith({ cancel: false });

    // Step 3: the IdP page's static-asset CDN must also be allowed
    // after the redirect, even though it wasn't in the initial
    // allowlist (the initial URL was the enterprise server, not
    // Feishu). The redirect-grow step merges `resourceEtld1s` from
    // the IdP's table entry.
    const cb3 = vi.fn();
    requestListener(
      { url: 'https://sf3-scmcdn-cn.feishucdn.com/static/main.js' },
      cb3
    );
    expect(cb3).toHaveBeenCalledWith({ cancel: false });

    p.catch(() => undefined);
    lastWindows[lastWindows.length - 1]!.close();
    await p.catch(() => undefined);
  });

  test('webRequest listener allows loopback callbacks (localhost + 127.0.0.1)', async () => {
    __testWebRequest.reset();
    const p = openOauthFlow({
      title: 'Feishu',
      authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/index',
      probe: vi.fn(async () => null),
      pollIntervalMs: 100_000,
      timeoutMs: 100_000,
      loadTimeoutMs: 100_000,
    });
    await new Promise((r) => queueMicrotask(r));
    const listener = __testWebRequest.listeners[0] as (
      details: { url?: string },
      callback: (response: { cancel: boolean }) => void
    ) => void;
    const cb = vi.fn();
    listener({ url: 'http://localhost:5175/callback?code=abc' }, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: false });
    listener({ url: 'http://127.0.0.1:5175/callback?code=abc' }, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: false });
    p.catch(() => undefined);
    lastWindows[lastWindows.length - 1]!.close();
    await p.catch(() => undefined);
  });

  test('webRequest listener does not block non-http schemes (devtools://, chrome-extension://)', async () => {
    __testWebRequest.reset();
    const p = openOauthFlow({
      title: 'Feishu',
      authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/index',
      probe: vi.fn(async () => null),
      pollIntervalMs: 100_000,
      timeoutMs: 100_000,
      loadTimeoutMs: 100_000,
    });
    await new Promise((r) => queueMicrotask(r));
    const listener = __testWebRequest.listeners[0] as (
      details: { url?: string },
      callback: (response: { cancel: boolean }) => void
    ) => void;
    const cb = vi.fn();
    listener({ url: 'devtools://devtools/bundled/inspector.html' }, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: false });
    listener({ url: 'chrome-extension://abcdefghijklmnop/index.html' }, cb);
    expect(cb).toHaveBeenLastCalledWith({ cancel: false });
    p.catch(() => undefined);
    lastWindows[lastWindows.length - 1]!.close();
    await p.catch(() => undefined);
  });

  test('webRequest listener is removed on settle (no listener leak across calls)', async () => {
    __testWebRequest.reset();
    // 5 successive openOauthFlow calls, each resolves with a token
    // (the existing fast-path: probe returns immediately).
    for (let i = 0; i < 5; i++) {
      await openOauthFlow({
        title: 'Feishu',
        authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/index',
        probe: async () => 'token',
        pollIntervalMs: 10,
        timeoutMs: 1_000,
      });
    }
    // Each call installed exactly one listener; each settle removed it.
    // After all 5 calls, the live listener list must be empty.
    expect(__testWebRequest.listeners).toHaveLength(0);
    // And 10 onBeforeRequest calls total: 5 registrations + 5 deregistrations.
    expect(__testWebRequest.onBeforeRequestCalls).toHaveLength(10);
  });
});

describe('deriveIdpAllowlist', () => {
  test('Feishu preset authorizes open.feishu.cn under feishu.cn', () => {
    const r = deriveIdpAllowlist('https://open.feishu.cn/open-apis/authen/v1/index');
    expect(r.etld1).toBe('feishu.cn');
    // subdomains under feishu.cn must be allowed
    expect(r.allowHosts).toEqual(
      expect.arrayContaining(['feishu.cn', 'open.feishu.cn', 'accounts.feishu.cn']),
    );
    // Feishu's static-asset CDN must be in the resource eTLD+1 list
    // so the authorize page can actually render its JS bundle.
    expect(r.resourceEtld1s).toEqual(
      expect.arrayContaining(['feishucdn.com']),
    );
  });

  test('Azure AD preset authorizes login.microsoftonline.com under microsoftonline.com', () => {
    const r = deriveIdpAllowlist(
      'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize'
    );
    expect(r.etld1).toBe('microsoftonline.com');
  });

  test('DingTalk preset authorizes oapi.dingtalk.com under dingtalk.com', () => {
    const r = deriveIdpAllowlist('https://oapi.dingtalk.com/connect/oauth2/sns_authorize');
    expect(r.etld1).toBe('dingtalk.com');
  });

  test('WeCom preset authorizes open.weixin.qq.com under weixin.qq.com', () => {
    const r = deriveIdpAllowlist('https://open.weixin.qq.com/connect/oauth2/authorize');
    expect(r.etld1).toBe('weixin.qq.com');
  });

  test('Okta preset authorizes example.okta.com under okta.com', () => {
    const r = deriveIdpAllowlist('https://example.okta.com/oauth2/v1/authorize');
    expect(r.etld1).toBe('okta.com');
  });

  test('strips www. leftmost label (www.feishu.cn -> feishu.cn)', () => {
    const r = deriveIdpAllowlist('https://www.feishu.cn/auth');
    expect(r.etld1).toBe('feishu.cn');
  });

  test('custom OIDC falls back to last two labels', () => {
    const r = deriveIdpAllowlist('https://sso.acme.example.com/authorize');
    expect(r.etld1).toBe('example.com');
  });

  test('malformed URL returns a safe allowlist (only localhost + 127.0.0.1)', () => {
    const r = deriveIdpAllowlist('not-a-url');
    expect(r.allowHosts).toEqual(['localhost', '127.0.0.1']);
    expect(r.resourceEtld1s).toEqual([]);
  });
});

describe('Feishu preset is fully under feishu.cn', () => {
  test('all 3 Feishu URLs derive to feishu.cn', () => {
    const feishu = PRESETS.feishu!;
    expect(deriveIdpAllowlist(feishu.authorizeUrl).etld1).toBe('feishu.cn');
    expect(deriveIdpAllowlist(feishu.tokenUrl).etld1).toBe('feishu.cn');
    expect(deriveIdpAllowlist(feishu.userinfoUrl).etld1).toBe('feishu.cn');
  });
});
