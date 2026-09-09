# Desktop Feishu SSO Login SIGSEGV — Design

> **For agentic workers:** This spec fixes a reproducible Electron main-process crash that occurs when the user logs in to the desktop via Feishu SSO after a previous SSO attempt left a `BrowserWindow` partition's network process in a half-completed TLS state. Read end-to-end before writing code; the fix is small and the diagnostic chain is the spec.

## Problem

When a user clicks "飞书授权登录" on the desktop and the IdP redirect reaches `https://open.feishu.cn/open-apis/authen/v1/index`, the embedded `BrowserWindow`'s network process logs **4 consecutive `SSL handshake failed; net_error -100` errors** and then the entire Electron app exits with `SIGSEGV`. Password login is unaffected. `curl https://open.feishu.cn/open-apis/authen/v1/index` from the same machine succeeds with a clean TLS 1.3 handshake, so the failure is not network reachability, not DNS, and not the OS CA bundle.

### Reproduction log (excerpt)

```text
[OpenClaw stdout] 2026-10-14T10:38:21.973+08:00 [ws] ⇄ res ✓ cron.list 1ms id=9245666b...8980
[22170:1014/103821.006510:ERROR:net/socket/ssl_client_socket_impl.cc:916] handshake failed; returned -1, SSL error code 1, net_error -100
[22170:1014/103821.007067:ERROR:net/socket/ssl_client_socket_impl.cc:916] handshake failed; returned -1, SSL error code 1, net_error -100
[22170:1014/103821.009560:ERROR:net/socket/ssl_client_socket_impl.cc:916] handshake failed; returned -1, SSL error code 1, net_error -100
[22170:1014/103821.009817:ERROR:net/socket/ssl_client_socket_impl.cc:916] handshake failed; returned -1, SSL error code 1, net_error -100
/Users/paulwang/work/GenWork/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron exited with signal SIGSEGV
```

### Why the crash signature is what it is

`PID 22170` is not the Electron main process (`PID 22159` in the same log) — it is one of Chromium's child processes inside the Electron binary. With the switches set in `src/main/main.ts:1703-1710` (notably `--no-sandbox` and `--disable-gpu --disable-software-rasterizer`), Chromium's process model collapses the network process into the main process's address space. When that child network process faults on a TLS retry, the SIGSEGV propagates up the IPC chain and the main process dies. The whole `Electron.app` exits, taking OpenClaw, the renderer, and any pending session state with it.

### Why the existing mitigation is not enough

`src/main/mcp/oauthBrowserFlow.ts:71-83` already creates the SSO `BrowserWindow` with `partition: 'oauth-${crypto.randomUUID()}'` so each attempt gets a fresh session — the opposite of what we want. The intent was to drop cookies between attempts, but the side effect is that **every SSO login spins up a brand-new network process**, and under load (a previous attempt was just cancelled, the loopback is still alive from a prior login, OpenClaw is processing gateway events) Chromium's collapsed process model cannot survive the contention.

## Goal

When a user clicks "飞书授权登录" (or any IdP-backed SSO login), the desktop MUST NOT crash. The login must either succeed, fail with a recoverable error the UI can render, or time out — but never `SIGSEGV` the whole process. The fix is a small change in two places:

1. **A stable partition for SSO `BrowserWindow`s.** All IdP-backed login windows share one partition. One network process, deterministic lifecycle, no per-attempt churn.
2. **A short, bounded `loadURL` timeout.** If the IdP TLS handshake does not complete within 20 seconds, `openOauthFlow` settles with a clear error and closes the window. No more 5-minute zombie windows whose network process is left holding half-completed TLS state.

The fix is observable end-to-end via a unit test on the partition selector and a manual validation under `npm run electron:dev` with a cancelled Feishu login followed by a fresh attempt.

## Architecture

### Decision 1 — Stable SSO partition

**Current:** `src/main/mcp/oauthBrowserFlow.ts:81` sets `partition: \`oauth-${crypto.randomUUID()}\``. Every SSO attempt creates a new partition and a new network process.

**Proposed:** Extract the partition name to a single constant. All SSO `BrowserWindow`s share the same partition name. The cookies/IndexedDB state for Feishu's authorize page are scoped to this partition and survive across attempts, which is what we want (so the user is not asked to re-authorize Feishu's app on every retry). The session isolation needed for security is provided by the loopback binding to `localhost:${SSO_DESKTOP_REDIRECT_PORT}` — the IdP `redirect_uri` is unique to this machine, so a partition shared with prior attempts is still safe.

