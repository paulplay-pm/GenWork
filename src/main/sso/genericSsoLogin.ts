import http from 'node:http';

import { type BrowserWindow,shell } from 'electron';

import { openOauthFlow } from '../mcp/oauthBrowserFlow';

/** Fetch the SSO callback port from the enterprise server.
 *
 *  The server is the single source of truth for SSO_DESKTOP_REDIRECT_PORT
 *  — admins configure it in `enterprise_server/.env` (or the server's
 *  launch environment), and the desktop fetches the value at login
 *  time. This avoids per-machine desktop `.env` configuration and
 *  keeps the desktop in sync with whatever the server sends as
 *  `redirect_uri` to the IdP. A failed fetch falls through to the
 *  historical default (53231) so a transient network blip never
 *  blocks SSO; the user can retry.
 */
export async function fetchDesktopRedirectPort(enterpriseBaseUrl: string): Promise<number> {
  const DEFAULT = 53231;
  try {
    const res = await fetch(new URL('/auth/sso/redirect-port', enterpriseBaseUrl).toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return DEFAULT;
    const j = (await res.json()) as { port?: unknown };
    if (typeof j.port !== 'number' || !Number.isInteger(j.port) || j.port < 1 || j.port > 65535) {
      return DEFAULT;
    }
    return j.port;
  } catch {
    // The server may be down, unreachable, or the request may be blocked
    // by a corporate proxy. Falling back to the historical default lets
    // a misconfigured desktop still log in against the common case.
    return DEFAULT;
  }
}

export interface AuthorizeArgs {
  enterpriseBaseUrl: string;  // e.g. https://api.genwork.example
  orgName: string;
  connectionId: string;
  desktopPort: number;  // the loopback port we'll bind.
}

export function buildAuthorizeUrl(a: AuthorizeArgs): string {
  const u = new URL(`/auth/sso/${encodeURIComponent(a.connectionId)}/authorize`, a.enterpriseBaseUrl);
  u.searchParams.set('orgName', a.orgName);
  u.searchParams.set('return', 'desktop');
  u.searchParams.set('desktop_port', String(a.desktopPort));
  return u.toString();
}

interface Arrival {
  kind: 'token' | 'error' | 'pendingBind';
  token?: string;
  error?: string;
  /** Server-relative or absolute URL of the bind-sso page the user must
   *  complete in their OS browser. Populated only when kind === 'pendingBind'. */
  bindUrl?: string;
  /** Connection name (e.g. "Feishu"); only for pendingBind. */
  connectionName?: string;
}

// Public endpoint name kept in one place so the router and the
// desktop's POST URL cannot drift apart without a TypeScript error.
const DESKTOP_EXCHANGE_PATH = '/auth/sso/desktop/exchange';

// Inline CSS for the post-bind success / error pages the loopback
// renders in the user's OS browser after the bind completes. Kept as
// a string constant so the server-rendered HTML is self-contained —
// no external asset pipeline, no public/ folder, no CDN dependency.
// The same styles drive both bindSuccessHtml and bindErrorHtml; the
// error variant overrides the check-circle color via the
// `.check-circle--error` modifier. Visual language mirrors the
// server's bind-sso page (enterprise_server/src/routes/auth/ssoBind.ts:
// brand tiles, light green check, primary blue close button, light
// green "safe to close" pill) so the two surfaces feel like one
// product.
const BIND_PAGE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue",
               Helvetica, Arial, sans-serif;
  background: #f4f5f7; color: #0f172a;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
}
.page {
  max-width: 540px; margin: 0 auto; padding: 48px 24px 80px;
  display: flex; flex-direction: column; align-items: center; text-align: center;
}
.brand-row {
  display: flex; align-items: center; gap: 12px; margin-bottom: 28px;
}
.brand-tile {
  width: 48px; height: 48px; border-radius: 10px; display: flex;
  align-items: center; justify-content: center; overflow: hidden;
  box-shadow: 0 1px 2px rgba(15,23,42,.08);
  font-weight: 700; font-size: 22px;
}
.brand-tile--provider { background: #fff; color: #1f2937; }
.brand-tile--genwork { background: #1f2937; color: #fff; }
.brand-arrow { color: #94a3b8; font-size: 18px; }

.check-wrap { margin: 0 0 20px 0; }
.check-circle {
  width: 72px; height: 72px; border-radius: 50%;
  background: #dcfce7; color: #16a34a;
  display: flex; align-items: center; justify-content: center;
  margin: 0 auto;
}
.check-circle--error { background: #fee2e2; color: #dc2626; }

.title {
  font-size: 26px; line-height: 1.25; font-weight: 700; color: #0f172a;
  margin: 0 0 12px 0;
}
.subtitle {
  font-size: 15px; line-height: 1.6; color: #475569;
  margin: 0 0 28px 0; max-width: 420px;
}

.close-btn {
  background: #3b5bdb; color: #fff; border: 0; border-radius: 10px;
  padding: 16px 24px; font: inherit; font-weight: 600; font-size: 15px;
  cursor: pointer; width: 100%; max-width: 360px;
  transition: background .15s, transform .05s;
  box-shadow: 0 1px 2px rgba(15,23,42,.06);
}
.close-btn:hover { background: #324fbf; }
.close-btn:active { transform: translateY(1px); }

.safe-pill {
  display: inline-flex; align-items: center; gap: 6px;
  background: #dcfce7; color: #15803d;
  font-size: 13px; font-weight: 500;
  padding: 6px 14px; border-radius: 999px;
  margin-top: 20px;
}

/* Keyboard hint for closing the tab. The page usually closes
   itself after the deep link fires; revealed only when window.close()
   is rejected (W3C no-op for tabs not opened by script) so the
   user has a one-line fallback ("press Cmd/Ctrl+W"). Without
   the --visible class the hint is display:none so it takes zero
   vertical space — the user sees a clean success surface on the
   happy path. */
.close-hint {
  display: none; margin: 12px 0 0 0;
  font-size: 12px; color: #64748b;
}
.close-hint--visible { display: block; }
.close-hint kbd {
  display: inline-block; padding: 1px 6px;
  background: #fff; border: 1px solid #cbd5e1; border-radius: 4px;
  font: inherit; font-size: 11px; color: #0f172a;
  box-shadow: 0 1px 0 rgba(15,23,42,.04);
}
`;

/**
 * Start the loopback callback server.
 *
 * If `enterpriseBaseUrl` is provided, the server bridges
 * `?code=…&state=…` IdP redirects to the new public server endpoint
 * `POST /auth/sso/desktop/exchange` (which runs the PKCE exchange on
 * the server, where the client_secret lives). The bridge keeps the
 * browser-visible redirect_uri free of secrets and lets the existing
 * `?token=` / `?error=` probe settlement logic continue to work — on
 * a successful exchange the loopback 302s itself with `?token=…`, on
 * an error it 302s itself with `?error=…`. On the two-stage
 * `pendingBind` branch the loopback renders a friendly "go bind in
 * your browser" page and does NOT settle the probe, so the desktop
 * UI can show a clear message instead of silently timing out.
 *
 * Pass `null` (or omit) to disable the bridge entirely. The loopback
 * still resolves `?token=` / `?error=` directly — this is the path
 * the existing OAuth flows and the unit tests rely on.
 */
export function startCallbackServer(
  port: number,
  enterpriseBaseUrl: string | null = null,
): Promise<{
  port: number;
  close: () => void;
  /** Resolve with the most recent Arrival from the loopback.
   *
   *  - If a settlement is cached, hand it back synchronously and
   *    CLEAR the cache.
   *  - Otherwise, wait for the next settlement.
   *
   *  This is the contract the OAuth window's did-finish-load + poll
   *  loop rely on: each settlement is delivered to the first caller
   *  that picks it up, and a later caller (one that arrives after
   *  the settlement was consumed) waits for the next one.
   *
   *  It is also the contract the two-stage (pendingBind → token)
   *  flow requires: the probe sees the pendingBind, returns null to
   *  openOauthFlow, and the NEXT probe (after the loopback has
   *  settled the post-bind token) picks up the token.
   *
   *  The original "shared promise" design (every call returned the
   *  same one-shot promise) froze the second call on the first
   *  settlement's value; the older "cached and never cleared"
   *  design also froze the second call on the cached value. The
   *  cache-clearing design is what the two-stage flow needs. */
  waitForArrival: () => Promise<Arrival>;
}> {
  // The most recent settlement that has not yet been read by a
  // `waitForArrival` caller. `settle` replaces it; `waitForArrival`
  // reads it and clears the cache.
  let cached: Arrival | null = null;
  let resolveNext: ((v: Arrival) => void) | null = null;

  // The connection metadata from the most recent pending_bind
  // settlement. The server's ready_to_finalize redirect back to the
  // loopback carries only `?token=…`, so to render a provider-aware
  // success page (e.g. "飞书账号已完成与 GenWork 的绑定") the loopback
  // has to remember the connection from the prior stage. Set on
  // pendingBind settle; read by bindSuccessHtml when the post-bind
  // `?token=…` arrives. Cleared on every fresh startCallbackServer
  // call so a second login doesn't show a stale provider name.
  let lastBindContext: { connectionName: string; providerType: string } | null = null;

  /** Resolve the in-memory probe with the supplied arrival. Each
   *  settlement is delivered to either the next pending waiter OR
   *  the next reader, but not both — the value is consumed exactly
   *  once. */
  const settle = (a: Arrival): void => {
    if (resolveNext) {
      // A pending waiter is consuming this settlement directly.
      // Hand it to them and do not cache — the waiter's read does
      // not go through the cache path, and caching would let a
      // later caller (a subsequent probe poll) re-read the same
      // value and freeze on it instead of waiting for the next
      // settlement.
      const r = resolveNext;
      resolveNext = null;
      r(a);
      return;
    }
    // No pending waiter; cache for the next reader. The next
    // waitForArrival will read it and clear the cache, so a
    // subsequent settlement (or a later second-call read after
    // the cache was populated) can take over.
    cached = a;
  };

  /** Best-effort POST to the server's desktop exchange endpoint.
   *  On any non-2xx (including a 409 pendingBind which is part of the
   *  contract) returns the parsed body or null; on a transport error
   *  returns a synthetic `transport_error` so the loopback can still
   *  settle the probe with a clear message instead of hanging. */
  async function postExchange(code: string, state: string): Promise<
    | { kind: 'token'; token: string }
    | { kind: 'error'; error: string }
    | { kind: 'pending_bind'; bindUrl: string; connectionName: string; providerType: string }
    | null
  > {
    if (!enterpriseBaseUrl) return { kind: 'error', error: 'no_enterprise_base_url' };
    try {
      const url = new URL(DESKTOP_EXCHANGE_PATH, enterpriseBaseUrl).toString();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, state }),
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
      if (res.status === 200 && typeof body.token === 'string') {
        return { kind: 'token', token: body.token };
      }
      if (res.status === 409 && body.status === 'pending_bind') {
        return {
          kind: 'pending_bind',
          bindUrl: typeof body.bindUrl === 'string' ? body.bindUrl : `/bind-sso?state=${encodeURIComponent(state)}`,
          connectionName: typeof body.connectionName === 'string' ? body.connectionName : '',
          providerType: typeof body.providerType === 'string' ? body.providerType : 'generic-oidc',
        };
      }
      const err = typeof body.error === 'string' ? body.error : 'token_exchange_failed';
      return { kind: 'error', error: err };
    } catch (e) {
      // Network failure / server down. Surface as an error so the probe
      // settles with `?error=transport_error` instead of hanging the
      // window until openOauthFlow's outer timeout fires.
      return { kind: 'error', error: `transport_error:${(e as Error).message}` };
    }
  }

  /** Render the friendly "you need to bind in your browser" page for
   *  strict-mode unbound identities (spec §12 P1). Plain HTML, no
   *  inline script, no DOM injection surface. The `bindUrl` is
   *  server-controlled (the response from the exchange endpoint). */
  function pendingBindHtml(bindUrl: string, connectionName: string): string {
    const safeName = connectionName.replace(/[<>&"']/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
    }[c] as string));
    return (
      '<!doctype html><meta charset="utf-8">' +
      '<title>GenWork SSO — binding required</title>' +
      '<h1>SSO login needs an extra step</h1>' +
      `<p>This sign-in is for the <b>${safeName}</b> identity provider and ` +
      'requires a one-time binding step that can only be completed in your browser.</p>' +
      `<p>Please open the following link in your browser to finish binding, ` +
      `then return to the desktop and try again:</p>` +
      `<p><a href="${bindUrl}">${bindUrl}</a></p>` +
      '<p>You can close this window after opening the link.</p>'
    );
  }

  /** Render the post-bind success page the user sees in their OS
   *  browser after the bind completes. The user is staring at this
   *  page in the OS browser they used to bind — it needs to be a
   *  coherent "you're done, close this" page, not a raw success
   *  stub. The design mirrors the server's bind-sso page (provider
   *  tile → G tile, light green checkmark, primary close button,
   *  light green "safe to close" pill) so the two surfaces feel
   *  like one product. Provider-aware: substitutes the connection
   *  name into the body copy.
   *
   *  `bindContext` is the {connectionName, providerType} the loopback
   *  captured during the prior pendingBind settlement; null means
   *  this isn't a bind-flow hit (e.g. a direct MCP `?token=…`
   *  redirect) and we fall back to a generic message. */
  function bindSuccessHtml(bindContext: { connectionName: string; providerType: string } | null): string {
    const provider = (bindContext?.connectionName || '').replace(/[<>&"']/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
    }[c] as string));
    // Letter-tile fallback for the provider icon. The desktop
    // doesn't ship the same per-provider logo assets the server
    // serves from `enterprise_server/public/...`, so the success
    // page can't render a real Feishu/DingTalk glyph. The first
    // character of the connection name is close enough visually
    // and matches the server's brand-fallback in
    // src/routes/auth/ssoBind.ts:212.
    const providerLetter = provider ? provider.slice(0, 1).toUpperCase() : '·';
    const providerName = provider || 'SSO';
    return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录成功 — GenWork</title>
<style>${BIND_PAGE_CSS}</style>
</head>
<body>
  <main class="page">
    <div class="brand-row" aria-hidden="true">
      <div class="brand-tile brand-tile--provider"><span>${providerLetter}</span></div>
      <span class="brand-arrow">→</span>
      <div class="brand-tile brand-tile--genwork"><span>G</span></div>
    </div>

    <div class="check-wrap" aria-hidden="true">
      <div class="check-circle">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
    </div>

    <h1 class="title">登录成功</h1>
    <p class="subtitle">${providerName} 账号已完成与 GenWork 的绑定。请关闭本页面,回到 GenWork 客户端继续使用。</p>

    <button type="button" class="close-btn" id="close-btn">关闭本页面,打开GenWork</button>

    <div class="safe-pill" aria-live="polite">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
      <span>绑定已完成,本页面可安全关闭</span>
    </div>
    <p class="close-hint" id="close-hint">如未自动关闭,请按 <kbd>⌘W</kbd> / <kbd>Ctrl+W</kbd></p>
  </main>
  <script>
    // Click the button to fire the genwork:// deep link. The OS
    // shows its own "Open this application?" prompt (Chrome's
    // external-protocol confirmation); the user picks 打开 GenWork
    // or 取消 there. We don't add a second in-page confirm — the
    // OS prompt already covers the decision, and asking twice
    // forces an extra click on a surface the user just finished
    // authorizing.
    //
    // window.close() is a W3C no-op for tabs not opened by
    // script (Chromium / WebKit / Gecko all enforce). Try it
    // anyway; if the browser refuses, the keyboard hint below
    // tells the user how to close the tab themselves. The hint
    // starts hidden so the happy path looks clean.
    (function () {
      var btn = document.getElementById('close-btn');
      var hint = document.getElementById('close-hint');
      if (!btn) return;
      btn.addEventListener('click', function () {
        // Disable so a second click can't double-fire the deep
        // link (which on some OSes would re-show the OS prompt).
        btn.disabled = true;
        try { window.location.href = 'genwork://'; } catch (e) { /* swallow */ }
        try { window.close(); } catch (e) { /* swallow */ }
        if (hint) hint.classList.add('close-hint--visible');
      });
    })();
  </script>
</body>
</html>`;
  }

  /** Render an error page for the post-bind `?error=…` path. Same
   *  visual shell as bindSuccessHtml, but with a red status icon and
   *  an error-specific message. The user lands here if the server's
   *  ready_to_finalize finalize encountered a transport error or
   *  the bind was rejected mid-flight. */
  function bindErrorHtml(errorCode: string, bindContext: { connectionName: string; providerType: string } | null): string {
    const safeErr = errorCode.replace(/[<>&"']/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
    }[c] as string));
    const provider = bindContext?.connectionName?.replace(/[<>&"']/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
    }[c] as string)) ?? '';
    const providerLetter = provider ? provider.slice(0, 1).toUpperCase() : '·';
    return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录失败 — GenWork</title>
<style>${BIND_PAGE_CSS}</style>
</head>
<body>
  <main class="page">
    <div class="brand-row" aria-hidden="true">
      <div class="brand-tile brand-tile--provider"><span>${providerLetter}</span></div>
      <span class="brand-arrow">→</span>
      <div class="brand-tile brand-tile--genwork"><span>G</span></div>
    </div>

    <div class="check-wrap" aria-hidden="true">
      <div class="check-circle check-circle--error">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </div>
    </div>

    <h1 class="title">登录未完成</h1>
    <p class="subtitle">绑定过程出现错误(${safeErr})。请回到桌面端重试,或在客户端重新发起 ${provider || 'SSO'} 登录。</p>

    <button type="button" class="close-btn" id="close-btn">关闭本页面,打开GenWork</button>

    <p class="close-hint" id="close-hint">如未自动关闭,请按 <kbd>⌘W</kbd> / <kbd>Ctrl+W</kbd></p>
  </main>
  <script>
    (function () {
      var btn = document.getElementById('close-btn');
      var hint = document.getElementById('close-hint');
      if (!btn) return;
      btn.addEventListener('click', function () {
        btn.disabled = true;
        try { window.location.href = 'genwork://'; } catch (e) { /* swallow */ }
        try { window.close(); } catch (e) { /* swallow */ }
        if (hint) hint.classList.add('close-hint--visible');
      });
    })();
  </script>
</body>
</html>`;
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsed = new URL(req.url || '/', 'http://localhost');
      if (parsed.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const errParam = parsed.searchParams.get('error');
      const tokenParam = parsed.searchParams.get('token');
      const codeParam = parsed.searchParams.get('code');
      const stateParam = parsed.searchParams.get('state');

      // ---- Bridge path: IdP redirected with `?code=…&state=…`.
      // POST the codes to the server, then settle the probe with the
      // outcome (or render the pendingBind page for strict-mode unbound).
      if (codeParam && stateParam && enterpriseBaseUrl) {
        const outcome = await postExchange(codeParam, stateParam);
        if (outcome && outcome.kind === 'pending_bind') {
          // The desktop opens the bind-sso page in the user's OS default
          // browser (where they'll enter their GenWork account and password)
          // via the probe in startSsoMemberLogin. The probe settles the
          // wait with the pendingBind outcome so it can act on it, then
          // keeps polling. The server's ready_to_finalize finalize (after
          // the bind POST) redirects the browser to the loopback with
          // ?token=…; the loopback's later settlement then returns the
          // token to the probe and startSsoMemberLogin resolves.
          //
          // The friendly HTML page is still rendered to the IdP auth
          // window so a user who doesn't have the OS browser open sees a
          // coherent explanation, not a blank screen.
          // Remember the connection for the post-bind success
          // page (see lastBindContext comment above). The desktop
          // doesn't ship the server's per-provider logo assets, so
          // the success page falls back to a letter tile when the
          // connection logo isn't reachable.
          lastBindContext = {
            connectionName: outcome.connectionName || 'SSO',
            providerType: outcome.providerType,
          };
          settle({
            kind: 'pendingBind',
            bindUrl: outcome.bindUrl,
            connectionName: outcome.connectionName,
          });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(pendingBindHtml(outcome.bindUrl, outcome.connectionName));
          return;
        }
        if (outcome && outcome.kind === 'token') {
          res.writeHead(302, { location: `/callback?token=${encodeURIComponent(outcome.token)}` });
          res.end();
          settle({ kind: 'token', token: outcome.token });
          return;
        }
        if (outcome && outcome.kind === 'error') {
          res.writeHead(302, { location: `/callback?error=${encodeURIComponent(outcome.error)}` });
          res.end();
          settle({ kind: 'error', error: outcome.error });
          return;
        }
        // postExchange returned null only on a malformed/transport edge
        // case — postExchange always returns a tagged record. This branch
        // is here as a defensive catch (e.g. an exchange function refactor
        // someday returning null) so a regression never hangs the probe.
        res.writeHead(302, { location: '/callback?error=token_exchange_failed' });
        res.end();
        settle({ kind: 'error', error: 'token_exchange_failed' });
        return;
      }

      // ---- Legacy path: `?token=…` / `?error=…` directly on the
      // loopback (still used by MCP OAuth callers, the existing ready_
      // to_finalize finalize path, and the unit tests). Self-closing
      // page: the JS setTimeout gives the desktop's OAuth probe a
      // tick to read the token from waitForArrival() and settle the
      // OAuth flow with the credential, BEFORE this window is
      // destroyed (which would otherwise race the probe and could
      // surface as "closed before the credential was received" if
      // the user is quick to close the OS window).
      //
      // The post-bind finalize (server's ready_to_finalize redirects
      // the browser to `${redirectUri}?token=…`) lands here. After
      // binding completes, the user is staring at this page in the
      // OS browser they used to bind — so it needs to be a
      // coherent "you're done, close this" page, not the raw
      // "登录成功,正在返回桌面…" stub.
      if (tokenParam) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(bindSuccessHtml(lastBindContext));
        settle({ kind: 'token', token: tokenParam });
        return;
      }
      if (errParam) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(bindErrorHtml(errParam, lastBindContext));
        settle({ kind: 'error', error: errParam });
        return;
      }
      // The loopback was hit but with no actionable params. Treat as a
      // transport error so the probe doesn't hang until openOauthFlow's
      // outer timeout fires.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(bindErrorHtml('invalid_callback', lastBindContext));
      settle({ kind: 'error', error: 'invalid_callback' });
    });
    server.on('error', reject);
    // The port comes from the server (see fetchDesktopRedirectPort); if
    // it is already in use, `server.on('error', reject)` surfaces the
    // collision loudly instead of hanging in openOauthFlow.
    server.listen(port, '127.0.0.1', () => {
      // When the caller passed 0, the OS picked a real port for us;
      // report the bound port so the OAuth flow (and tests) can hit
      // the same /callback the server is actually listening on.
      const boundPort = (server.address() as { port: number } | null)?.port ?? port;
      resolve({
        port: boundPort,
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore close races */
          }
        },
        waitForArrival: () => {
          // If a settlement is cached, hand it back synchronously
          // and CLEAR the cache. Clearing is what makes the two-stage
          // flow work: after the loopback settled pendingBind, the
          // probe picks it up, returns null to openOauthFlow, and on
          // the next poll the cache is empty so this branch is not
          // taken — the next settlement (the post-bind token) is
          // what the next branch waits for.
          //
          // Late callers in the single-settlement case still see the
          // same value: the test's `b = await cb.waitForArrival()`
          // after `a = await first` returns the cached value because
          // the first call returned a pending promise (no read,
          // no clear); the settle populated the cache; the second
          // call reads and clears.
          if (cached !== null) {
            const v = cached;
            cached = null;
            return Promise.resolve(v);
          }
          // Otherwise, wait for the next settlement.
          return new Promise<Arrival>((r) => { resolveNext = r; });
        },
      });
    });
  });
}

export async function startSsoMemberLogin(args: {
  enterpriseBaseUrl: string;
  orgName: string;
  connectionId: string;
  parentWindow?: BrowserWindow | null;
}): Promise<string> {
  // The IdP (Feishu, Okta, etc.) compares `redirect_uri` as a literal
  // string against the Authorized redirect URI list registered on the
  // enterprise app, so the port we bind here MUST match the value the
  // server embeds in the IdP-facing URL. Fetch the server's
  // configuration first; a transient fetch failure falls back to the
  // historical default (see fetchDesktopRedirectPort).
  const desktopPort = await fetchDesktopRedirectPort(args.enterpriseBaseUrl);
  // The bridge base URL is the same enterprise server we are talking
  // to for /auth/sso/redirect-port — passing it through enables the
  // loopback to forward IdP redirects carrying `?code=…&state=…` to
  // POST /auth/sso/desktop/exchange. Without this, the legacy
  // `?token=` / `?error=` direct-settlement path is still functional
  // (and the existing ready_to_finalize finalize can still hand the
  // token to us), but PKCE-protected OIDC logins would time out.
  const cb = await startCallbackServer(desktopPort, args.enterpriseBaseUrl);
  try {
    const authorizeUrl = buildAuthorizeUrl({
      enterpriseBaseUrl: args.enterpriseBaseUrl,
      orgName: args.orgName,
      connectionId: args.connectionId,
      desktopPort: cb.port,
    });
    // openOauthFlow's probe is called repeatedly (did-finish-load + poll
    // interval) and swallows probe exceptions, so we never throw here:
    // success returns the token; a server error closes the window so the
    // flow rejects promptly instead of hanging until timeoutMs.
    //
    // The pendingBind branch is the "two-stage strict-mode" path: the
    // server's /auth/sso/desktop/exchange returns 409 when the IdP
    // identity has no prebound GenWork user. We open the bind-sso page
    // in the user's OS default browser (so they can enter their GenWork
    // account and password), close the IdP auth window, and KEEP the
    // loopback probe alive. When the user completes the bind, the
    // server's ready_to_finalize finalize redirects the browser to
    // `${redirectUri}?token=…` — the loopback receives the token, the
    // next probe returns it, and startSsoMemberLogin resolves.
    //
    // The probe's second argument, `markIntentionalClose`, flips an
    // internal flag inside openOauthFlow so the window's `closed`
    // event does NOT reject the OAuth promise mid-handoff. The
    // loopback is still alive; the next probe reads the token.
    const probe = createSsoLoginProbe({
      enterpriseBaseUrl: args.enterpriseBaseUrl,
      cb,
    });
    const token = await openOauthFlow({
      parentWindow: args.parentWindow ?? null,
      title: 'SSO sign-in',
      authorizeUrl,
      probe,
    });
    if (!token) throw new Error('sso_login_failed');
    return token;
  } finally {
    cb.close();
  }
}

/** Build the OAuth probe for the desktop SSO login flow.
 *
 *  The probe reacts to three Arrival kinds from the loopback:
 *
 *  - `token`       — return the token; openOauthFlow resolves.
 *  - `pendingBind` — the server's strict-mode gate returned 409. We
 *    open the bind-sso page in the user's OS default browser
 *    (so they can enter their GenWork account and password) via
 *    `shell.openExternal`, then close the IdP auth window and
 *    return `null` to keep polling. The loopback is still alive;
 *    when the user completes the bind in the browser, the server's
 *    ready_to_finalize finalize redirects the browser to
 *    `${redirectUri}?token=…` — the loopback receives the token,
 *    the next probe returns it, and the flow resolves.
 *  - `error`       — close the IdP window so the flow rejects
 *    promptly instead of hanging until openOauthFlow's outer
 *    timeout fires.
 *
 *  Exported (rather than inlined into startSsoMemberLogin) so the
 *  probe's three branches can be unit-tested in isolation without
 *  driving the full openOauthFlow state machine.
 */
export function createSsoLoginProbe(args: {
  enterpriseBaseUrl: string;
  cb: {
    waitForArrival: () => Promise<Arrival>;
  };
}): (win: BrowserWindow, markIntentionalClose: () => void) => Promise<string | null> {
  return async (win, markIntentionalClose) => {
    // markIntentionalClose is unused on every branch of this probe
    // now. The token / error branches return without touching the
    // window (openOauthFlow closes it on settle), and the
    // pendingBind branch keeps the window open so the poll loop
    // stays alive — there is no "intentional close" to flag. We
    // still accept the parameter because the `OAuthFlowOptions.probe`
    // signature requires it (other probes — MCP, qichacha — use
    // it; see src/main/mcp/genericOauthFlow.ts:160).
    void markIntentionalClose;
    const r = await args.cb.waitForArrival();
    if (r.kind === 'token' && r.token) return r.token;
    if (r.kind === 'pendingBind' && r.bindUrl) {
      // Resolve the bind URL against the enterprise base so the OS
      // browser opens a real https/http URL, not a server-relative path.
      const absolute = (() => {
        try { return new URL(r.bindUrl!, args.enterpriseBaseUrl).toString(); }
        catch { return r.bindUrl!; }
      })();
      // shell.openExternal is the only safe way to launch the OS
      // browser from an Electron renderer/main; `window.open` is
      // blocked by sandboxing and would be a security regression.
      // Fire-and-forget — the user has the OS browser open, the
      // probe is what we're worried about.
      void shell.openExternal(absolute).catch(() => {
        /* best-effort: the friendly HTML in the IdP auth window
           still shows the link the user can click manually. */
      });
      // The IdP auth window STAYS OPEN on purpose. openOauthFlow's
      // poll loop is gated on `if (!authWindow || authWindow.isDestroyed())`
      // and would no-op if we closed it here — but we still need
      // the probe to keep running so it can read the post-bind
      // `kind: 'token'` settlement (delivered when the server's
      // ready_to_finalize finalize redirects the browser to
      // `${redirectUri}?token=…` and the loopback receives it).
      // The IdP auth window is no longer useful to the user (they
      // are now in the OS browser finishing the bind), but keeping
      // it open is the cost of keeping the probe alive until the
      // token arrives. The flow's outer settle() closes the window
      // when the token does arrive.
      return null;
    }
    if (r.kind === 'error') {
      try {
        win.close();
      } catch {
        /* window may already be gone */
      }
    }
    return null;
  };
}
