import http from 'node:http';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { openExternalMock } = vi.hoisted(() => ({ openExternalMock: vi.fn(async () => undefined) }));

vi.mock('electron', () => ({
  // The minimal BrowserWindow stub is enough for the startCallbackServer
  // and unit tests of createSsoLoginProbe; neither path actually
  // instantiates a BrowserWindow.
  BrowserWindow: class {
    isDestroyed() {
      return true;
    }
  },
  shell: { openExternal: (url: string) => openExternalMock(url) },
}));

import { buildAuthorizeUrl, fetchDesktopRedirectPort, startCallbackServer } from './genericSsoLogin';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  openExternalMock.mockReset();
  openExternalMock.mockResolvedValue(undefined);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** HTTP GET that does NOT depend on the global `fetch` the rest of
 *  the suite replaces with a vi.fn(). Uses node:http so it works no
 *  matter what the test setup has stubbed onto globalThis. */
function httpGet(url: string): Promise<{ status: number; body: string; location: string | null }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf-8'),
        location: (res.headers['location'] as string | undefined) ?? null,
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

describe('buildAuthorizeUrl', () => {
  test('embeds orgName + connectionId + desktop_port', () => {
    const u = new URL(buildAuthorizeUrl({
      enterpriseBaseUrl: 'https://api.example.com', orgName: 'Acme', connectionId: 'c1', desktopPort: 53231,
    }));
    expect(u.pathname).toBe('/auth/sso/c1/authorize');
    expect(u.searchParams.get('orgName')).toBe('Acme');
    expect(u.searchParams.get('return')).toBe('desktop');
    // The desktop_port is FIXED (not random) so the IdP-registered
    // redirect_uri matches across every login attempt. 53231 is the
    // server-side default; the desktop reads the configured value from
    // the server via GET /auth/sso/redirect-port.
    expect(u.searchParams.get('desktop_port')).toBe('53231');
  });
});

describe('fetchDesktopRedirectPort', () => {
  test('returns the port from the server endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ port: 61234 }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const port = await fetchDesktopRedirectPort('https://api.example.com');
    expect(port).toBe(61234);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/auth/sso/redirect-port',
      expect.objectContaining({ method: 'GET' })
    );
  });

  test('falls back to default when the server returns a non-2xx status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream down', { status: 502 }));
    const port = await fetchDesktopRedirectPort('https://api.example.com');
    expect(port).toBe(53231);
  });

  test('falls back to default when the body is not a valid port', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ port: 99999 }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const port = await fetchDesktopRedirectPort('https://api.example.com');
    expect(port).toBe(53231);
  });

  test('falls back to default when fetch throws (server unreachable)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const port = await fetchDesktopRedirectPort('https://api.example.com');
    expect(port).toBe(53231);
  });

  test('the endpoint URL is anchored to enterpriseBaseUrl + /auth/sso/redirect-port', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ port: 53231 }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    await fetchDesktopRedirectPort('https://api.example.com/');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.com/auth/sso/redirect-port');
  });
});