```ts
// src/main/mcp/oauthBrowserFlow.ts (new)
const SSO_OAUTH_PARTITION = 'genwork-sso-oauth';

// inside BrowserWindow webPreferences:
partition: SSO_OAUTH_PARTITION,
```

**Why a named partition, not the default `persist:` partition?** The default partition is shared with the main app's BrowserWindow (where the renderer lives). Mixing SSO session cookies into the main app's session would leak IdP state. A dedicated named partition is isolated and persistent, and `partition: 'genwork-sso-oauth'` (without a `persist:` prefix) creates an in-memory session that is wiped on app restart — that is correct: a fresh install / fresh launch must always re-authorize the IdP, even on the same machine.

### Decision 2 — Bounded `loadURL` timeout

**Current:** `openOauthFlow` waits up to `timeoutMs` (default 5 minutes) for the IdP to redirect back. During that 5 minutes, the BrowserWindow's network process can sit in a half-completed TLS state, holding the IPC contract the main process is waiting on. If the user force-closes the window or the network process faults, the state is never cleanly released.

**Proposed:** Add a per-`loadURL` deadline. If the IdP does not redirect to the loopback within 20 seconds (the maximum time a healthy Feishu / Okta / Lark authorize → callback round-trip should take on any reasonable network), `openOauthFlow` settles with `sso_authorize_timeout` and closes the window. The 5-minute outer timeout stays as a safety net for the whole flow (covers slow user interaction at the IdP), but the inner loadURL deadline catches the TLS-stuck case.

**How to enforce:** Use `webContents.on('did-finish-load', ...)` to mark "page loaded", `webContents.on('did-fail-load', ...)` to settle on transport failure, and a `setTimeout(loadTimeoutMs, ...)` that settles with `sso_authorize_timeout` if neither event fires in time. Cancel the timer on `did-finish-load`. Default 20 000 ms; overrideable per call.

### Decision 3 — Surface the new error to the UI

`startSsoMemberLogin` (the IPC handler the renderer calls) already returns errors as `{ ok: false, error: 'sso_<code>' }`. Add `sso_authorize_timeout` to the list of error codes the renderer knows how to render. No renderer changes — `authService` already localizes and shows every `sso_*` error in a toast.

### Decision 4 — Clear SSO partition on logout

**Why this is needed (v2 reproduction):** After Decisions 1+2 landed, a different repro path still crashes: user A binds Feishu on Enterprise → logs into desktop with Feishu → on Enterprise, unbinds Feishu, rebinds → on desktop, logs out → clicks "飞书授权登录" again → **SIGSEGV**.

The crash signature is two bursts of `SSL handshake failed; net_error -100` errors, 4 errors to `ad.doubleclick.net` + `*.google-analytics.com` + `*.googletagmanager.com`, then SIGSEGV. The TLS failures are to the **IdP page's third-party tracking scripts** (Google Tag Manager, DoubleClick, Google Analytics, Bytedance captcha), not to Feishu itself. With Chromium's collapsed process model (`--no-sandbox --disable-gpu`), the network fault propagates to the main process.

**Why Decision 1 made the v2 crash more likely:** the stable partition accumulates TLS session state for Feishu's hosts. When the user rebinds on Enterprise and tries SSO again, the prior Feishu TLS state is stale and the new Feishu login collides with the (still-loading) third-party tracking scripts. Path A (this decision) clears that state on logout so the next SSO starts clean.

**Proposed:** in `enterpriseClient.logout()` (and any other logout entry point), call `session.fromPartition(SSO_OAUTH_PARTITION).clearStorageData({ storages: ['cookies', 'indexdb', 'localstorage', 'serviceworkers', 'cachestorage'] })` after the existing `sessionStorage.clear()` + `loginGate.lock()`. The clear is best-effort: failures are logged with `console.warn` but do not block logout. Await the clear so the IPC reply the renderer sees reflects a clean partition.

**Why this is not enough on its own:** a fresh install (no prior session) still reproduces the crash. A user on a new machine, or a user who has never logged in before, hits the same third-party-tracking TLS failure on the first SSO. Path A is necessary; it is not sufficient.

### Decision 5 — Block third-party requests in the SSO `BrowserWindow`

**Why this is the durable fix:** the SSO `BrowserWindow` is a single-purpose identity-handling surface. It should never load Google Analytics, DoubleClick, or Bytedance's captcha — those are page-owners' tracking, not part of the OAuth contract. The desktop owes the IdP a working authorize page; it does not owe the IdP's third parties a TLS handshake.

**Proposed:** install a `webRequest.onBeforeRequest` listener on `session.fromPartition(SSO_OAUTH_PARTITION).webRequest` inside `openOauthFlow`, immediately after the `BrowserWindow` is constructed. The listener computes an **allowlist** from the `authorizeUrl` host: the IdP's eTLD+1 plus all subdomains, plus `localhost` / `127.0.0.1` (loopback callback). Anything else is `cancel: true`'d with a `console.warn` for diagnostics.

**Allowlist derivation algorithm (v1):**
1. Parse the `authorizeUrl` host.
2. Strip the leftmost label if it is `www.` (so `www.feishu.cn` and `feishu.cn` agree).
3. Take the last two labels as the eTLD+1. (v1 ships a small hardcoded set: `feishu.cn`, `microsoftonline.com`, `dingtalk.com`, `weixin.qq.com`, `okta.com`. Generic OIDC/SAML where the admin provides a custom domain are accepted at face value — the admin's own IdP.)
4. Allow requests where the URL's host equals the eTLD+1 or ends with `.<eTLD+1>`.
5. Always allow `localhost` and `127.0.0.1` (any port).
6. Block everything else with `console.warn('[OAuthFlow] blocked non-IdP request to <host>')`.

**Why per-`openOauthFlow` and not once on app start:** the listener is bound to the partition's `Session`, but the allowlist depends on the IdP. Each `openOauthFlow` call knows the IdP (via the `authorizeUrl` it was given) and can register the right allowlist. We tear the listener down when the flow settles (in `settle()`) to avoid stale listeners on the long-lived partition's session.

**Why `onBeforeRequest` and not `setPermissionRequestHandler`:** the third-party resources are `<script src="…">` and `<img src="…">` tags, not permission requests (camera, geolocation, etc.). `onBeforeRequest` is the only `webRequest` stage that catches sub-resource loads.

**Failure mode if the rule is too strict:** a real IdP that needs a third-party (Feishu's Bytedance captcha, for example) will see those resources blocked, and the user will see a captcha failure on the IdP page. The OAuth callback still works (it's an IdP-issued redirect to `localhost`), so the user can still complete login. The user would prefer "captcha failed, try again" over "app crashed". The blocked requests are logged so support can identify the gap and add the host to a per-IdP exception list (out of scope for v1).

## Decisions Locked

- **Single stable partition name** `genwork-sso-oauth` for all SSO `BrowserWindow`s, defined as a const at the top of `src/main/mcp/oauthBrowserFlow.ts`. Replaces the per-attempt `oauth-${crypto.randomUUID()}`.
- **Default `loadURL` deadline** 20 000 ms in `openOauthFlow`. Settles with `sso_authorize_timeout` on deadline expiry. Per-call override via `OAuthFlowOptions.loadTimeoutMs`.
- **No changes** to the outer 5-minute `timeoutMs`, the `did-fail-load` handler, the `closed` handler, or the `intentionalClose` semantics. The new deadline is additive.
- **No changes** to other callers of `openOauthFlow` (`startSsoMemberBind`, MCP OAuth, qichacha). They get the new deadline for free via the default.
- **No Chromium feature flags** added. We do not flip `--no-sandbox` off, do not add `--in-process-gpu`, do not touch the network service. The fix is in the desktop's own code; the rest is diagnosis-not-mitigation.
- **No move to `shell.openExternal` for the IdP authorize step** in v1. The OS-browser handoff is a cleaner architectural choice but it changes the UX (user leaves the app, comes back via loopback callback) and is a separate concern. Tracked as a future-cycle idea, not in this spec.
- **Path A (Decision 4):** `session.fromPartition(SSO_OAUTH_PARTITION).clearStorageData(...)` is awaited inside `enterpriseClient.logout()` so the next SSO on the same launch starts from a clean partition. Best-effort: failures warn but do not block logout. Logout entry points (main process IPC handler `auth:logout`, `enterpriseClient.logout()`) all clear.
- **Path B (Decision 5):** `webRequest.onBeforeRequest` on the SSO partition's `Session` blocks all non-IdP requests during the SSO `BrowserWindow` lifetime. Allowlist = `authorizeUrl`'s eTLD+1 (with a small hardcoded fallback for the 5 v1 IdPs) + `localhost`/`127.0.0.1`. Listener registered inside `openOauthFlow`, torn down in `settle()`. Blocked requests are logged with `console.warn` for diagnostics.
- **No per-IdP allowlist maintenance UI** in v1. If a real IdP needs a third-party (Feishu's Bytedance captcha, for example), the desktop user sees a captcha failure on the IdP page, not a SIGSEGV. The OAuth callback still works. Future cycle can ship a per-IdP allowlist override.

## File Layout

### Modify

- **`src/main/mcp/oauthBrowserFlow.ts:71-83`** — replace `partition: \`oauth-${crypto.randomUUID()}\`` with `partition: SSO_OAUTH_PARTITION`. Add the named const at the top of the file. Export the const so tests and the IPC logout handler can reference the same name.
- **`src/main/mcp/oauthBrowserFlow.ts:36-47`** — add `loadTimeoutMs?: number` to `OAuthFlowOptions` (default 20 000).
- **`src/main/mcp/oauthBrowserFlow.ts:36-170`** — implement the `loadURL` deadline: a `setTimeout` placed immediately after `loadURL(authorizeUrl)` is called, cleared on `did-finish-load` and on settle. On expiry, call `settle(new Error('sso_authorize_timeout'))` and `console.warn(\`[OAuthFlow] "${title}" loadURL deadline exceeded\`)`.
- **`src/main/mcp/oauthBrowserFlow.ts` (Decision 5)** — inside `openOauthFlow`, after the `BrowserWindow` is constructed and before `loadURL`, register `session.fromPartition(SSO_OAUTH_PARTITION).webRequest.onBeforeRequest(...)` that allowlists the IdP's eTLD+1 + `localhost`/`127.0.0.1` and cancels everything else. Capture the listener reference so `settle()` can remove it on flow teardown. Add a small pure helper `deriveIdpAllowlist(authorizeUrl: string): { allowHosts: string[]; etld1: string }` that parses the host, strips `www.`, and returns the eTLD+1 (using a hardcoded lookup for the 5 v1 IdPs, or the last two labels for custom OIDC). Export the helper so tests can pin its behavior.
- **`src/main/auth/enterpriseClient.ts:582-585`** — in `logout()`, after the existing `sessionStorage.clear()` + `loginGate.lock()`, call `const { session } = await import('electron')` (or top-of-file import if already there) and `await session.fromPartition(SSO_OAUTH_PARTITION).clearStorageData({ storages: ['cookies','indexdb','localstorage','serviceworkers','cachestorage'] })`. Make `logout()` async; wrap the clear in `try/catch` that logs `console.warn` on failure and does not rethrow (logout must not throw). Update the single caller of `logout()` to `await` it. The partition name is imported from `oauthBrowserFlow.ts`.
- **`src/main/main.ts` IPC `auth:logout` handler** — the handler that proxies to `enterpriseClient.logout()` must `await` the now-async method before returning to the renderer.

### Modify (existing test update)

- **`src/main/mcp/oauthBrowserFlow.test.ts:115-122`** — the existing assertion `expect(opts.webPreferences.partition).toMatch(/^oauth-/)` pins the OLD per-attempt random partition name. Update the assertion to `expect(opts.webPreferences.partition).toBe('genwork-sso-oauth')` so it pins the NEW stable name. This is a one-line change that converts a stale test into a load-bearing pin.
- **`src/main/mcp/oauthBrowserFlow.test.ts`** — extend with:
  - Test that the partition name is stable (read the const, assert a known SSO call uses it).
  - Test that the deadline settles the flow with `sso_authorize_timeout` when `did-finish-load` does not fire in time (use a fake `BrowserWindow` that never emits `did-finish-load`; advance fake timers past `loadTimeoutMs`).
  - Test that the deadline is cancelled when `did-finish-load` fires first (no double-settle).
  - Test that the allowlist helper returns `feishu.cn` + subdomains for `https://open.feishu.cn/open-apis/authen/v1/index`, `microsoftonline.com` for Azure AD, etc.
  - Test that the `webRequest.onBeforeRequest` listener cancels requests to `*.doubleclick.net` / `*.google-analytics.com` / `*.googletagmanager.com` and allows requests to `accounts.feishu.cn` / `passport.feishu.cn` / `*.feishucdn.com` / `localhost`.
  - Test that the listener is removed on `settle()` (no listener leak when `openOauthFlow` is called many times).
  - Test that the Feishu preset URLs from `providerPresets.ts` are all under the `feishu.cn` eTLD+1 (defends against future preset edits that would break the allowlist silently).
- **`src/main/auth/enterpriseClient.test.ts`** (or co-located test) — extend with:
  - Test that `logout()` calls `session.fromPartition(SSO_OAUTH_PARTITION).clearStorageData` with the expected storages and awaits the result.
  - Test that `logout()` does not throw if `clearStorageData` rejects (best-effort behavior).
  - Test that the IPC `auth:logout` handler awaits `logout()` before returning.

### Tests

- **Unit** — `src/main/mcp/oauthBrowserFlow.test.ts`. Update the existing partition assertion to pin the new stable name. Add the tests above.
- **Unit** — `src/main/auth/enterpriseClient.test.ts` (or co-located). Add the logout tests above.
- **Manual reproducer (v1 — cancel+retry)** — `npm run electron:dev`, log out, click "飞书授权登录", close the BrowserWindow at the Feishu authorize step (force-quit via Cmd-W), then click "飞书授权登录" again. Before the fix: SIGSEGV. After the fix: second attempt loads Feishu cleanly OR settles with `sso_authorize_timeout` within 20 seconds, app stays alive across both attempts.
- **Manual reproducer (v2 — rebind+relogin)** — `npm run electron:dev`, bind Feishu on Enterprise, log into desktop with Feishu, unbind+rebind on Enterprise, log out of desktop, log in with Feishu again. Before the fix: SIGSEGV with `*.doubleclick.net` SSL errors. After the fix: app stays alive, second Feishu login works (or fails fast with a captcha error if Bytedance is blocked, but does not crash).
- **Lint** — `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/mcp/oauthBrowserFlow.ts src/main/mcp/oauthBrowserFlow.test.ts src/main/auth/enterpriseClient.ts src/main/auth/enterpriseClient.test.ts src/main/main.ts`.

## Review Focus (5 input classes most likely to bite)

1. **Stable partition leaks cookies across users on the same machine** — a user logs out, another user logs in via Feishu on the same OS account, the second user inherits the first user's Feishu cookies. **Expected:** the `genwork-sso-oauth` partition is in-memory (no `persist:` prefix per Electron's [Session API](https://www.electronjs.org/docs/latest/api/session)), so cookies die on app restart. Within a single launch, the next user is on a clean SSO partition. **Pinned by:** a test that constructs the `BrowserWindow` twice in a row and asserts BOTH use the partition name `genwork-sso-oauth` (not a random per-attempt name). Path A in Decision 4 also clears the partition on logout, so within a single launch, user B does not inherit user A's cookies even before the next app restart.
2. **`loadURL` deadline races with legitimate slow IdPs** — Feishu is fast, but Okta / Azure AD can take 30+ seconds on first-time corporate-MFA enrollment. 20 seconds is too tight. **Expected:** per-call override via `loadTimeoutMs`, and the existing 5-minute `timeoutMs` outer deadline still applies. **Pinned by:** a test that sets `loadTimeoutMs: 5_000` on a call where `did-finish-load` fires at 8s and asserts the flow does NOT settle early. (i.e. `did-finish-load` resets the deadline; the deadline is "page failed to load", not "user took too long".)
3. **Settling twice on the deadline + `did-fail-load`** — Chromium can fire `did-fail-load` and the `loadURL` deadline in either order under edge cases. `settle()` already has a `if (settled) return` guard. **Pinned by:** a test that emits both events in quick succession and asserts `settle` is called exactly once.
4. **The default 20s is too short for slow networks** — a user on a slow corporate VPN or a flaky mobile hotspot can take 30+ seconds to load Feishu. **Expected:** logged as a known caveat; the deadline is the IdP **authorize page loading**, not the user interacting with it. **Pinned by:** the deadline test is a test on `loadURL` only — once `did-finish-load` fires (page rendered), the timer is cleared and the user has the full 5 minutes to interact.
5. **Other callers of `openOauthFlow` regress** — `startSsoMemberBind`, MCP OAuth, qichacha all use `openOauthFlow`. Switching the partition to a named constant affects them too. **Expected:** they all share the same partition, which is correct — they are all IdP/MCP authorizations, and a user has only one set of OAuth credentials at a time. **Pinned by:** the existing `startSsoMemberBind.test.ts` and `qichachaMcpAuth.test.ts` continue to pass (the partition name is an implementation detail of `openOauthFlow`; these tests mock it). **Path B caveat:** the `webRequest.onBeforeRequest` listener is installed for every `openOauthFlow` call. For MCP OAuth (e.g. Notion, GitHub), the `authorizeUrl` host is `api.notion.com` / `github.com` — the allowlist is derived from that host. The listener does not block MCP `localhost` callback redirects.

## Review Focus — v2 follow-up (Decisions 4 + 5)

6. **Path A: logout partition clear throws or hangs** — `session.fromPartition(...).clearStorageData()` can reject on a closed session or hang on a slow filesystem. Logout must not throw. **Expected:** the `try/catch` in `enterpriseClient.logout()` logs `console.warn` and returns normally. The IPC `auth:logout` handler still replies `{ ok: true }`. **Pinned by:** a test that mocks `clearStorageData` to reject and asserts `logout()` resolves.
7. **Path B: allowlist algorithm miscomputes the eTLD+1** — `accounts.feishu.cn` and `feishu.cn` are both under the same eTLD+1 (`feishu.cn`); `feishucdn.com` is a different eTLD+1 (CDN, not IdP-owned). The hardcoded lookup table in v1 must list `feishu.cn` for Feishu — a naive "last two labels" rule would compute `feishu.cn` for `open.feishu.cn` (correct) but `feishucdn.com` for `*.feishucdn.com` (also correct, but if Feishu's tracking ever moves to a third CDN like `feishu-cdn.io`, the rule breaks). **Expected:** the hardcoded lookup is the source of truth for the 5 v1 IdPs; the "last two labels" fallback is only used for admin-configured custom OIDC where the admin already knows the IdP's domain. **Pinned by:** unit tests on the helper that pin all 5 v1 IdP hosts to their eTLD+1, plus a snapshot test of the `providerPresets.ts` `feishu` entry that asserts all three Feishu URLs are under `feishu.cn`.
8. **Path B: listener leak across calls** — the SSO partition is long-lived; if `openOauthFlow` is called 100 times in a session, the partition's `webRequest` could end up with 100 listeners. **Expected:** the listener is registered in `openOauthFlow` and removed in `settle()`. **Pinned by:** a test that calls `openOauthFlow` 5 times, settles each, and asserts `partition.webRequest` has no listeners.
9. **Path B: `devtools://` / `chrome-extension://` / `chrome://` URLs** — the SSO `BrowserWindow` does not load these, but a user DevTools toggle (or a future feature) might. The allowlist rule must allow them OR the user-facing DevTools will break. **Expected:** the `webRequest` listener only inspects `http://` / `https://` URLs; non-http schemes are passed through unchanged. **Pinned by:** a test that calls the listener with `devtools://devtools/...` and asserts the callback is called with `{ cancel: false }`.
10. **Path A: `enterpriseClient.logout()` is not the only logout path** — there are also `auth:logout` IPC, `quitAndInstall` flow, and (in future) an `enterprise:session-expired` handler. **Expected:** every logout path that wants a clean SSO partition must await `clearStorageData`. The single `enterpriseClient.logout()` method is the central seam, so updating it once covers all callers. **Pinned by:** a `grep` showing every `enterpriseClient.logout()` caller; each must `await` it.

## Out of Scope (explicit non-goals for v1)

- Moving the IdP authorize step to the OS browser via `shell.openExternal`. Better isolation, but a UX change. Tracked as a future cycle.
- Removing `--no-sandbox` / `--disable-gpu` from `src/main/main.ts:1703-1710`. The current flag set is load-bearing for the app's `better-sqlite3` native module and the build-time `electron-builder install-app-deps` step. Touching it is a separate, larger effort.
- Adding `--in-process-gpu` or other Chromium feature flags. The fix is in the desktop's own code.
- Reusing an open Feishu login across app restarts. A fresh launch must always re-authorize the IdP (in-memory partition, no `persist:` prefix).
- A global SSO attempt mutex. The current `openOauthFlow` is called from one IPC at a time in practice (the renderer disables the login button while a login is in flight), so a second concurrent attempt is not the failure mode we are fixing.
- A migration or spec doc for cycle 3. The Feishu 20029 fix (commits 58a1e6e + 98ecd73) stays as-shipped; this spec is a separate follow-up.