describe('startCallbackServer', () => {
  // Pin an unused loopback port per test. 0 lets the OS pick, and the
  // returned cb.port reflects the bound port (useful when running
  // these tests in parallel on a shared dev machine).
  let cb: Awaited<ReturnType<typeof startCallbackServer>> | null = null;

  afterEach(() => {
    cb?.close();
    cb = null;
  });

  test('serves a 1:1 redesigned bind success page: brand row, green check, primary close button, safe-pill footer', async () => {
    cb = await startCallbackServer(0);
    const { status, body } = await httpGet(`http://127.0.0.1:${cb.port}/callback?token=eyJabc`);
    expect(status).toBe(200);
    // The post-bind success page mirrors the server's bind-sso design:
    // provider letter tile + G tile, light green check, "登录成功" heading,
    // a primary "关闭本页面,打开GenWork" button, and a light green
    // "safe to close" pill. The page is shown in the OS browser the
    // user used to bind; clicking the button fires the genwork://
    // deep link, which the OS routes through its own
    // "Open this application?" prompt. We deliberately do NOT add a
    // second in-page confirm — the OS prompt is the confirm surface,
    // and asking twice forces an extra click on a flow the user just
    // finished authorizing.
    expect(body).toMatch(/登录成功/);
    expect(body).toMatch(/关闭本页面,打开GenWork/);
    expect(body).toMatch(/绑定已完成,本页面可安全关闭/);
    // The deep link fires from the single primary button. The
    // keyboard hint is present (hidden until close is rejected).
    expect(body).toMatch(/genwork:\/\//);
    expect(body).toMatch(/window\.close/);
    expect(body).toMatch(/close-hint/);
    expect(body).toMatch(/⌘W/);
    expect(body).toMatch(/Ctrl\+W/);
    // The about:blank new-tab trick is gone — opening a new tab to
    // close it is jank and the user explicitly objected to it.
    expect(body).not.toMatch(/window\.open\(['"]about:blank['"]/);
    // There is NO in-page confirm panel — the OS prompt is the
    // single confirm surface. (We assert the negative so a future
    // regression that re-adds a second prompt fails this test.)
    expect(body).not.toMatch(/confirm-panel/);
    expect(body).not.toMatch(/id="confirm-open"/);
    expect(body).not.toMatch(/id="confirm-cancel"/);
  });

  test('resolves waitForArrival with the token query param', async () => {
    cb = await startCallbackServer(0);
    const arrived = cb.waitForArrival();
    const { status } = await httpGet(`http://127.0.0.1:${cb.port}/callback?token=eyJ-fake-jwt`);
    expect(status).toBe(200);
    const r = await arrived;
    expect(r).toEqual({ kind: 'token', token: 'eyJ-fake-jwt' });
  });

  test('resolves waitForArrival with the error query param on IdP error', async () => {
    cb = await startCallbackServer(0);
    const arrived = cb.waitForArrival();
    await httpGet(`http://127.0.0.1:${cb.port}/callback?error=access_denied`);
    const r = await arrived;
    expect(r).toEqual({ kind: 'error', error: 'access_denied' });
  });

  test('non-/callback paths return 404 without resolving waitForArrival', async () => {
    cb = await startCallbackServer(0);
    // Race a short timeout against waitForArrival: if the server ever
    // resolves for a non-/callback path, this rejects and the test
    // fails. Otherwise we only assert the 404 status.
    const settleRace = Promise.race([
      cb.waitForArrival().then((v) => ({ settled: v } as const)),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 100)),
    ]);
    const { status } = await httpGet(`http://127.0.0.1:${cb.port}/some-other-path`);
    expect(status).toBe(404);
    const outcome = await settleRace;
    expect(outcome).toBe('timeout');
  });

  test('waitForArrival: each settlement is delivered exactly once; the second call after a consumed settlement waits for the next one', async () => {
    // The earlier "shared promise" design delivered the same
    // settlement to every caller (idempotent). That was fine for
    // the single-stage flow but froze the two-stage (pendingBind →
    // token) probe: the second probe poll would receive the
    // pendingBind value (already resolved on the shared promise)
    // and never pick up the post-bind token, so the desktop stayed
    // on "正在打开浏览器…" while the browser was stuck on
    // "登录成功,正在返回桌面…".
    //
    // The new contract: each settlement is consumed by exactly one
    // caller. The second caller (after the first one has read the
    // settlement) waits for the next settlement, NOT for the same
    // value. The two-stage test below covers the
    // settlement-replacement behavior end-to-end. This test pins
    // the one-shot delivery contract by asserting that the second
    // call does not re-resolve with the already-consumed value
    // (it would, under the old shared-promise design).
    cb = await startCallbackServer(0);
    const first = cb.waitForArrival();
    await httpGet(`http://127.0.0.1:${cb.port}/callback?token=eyJ-shared`);
    const a = await first;
    expect(a).toEqual({ kind: 'token', token: 'eyJ-shared' });
    // The second call is racing a settlement: the loopback will not
    // produce another one in this test, so the second waitForArrival
    // must stay pending (it must NOT resolve with `eyJ-shared`
    // again — that would be the old shared-promise behavior and
    // would re-freeze the two-stage flow).
    const secondRace = Promise.race([
      cb.waitForArrival().then((v) => ({ resolved: v } as const)),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 150)),
    ]);
    const outcome = await secondRace;
    expect(outcome).toBe('timeout');
  });

  test('legacy direct token path is untouched when enterpriseBaseUrl is null', async () => {
    // Existing callers (MCP auth flow) call startCallbackServer with
    // just a port. The legacy `?token=…` path must still work — no
    // POST to the server, just the redesigned success page that
    // resolves waitForArrival. The page is provider-agnostic when
    // no prior pendingBind was observed (MCP path), so the body
    // falls back to a generic "SSO 账号" message.
    cb = await startCallbackServer(0);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const arrived = cb.waitForArrival();
      const { status, body } = await httpGet(`http://127.0.0.1:${cb.port}/callback?token=eyJ-legacy`);
      expect(status).toBe(200);
      expect(body).toMatch(/登录成功/);
      expect(fetchSpy).not.toHaveBeenCalled();
      const r = await arrived;
      expect(r).toEqual({ kind: 'token', token: 'eyJ-legacy' });
    } finally {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }
  });

  test('bridge: loopback forwards ?code=…&state=… to server exchange, 302s self with token, settles probe', async () => {
    // The desktop's loopback gets the IdP's `?code=…&state=…`
    // redirect when PKCE is in play. Without the bridge the probe
    // hangs and the OAuth flow times out, surfacing as
    // `sso_login_failed` → eventually SIGSEGV. With the bridge the
    // loopback forwards the codes to the server's POST exchange
    // endpoint and 302s the browser to itself with `?token=…` so
    // the existing probe can settle. The server URL is per-call
    // (the deployment's enterprise base URL).
    const serverBaseUrl = 'http://localhost:9999';
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ token: 'eyJ-fake-jwt' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    cb = await startCallbackServer(0, serverBaseUrl);

    // First hop: IdP redirects the browser to the loopback with
    // `?code=…&state=…`. The loopback must POST to the server, then
    // 302 the browser to itself with `?token=…`.
    const first = await httpGet(`http://127.0.0.1:${cb.port}/callback?code=CODE123&state=S1`);
    expect(first.status).toBe(302);
    expect(first.location).toBe(`/callback?token=${encodeURIComponent('eyJ-fake-jwt')}`);

    // The loopback must have POSTed once to the new exchange endpoint.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0]!;
    const urlStr = String(firstCall[0]);
    expect(urlStr).toBe(`${serverBaseUrl}/auth/sso/desktop/exchange`);
    const init = firstCall[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ code: 'CODE123', state: 'S1' });

    // In a real browser the 302 would auto-follow to /callback?token=…
    // and the loopback's legacy path would settle the probe. To make
    // the test deterministic without spawning a follow-redirect chain,
    // we simulate the browser's second hop explicitly. The settled
    // value should match the JWT we mocked from the server.
    const probeRace = Promise.race([
      cb.waitForArrival().then((v) => ({ settled: v } as const)),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 250)),
    ]);
    const second = await httpGet(`http://127.0.0.1:${cb.port}/callback?token=${encodeURIComponent('eyJ-fake-jwt')}`);
    expect(second.status).toBe(200);
    const outcome = await probeRace;
    expect(outcome).toEqual({ settled: { kind: 'token', token: 'eyJ-fake-jwt' } });
  });

  test('bridge: loopback settles probe with kind:pendingBind and renders a friendly HTML page', async () => {
    // Spec §12 P1: a strict-mode unbound identity (the user is
    // hitting SSO for the first time on a Feishu connection that
    // requires admin pre-binding) cannot complete login from the
    // desktop alone — they must open the web /bind-sso page. The
    // server returns 409 with `{ status: 'pending_bind' }`; the
    // loopback surfaces an HTML page so the user sees a clear
    // explanation even if openExternal fails, AND settles the probe
    // with `kind: 'pendingBind'` so the desktop can hand the user
    // off to the OS browser. (Older versions of this test expected
    // the probe to NOT settle; that was correct under the
    // "open the friendly HTML and let the flow time out" model.
    // The new "open in OS browser and keep polling" model requires
    // the probe to receive the bindUrl so it can call shell.openExternal.)
    const serverBaseUrl = 'http://localhost:9998';
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({
        status: 'pending_bind', bindUrl: '/bind-sso?state=S1', connectionName: 'Feishu',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    ));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    cb = await startCallbackServer(0, serverBaseUrl);

    const arrived = cb.waitForArrival();

    const { status, body } = await httpGet(`http://127.0.0.1:${cb.port}/callback?code=CODE&state=S1`);
    expect(status).toBe(200);
    // Friendly HTML page; we match loosely across "binding" / "browser"
    // because exact wording may shift over time as long as the intent
    // ("open this in your browser to finish") survives.
    expect(body).toMatch(/binding|browser|浏览器/i);
    // The probe MUST have settled — the desktop relies on receiving
    // the bindUrl so it can call shell.openExternal and hand the
    // user off to the OS browser.
    const r = await arrived;
    expect(r).toEqual({ kind: 'pendingBind', bindUrl: '/bind-sso?state=S1', connectionName: 'Feishu' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('two-stage: pendingBind then token — a probe polling after the post-bind settlement picks up the token, not the cached pendingBind', async () => {
    // This is the exact bug: after the loopback settles pendingBind
    // (stage 1), the probe returns null to openOauthFlow and polls
    // again. The next waitForArrival, called AFTER the post-bind
    // token has been settled by the server's ready_to_finalize
    // redirect, must receive the token — not the cached pendingBind
    // and not the same one-shot promise that already resolved to
    // pendingBind.
    //
    // The earlier "shared promise" design froze here: the second
    // waitForArrival call returned the same already-resolved promise
    // and yielded pendingBind forever. The "cached and never cleared"
    // design also froze the second call on the cached pendingBind
    // value. The "cache and clear on read" design returns the new
    // token because the cache is empty by the time the second
    // settlement arrives.
    const serverBaseUrl = 'http://localhost:9996';
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({
        status: 'pending_bind', bindUrl: '/bind-sso?state=S1', connectionName: 'Feishu',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    ));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    cb = await startCallbackServer(0, serverBaseUrl);

    // Stage 1: IdP redirects the browser to the loopback with
    // ?code=…&state=…; the bridge POSTs to the exchange endpoint and
    // the server answers 409 pending_bind. The probe settles with
    // kind: pendingBind.
    const firstArrival = cb.waitForArrival();
    await httpGet(`http://127.0.0.1:${cb.port}/callback?code=CODE&state=S1`);
    const r1 = await firstArrival;
    expect(r1).toEqual({ kind: 'pendingBind', bindUrl: '/bind-sso?state=S1', connectionName: 'Feishu' });

    // The probe has read r1 and the cache is empty. The probe is
    // about to return null to openOauthFlow and on the next poll
    // call waitForArrival again. To prove the cache was cleared (and
    // that a new settlement overwrites it), simulate that next poll
    // arriving BEFORE the post-bind token, and then the token
    // arriving — the next waitForArrival must wait for and pick up
    // the new settlement, not the stale pendingBind.
    //
    // If we called waitForArrival() before the post-bind token
    // arrived, it would return a pending promise (cache is empty,
    // no resolver registered). That is the "blocking for the next
    // settlement" path. We use Promise.race to assert the call
    // neither resolves with the stale value nor hangs past 250ms.
    const secondArrival = cb.waitForArrival();
    const secondRace = Promise.race([
      secondArrival.then((v) => ({ settled: v } as const)),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 250)),
    ]);
    // The post-bind token arrives via the legacy `?token=…` path
    // after the user finishes binding in the OS browser.
    await httpGet(`http://127.0.0.1:${cb.port}/callback?token=${encodeURIComponent('eyJ-post-bind')}`);
    const outcome = await secondRace;
    expect(outcome).toEqual({ settled: { kind: 'token', token: 'eyJ-post-bind' } });
  });

  test('bridge: server 400 error surfaces as ?error= on the loopback', async () => {
    // Server returns `{ error: 'state_invalid' }` on a replayed
    // state. The loopback must propagate this as `?error=state_invalid`
    // so the desktop UI can show a clear "session expired" message.
    const serverBaseUrl = 'http://localhost:9997';
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ error: 'state_invalid' }),
      { status: 400, headers: { 'content-type': 'application/json' } })
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    cb = await startCallbackServer(0, serverBaseUrl);
    const arrived = cb.waitForArrival();

    const { status, body } = await httpGet(`http://127.0.0.1:${cb.port}/callback?code=BAD&state=ZZ`);
    // 302 self-redirect with the error encoded into the query string.
    expect(status).toBe(302);
    expect(body).toBe('');
    const r = await arrived;
    expect(r).toEqual({ kind: 'error', error: 'state_invalid' });
  });

  test('bind flow: post-bind ?token=… renders a provider-aware 1:1 success page', async () => {
    // The user reported the old "登录成功,正在返回桌面…" page was
    // ugly and didn't match the polished bind-sso design. The
    // post-bind `?token=…` (delivered when the server's
    // ready_to_finalize finalize redirects the browser back to the
    // loopback) now renders a redesigned success page that mirrors
    // the reference: provider letter tile → G tile, light green
    // check, "登录成功" heading, body with the provider name, primary
    // "关闭本页面" button, light green safe-to-close pill.
    //
    // The provider name comes from the lastBindContext the loopback
    // captured during the prior pendingBind settlement — the server
    // doesn't echo it on the `?token=…` redirect, so the loopback
    // has to remember it.
    const serverBaseUrl = 'http://localhost:9995';
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({
        status: 'pending_bind', bindUrl: '/bind-sso?state=S1', connectionName: '飞书', providerType: 'feishu',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    ));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    cb = await startCallbackServer(0, serverBaseUrl);

    // Stage 1: bridge POST returns 409 pending_bind; loopback
    // remembers the connection so the post-bind success page can
    // substitute the provider name into the body. waitForArrival
    // goes first to consume the pendingBind settlement.
    const firstArrival = cb.waitForArrival();
    await httpGet(`http://127.0.0.1:${cb.port}/callback?code=CODE&state=S1`);
    const r1 = await firstArrival;
    expect(r1).toMatchObject({ kind: 'pendingBind', connectionName: '飞书' });
    // Stage 2: post-bind finalize. The server's `?token=…` redirect
    // hits the loopback again; this is the page the user sees.
    // waitForArrival is called BEFORE the httpGet so it picks up
    // the token settlement (the cache is empty after stage 1's
    // one-shot read).
    const arrived = cb.waitForArrival();
    const { status, body } = await httpGet(`http://127.0.0.1:${cb.port}/callback?token=${encodeURIComponent('eyJ-post-bind')}`);
    expect(status).toBe(200);
    // 1:1 with the reference image.
    expect(body).toMatch(/登录成功/);
    // Provider name appears in the body copy at least once — the
    // success page substitutes it into the "已完成与 GenWork 的绑定"
    // sentence. After the copy update the trailing sentence is
    // "回到 GenWork 客户端继续使用" — the provider name appears once
    // (in the "已完成与 GenWork 的绑定" sentence) and the closing
    // sentence uses the literal product name "GenWork".
    expect(body).toMatch(/飞书 账号/);
    expect(body).toMatch(/回到 GenWork 客户端继续使用/);
    // Primary close button + light green safe-to-close pill.
    expect(body).toMatch(/关闭本页面,打开GenWork/);
    expect(body).toMatch(/绑定已完成,本页面可安全关闭/);
    // Light green check circle (matches the reference).
    expect(body).toMatch(/check-circle/);
    expect(body).toMatch(/#dcfce7/);  // light green background
    expect(body).toMatch(/#16a34a/);  // green check stroke
    // Provider letter tile (the desktop doesn't ship the per-provider
    // logo assets, so the success page uses a letter fallback — same
    // as the server's brand-fallback in ssoBind.ts:212).
    expect(body).toMatch(/brand-tile--provider[^>]*>[\s\S]*?<span>飞<\/span>/);
    // G tile for GenWork.
    expect(body).toMatch(/brand-tile--genwork[^>]*>[\s\S]*?<span>G<\/span>/);
    const r = await arrived;
    expect(r).toEqual({ kind: 'token', token: 'eyJ-post-bind' });
  });

  test('bind flow: post-bind ?error=… renders the redesigned error page (red check, provider-aware copy)', async () => {
    // Same shell as the success page, but the check circle is red
    // and the body explains the failure. The user lands here if the
    // server's ready_to_finalize finalize encountered a transport
    // error or the bind was rejected mid-flight.
    const serverBaseUrl = 'http://localhost:9994';
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({
        status: 'pending_bind', bindUrl: '/bind-sso?state=S1', connectionName: '飞书', providerType: 'feishu',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    ));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    cb = await startCallbackServer(0, serverBaseUrl);
    // Stage 1: establish the bind context so the error page can be
    // provider-aware. waitForArrival goes first (to consume the
    // pendingBind settlement), then the httpGet drives the bridge.
    const firstArrival = cb.waitForArrival();
    await httpGet(`http://127.0.0.1:${cb.port}/callback?code=CODE&state=S1`);
    const r1 = await firstArrival;
    expect(r1).toMatchObject({ kind: 'pendingBind' });
    // Stage 2: the post-bind finalize surfaces a transport error.
    // waitForArrival is called BEFORE the httpGet so it picks up
    // the error settlement (the cache is empty after stage 1's
    // one-shot read).
    const arrived = cb.waitForArrival();
    const { status, body } = await httpGet(`http://127.0.0.1:${cb.port}/callback?error=transport_error`);
    expect(status).toBe(200);
    expect(body).toMatch(/登录未完成/);
    expect(body).toMatch(/transport_error/);
    expect(body).toMatch(/飞书/);
    // Red check circle.
    expect(body).toMatch(/check-circle--error/);
    expect(body).toMatch(/#dc2626/);
    const r = await arrived;
    expect(r).toEqual({ kind: 'error', error: 'transport_error' });
  });

  test('bind success page: single primary button fires genwork:// + tries to close (no in-page confirm panel)', async () => {
    // The OS-level Chrome external-protocol prompt ("要打开 GenWork
    // 吗?") is the single confirm surface for the deep link. The
    // page itself just exposes one primary button: clicking it
    // fires the genwork:// deep link and tries window.close().
    // We deliberately do NOT add a second in-page confirm — the
    // OS prompt already covers the decision, and asking twice
    // forces an extra click on a surface the user just finished
    // authorizing.
    const serverBaseUrl = 'http://localhost:9992';
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({
        status: 'pending_bind', bindUrl: '/bind-sso?state=S1', connectionName: '飞书', providerType: 'feishu',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    ));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    cb = await startCallbackServer(0, serverBaseUrl);
    // Stage 1: drive the bridge so the loopback captures the
    // connection context.
    const firstArrival = cb.waitForArrival();
    await httpGet(`http://127.0.0.1:${cb.port}/callback?code=CODE&state=S1`);
    await firstArrival;
    // Stage 2: post-bind success page.
    const arrived = cb.waitForArrival();
    const { body } = await httpGet(`http://127.0.0.1:${cb.port}/callback?token=eyJ-confirm-test`);
    await arrived;

    // Single primary close button — the one and only click target.
    expect(body).toMatch(/id="close-btn"[^>]*>关闭本页面,打开GenWork</);
    // The page's click handler fires the genwork:// deep link and
    // tries window.close() on the same click. We slice the body
    // around the close-btn handler to assert the contract.
    function handlerBodyAfter(marker: string): string {
      const start = body.indexOf(marker);
      if (start < 0) return '';
      const openBrace = body.indexOf('{', start);
      let depth = 1;
      let i = openBrace + 1;
      while (i < body.length && depth > 0) {
        const ch = body[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        i += 1;
      }
      return body.slice(start, i);
    }
    const closeHandler = handlerBodyAfter("document.getElementById('close-btn')");
    // The handler fires the deep link AND tries to close on the
    // same click. window.close() is a W3C no-op for tabs not
    // opened by script; the close-hint is revealed as a fallback.
    expect(closeHandler).toMatch(/window\.location\.href\s*=\s*['"]genwork:\/\/['"]/);
    expect(closeHandler).toMatch(/window\.close/);
    expect(closeHandler).toMatch(/close-hint--visible/);
    // The page must NOT carry any in-page confirm panel — the OS
    // prompt is the confirm surface. (A regression that re-adds
    // the second prompt fails this test.)
    expect(body).not.toMatch(/confirm-panel/);
    expect(body).not.toMatch(/id="confirm-open"/);
    expect(body).not.toMatch(/id="confirm-cancel"/);
    // No about:blank new-tab trick.
    expect(body).not.toMatch(/about:blank/);
  });

  test('bind flow: HTML escapes hostile provider names (XSS hardening)', async () => {
    // The provider name comes from the server, which gets it from
    // the admin-configured sso_connections.name column. Admins
    // shouldn't put HTML in there, but defense-in-depth: any `& < > " '`
    // in the connection name must be HTML-escaped, not rendered as
    // a tag or attribute. The bindSuccessHtml renderer applies the
    // same escaper as the server's ssoBind.ts:145-147.
    const serverBaseUrl = 'http://localhost:9993';
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({
        status: 'pending_bind', bindUrl: '/bind-sso?state=S1',
        connectionName: '<img src=x onerror=alert(1)>&"\'', providerType: 'generic-oidc',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    ));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    cb = await startCallbackServer(0, serverBaseUrl);
    await httpGet(`http://127.0.0.1:${cb.port}/callback?code=CODE&state=S1`);
    const { body } = await httpGet(`http://127.0.0.1:${cb.port}/callback?token=eyJ-safe`);
    // The raw hostile substring must NOT appear unescaped.
    expect(body).not.toMatch(/<img src=x onerror=alert/);
    // The escaped form is present (the brand-tile letter shows the
    // first character of the connection name, which after escaping
    // is still `<`, rendered as `&lt;`).
    expect(body).toMatch(/&lt;/);
    expect(body).toMatch(/&amp;/);
    expect(body).toMatch(/&quot;/);
  });
});

describe('createSsoLoginProbe', () => {
  // The probe is the function that reacts to Arrival settlements
  // from the loopback. It is the surface that owns the two-stage
  // bind handoff (openExternal + close auth window + keep polling).
  // Driving the full openOauthFlow state machine would require
  // mocking Electron's BrowserWindow loadURL/did-finish-load/poll
  // cycle, which is brittle and slow. By extracting the probe into
  // a pure async function we can call it directly with a fake win
  // and assert its observable side effects in milliseconds.

  type Arrival = { kind: 'token' | 'error' | 'pendingBind'; token?: string; error?: string; bindUrl?: string; connectionName?: string };
  type FakeWin = { close: () => void; closed: boolean };
  type Cb = { waitForArrival: () => Promise<Arrival> };

  const makeWin = (): FakeWin => ({ close() { this.closed = true; }, closed: false });
  const makeCb = (settlement: Arrival): Cb => ({
    waitForArrival: () => new Promise<Arrival>((resolve) => {
      // Resolve on a microtask so the probe's `await` returns
      // predictably; the test sees the side effects after the
      // single tick.
      Promise.resolve().then(() => resolve(settlement));
    }),
  });

  test('token: returns the JWT to openOauthFlow', async () => {
    const { createSsoLoginProbe } = await import('./genericSsoLogin');
    const probe = createSsoLoginProbe({
      enterpriseBaseUrl: 'https://api.example.com',
      cb: makeCb({ kind: 'token', token: 'eyJ-fake' }),
    });
    const win = makeWin();
    const result = await probe(win as never, () => {});
    expect(result).toBe('eyJ-fake');
    expect(win.closed).toBe(false);  // token path leaves the window alone
  });

  test('error: closes the auth window so the flow rejects promptly', async () => {
    const { createSsoLoginProbe } = await import('./genericSsoLogin');
    const probe = createSsoLoginProbe({
      enterpriseBaseUrl: 'https://api.example.com',
      cb: makeCb({ kind: 'error', error: 'state_invalid' }),
    });
    const win = makeWin();
    const result = await probe(win as never, () => {});
    expect(result).toBeNull();
    expect(win.closed).toBe(true);  // error path closes the window
  });

  test('pendingBind: opens the bind URL in the OS browser via shell.openExternal with an absolute URL', async () => {
    const { createSsoLoginProbe } = await import('./genericSsoLogin');
    const probe = createSsoLoginProbe({
      enterpriseBaseUrl: 'https://api.example.com',
      cb: makeCb({
        kind: 'pendingBind',
        bindUrl: '/bind-sso?state=S1',
        connectionName: 'Feishu',
      }),
    });
    const win = makeWin();
    const result = await probe(win as never, () => {});
    // The probe does NOT return a token; it returns null so the
    // poll loop keeps calling probe. The next settlement is the
    // server's ready_to_finalize redirect with ?token=… which
    // resolves the flow.
    expect(result).toBeNull();
    // The IdP auth window STAYS OPEN on the pendingBind branch.
    // openOauthFlow's poll loop gates on
    // `if (!authWindow || authWindow.isDestroyed()) return;` — if we
    // closed the window here, the next poll would no-op and the
    // probe would never read the post-bind token settlement. The
    // window is closed by openOauthFlow's own success path when the
    // token does arrive. The "dangling taskbar window" worry is
    // addressed by the flow's outer settle closing it as part of
    // the resolve, and by openOauthFlow's timeoutMs backstop.
    expect(win.closed).toBe(false);
    // shell.openExternal was called with the ABSOLUTE bindUrl
    // (resolved against enterpriseBaseUrl), not the
    // server-relative /bind-sso?state=S1. The OS browser needs
    // a real http/https URL; a server-relative path would 404
    // in a fresh tab.
    expect(openExternalMock).toHaveBeenCalled();
    const calledUrl = openExternalMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://api.example.com/bind-sso?state=S1');
  });

  test('pendingBind: passes through an already-absolute bindUrl unchanged', async () => {
    // If the server ever returns an absolute bindUrl on a different
    // host (e.g. a future cross-domain bind-sso page), the desktop
    // must NOT prepend the enterprise base URL — the URL
    // constructor resolves absolute URLs against the base without
    // changing the origin.
    const { createSsoLoginProbe } = await import('./genericSsoLogin');
    const absoluteBindUrl = 'https://bind.other.example.com/bind-sso?state=S1';
    const probe = createSsoLoginProbe({
      enterpriseBaseUrl: 'https://api.example.com',
      cb: makeCb({
        kind: 'pendingBind',
        bindUrl: absoluteBindUrl,
        connectionName: 'Feishu',
      }),
    });
    const win = makeWin();
    await probe(win as never, () => {});
    expect(openExternalMock).toHaveBeenCalled();
    const calledUrl = openExternalMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe(absoluteBindUrl);
  });

  test('pendingBind: keeps the auth window open so the poll loop can read the post-bind token', async () => {
    // The earlier design called `markIntentionalClose` + `win.close()`
    // on the pendingBind branch, betting the loopback probe would
    // somehow keep polling anyway. It did not: openOauthFlow's
    // runProbe gates on `if (!authWindow || authWindow.isDestroyed())
    // return;` and stops calling the probe the moment the window is
    // gone. The probe never got a chance to read the post-bind
    // `kind: 'token'` settlement the server delivered once the user
    // finished binding in the OS browser. The desktop stayed on
    // "正在打开浏览器…" forever while the browser was stuck on
    // "登录成功,正在返回桌面…".
    //
    // The probe now leaves the window open, lets openOauthFlow's
    // existing poll keep calling the probe, and the next settlement
    // resolves the flow. The window closes as part of the flow's
    // success path; a real flow that never gets the token still
    // falls through to openOauthFlow's timeoutMs backstop.
    const { createSsoLoginProbe } = await import('./genericSsoLogin');
    const probe = createSsoLoginProbe({
      enterpriseBaseUrl: 'https://api.example.com',
      cb: makeCb({
        kind: 'pendingBind',
        bindUrl: '/bind-sso?state=S1',
        connectionName: 'Feishu',
      }),
    });
    const markIntentionalClose = vi.fn();
    const win = makeWin();
    await probe(win as never, markIntentionalClose);
    // Window is alive so the poll loop will keep firing the probe.
    expect(win.closed).toBe(false);
    // markIntentionalClose is unused on this branch now — the
    // window never gets closed by the probe. We assert it is NOT
    // called so a future regression that re-introduces the
    // close-the-window-on-pendingBind design fails this test
    // loudly rather than silently freezing the flow again.
    expect(markIntentionalClose).not.toHaveBeenCalled();
  });

  test('end-to-end two-stage: pendingBind → next probe receives the token → resolves', async () => {
    // The two-stage flow: first probe sees pendingBind, returns null.
    // The flow polls again. The second probe sees the token and
    // returns it, which resolves startSsoMemberLogin. We simulate
    // this by sequencing the waitForArrival to return pendingBind
    // first, then token. In the real openOauthFlow path both probes
    // operate on the same auth window (which is why the probe must
    // NOT close the window on pendingBind — see the prior test); the
    // fake here uses two windows because each probe call is invoked
    // directly.
    const { createSsoLoginProbe } = await import('./genericSsoLogin');
    let call = 0;
    const cb: Cb = {
      waitForArrival: () => new Promise<Arrival>((resolve) => {
        call += 1;
        if (call === 1) Promise.resolve().then(() => resolve({
          kind: 'pendingBind', bindUrl: '/bind-sso?state=S1', connectionName: 'Feishu',
        }));
        else Promise.resolve().then(() => resolve({ kind: 'token', token: 'eyJ-final' }));
      }),
    };
    const probe = createSsoLoginProbe({
      enterpriseBaseUrl: 'https://api.example.com',
      cb,
    });
    // First call: pendingBind → openExternal, return null. Window
    // stays open so the real poll loop can fire the probe again.
    const win1 = makeWin();
    const r1 = await probe(win1 as never, () => {});
    expect(r1).toBeNull();
    expect(win1.closed).toBe(false);
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    // Second call: token → return the JWT.
    const win2 = makeWin();
    const r2 = await probe(win2 as never, () => {});
    expect(r2).toBe('eyJ-final');
    expect(win2.closed).toBe(false);  // token path leaves the window alone
  });
});
