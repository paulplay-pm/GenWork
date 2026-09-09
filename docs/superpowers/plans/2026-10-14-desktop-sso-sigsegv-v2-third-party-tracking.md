# Desktop SSO SIGSEGV v2 (Third-Party Tracking) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-KNOWN: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the second-crash SIGSEGV that fires when a user logs in via Feishu SSO after a previous Feishu bind has been unbound+rebound on the Enterprise side. The crash is in Chromium's network process when the IdP login page's third-party tracking scripts (Google Tag Manager, DoubleClick, Google Analytics, Bytedance captcha) fail TLS handshake in the SSO `BrowserWindow`. Two changes: (1) clear the SSO partition on logout so a stale TLS state can't collide with the next login; (2) install a `webRequest.onBeforeRequest` filter in `openOauthFlow` that allowlists only the IdP's eTLD+1 + `localhost`/`127.0.0.1`, blocking every third-party request.

**Architecture:** The stable SSO partition from the v1 spec is long-lived. Decision 4 (`enterpriseClient.logout` awaits `session.fromPartition(SSO_OAUTH_PARTITION).clearStorageData(...)`) tears down per-user state so the next SSO attempt starts fresh. Decision 5 (a new `webRequest.onBeforeRequest` listener bound to the partition's `Session` inside `openOauthFlow`) is the durable fix: the SSO `BrowserWindow` is a single-purpose identity surface and should never load third-party trackers. The listener computes its allowlist from the `authorizeUrl`'s host (eTLD+1 via a small hardcoded table for the 5 v1 IdPs, last-two-labels fallback for custom OIDC), allowlists `localhost`/`127.0.0.1` always, and cancels everything else with a `console.warn` for diagnostics. The listener is torn down in `settle()` to avoid leaking across calls on the long-lived partition's session.

**Tech Stack:** Electron 40.x (Session API + `webRequest.onBeforeRequest`), TypeScript, Vitest 2.x. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-desktop-sso-sigsegv-resilience-design.md` (Decisions 4 and 5; the v1 Decisions 1–3 are already shipped on `main`).

## Global Constraints

- Node.js `>=24.15.0 <25`.
- Conventional Commits English, no `Co-Authored-By` trailer.
- Per-file vitest in the sandbox (fd exhaustion). Run touched test files individually.
- Auto-commit local only; never push to remote.
- Lint on touched files: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`.
- No Chromium feature flag changes. The fix is in the desktop's own code.
- The SSO `BrowserWindow` may not import `electron`'s `session` separately for the listener — use `session.fromPartition(SSO_OAUTH_PARTITION)` from the existing `import { BrowserWindow, session } from 'electron'`.
- i18n strings in `src/main/i18n.ts` (zh + en) when adding user-visible copy. No new user-visible copy in this plan; the existing `sso_authorize_timeout` covers the only error path.

## Review Focus

1. **`clearStorageData` rejects on a closed session or hangs** — verified by the logout-best-effort test in Task 1 that mocks `clearStorageData` to reject and asserts `logout()` still resolves.
2. **Allowlist algorithm miscomputes the eTLD+1** — `accounts.feishu.cn` is under `feishu.cn` (correct); `*.feishucdn.com` is under `feishucdn.com` (correct, but a different eTLD+1 from Feishu itself). The hardcoded table is the source of truth for the 5 v1 IdPs; the last-two-labels fallback is for admin-configured custom OIDC. Pinned by the per-Idp allowlist tests in Task 2 and the snapshot test against `providerPresets.ts`.
3. **Listener leaks across calls** — the SSO partition is long-lived; if `openOauthFlow` is called 100 times in a session without `settle` removing the listener, we accumulate 100 listeners on the partition's `Session.webRequest`. Pinned by the multi-call teardown test in Task 2.
4. **`devtools://` / `chrome-extension://` / `chrome://` URLs blocked by accident** — a user DevTools toggle or a future Chromium internal navigation must not be canceled. The listener only inspects `http://`/`https://`; non-http schemes pass through. Pinned by the passthrough test in Task 2.
5. **Logout callers don't `await` the now-async `enterpriseClient.logout()`** — the IPC `auth:logout` handler must `await` it before replying. The `onEnterpriseMemberRevoked` callback (signature `() => void`) must wrap the body in an async IIFE so the partition clear runs to completion before the next session starts. Pinned by the IPC `auth:logout` test in Task 1 and the reviewer grep that finds no remaining fire-and-forget `logout()` callers.

---

### Task 1: Clear SSO partition on logout (Decision 4)

**Files:**
- Modify: `src/main/auth/enterpriseClient.ts:1-4` (import `session` from `electron` and `SSO_OAUTH_PARTITION` from `../mcp/oauthBrowserFlow`)
- Modify: `src/main/auth/enterpriseClient.ts:582-585` (make `logout()` async, await `clearStorageData`, wrap in try/catch)
- Modify: `src/main/ipcHandlers/enterpriseMt.ts:211-216` (await `enterpriseClient.logout()` inside the IPC handler)
- Modify: `src/main/main.ts:3208-3221` (wrap the `onEnterpriseMemberRevoked` body in a `void (async () => { ... })()` so the partition clear runs to completion)
- Modify: `src/main/auth/enterpriseClient.test.ts` (add 2 new tests for the partition clear)

**Interfaces:**
- Consumes: `SSO_OAUTH_PARTITION` (already exported from `src/main/mcp/oauthBrowserFlow.ts:20`).
- Produces: `enterpriseClient.logout(): Promise<void>` (was sync `void`). The method is best-effort: a `clearStorageData` rejection is logged with `console.warn` and swallowed; `logout()` always resolves.

- [ ] **Step 1: Add the failing test — `logout` clears the SSO partition**

In `src/main/auth/enterpriseClient.test.ts`, add a new `describe('enterpriseClient.logout', ...)` block. Mock `electron` to provide a fake `session.fromPartition(name).clearStorageData({ storages })` that resolves on call. The test:

1. Calls `enterpriseClient.logout()`.
2. Asserts the mock was called with `SSO_OAUTH_PARTITION` (the literal string `'genwork-sso-oauth'`) and a `storages` array that contains at least `'cookies'`, `'indexdb'`, `'localstorage'`, `'serviceworkers'`, `'cachestorage'`.

To mock `electron`, the file currently has no `vi.mock('electron')` — add one at the top of the test file (above the existing `describe` blocks). The mock returns a `session` object whose `fromPartition` returns an object with a `clearStorageData: vi.fn().mockResolvedValue(undefined)`. The existing test file uses only `globalThis.fetch` mocking, so the new mock does not affect existing tests.

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest';

const clearStorageDataMock = vi.fn().mockResolvedValue(undefined);
vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn((name: string) => ({
      _name: name,
      clearStorageData: clearStorageDataMock,
    })),
  },
}));

import { enterpriseClient } from './enterpriseClient';

beforeEach(() => {
  clearStorageDataMock.mockClear();
});
```

Add the new describe block (append to the file):

```ts
describe('enterpriseClient.logout', () => {
  test('clears the genwork-sso-oauth partition with the expected storages', async () => {
    await enterpriseClient.logout();
    expect(clearStorageDataMock).toHaveBeenCalledTimes(1);
    const [arg] = clearStorageDataMock.mock.calls[0]!;
    expect(arg).toEqual({
      storages: expect.arrayContaining([
        'cookies', 'indexdb', 'localstorage', 'serviceworkers', 'cachestorage',
      ]),
    });
  });

  test('does not throw when clearStorageData rejects (best-effort)', async () => {
    clearStorageDataMock.mockRejectedValueOnce(new Error('session closed'));
    await expect(enterpriseClient.logout()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run src/main/auth/enterpriseClient.test.ts`
Expected: the 2 new tests fail (the production code still uses the old sync `logout()` that does not touch `clearStorageData`).

- [ ] **Step 3: Make `enterpriseClient.logout` async and clear the SSO partition**

In `src/main/auth/enterpriseClient.ts`:

1. Add imports at the top:
   ```ts
   import { session } from 'electron';
   import { SSO_OAUTH_PARTITION } from '../mcp/oauthBrowserFlow';
   ```

2. Replace the `logout()` method (line 582) with:
   ```ts
   async logout(): Promise<void> {
     sessionStorage.clear();
     loginGate.lock();
     // Decision 4: clear the SSO BrowserWindow partition so the next
     // login attempt starts from a clean TLS / cookie state. Best-effort:
     // a closed session or a slow filesystem must not block logout.
     try {
       await session.fromPartition(SSO_OAUTH_PARTITION).clearStorageData({
         storages: ['cookies', 'indexdb', 'localstorage', 'serviceworkers', 'cachestorage'],
       });
     } catch (error) {
       console.warn('[enterpriseClient] failed to clear SSO partition on logout:', error);
     }
   },
   ```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx vitest run src/main/auth/enterpriseClient.test.ts`
Expected: all 4 tests pass (2 existing + 2 new).

- [ ] **Step 5: Update the IPC `auth:logout` handler to `await` the new async method**

In `src/main/ipcHandlers/enterpriseMt.ts:211-216`, change:

```ts
ipcMain.handle(EnterpriseIpcChannel.Logout, async () => {
  enterpriseClient.logout();
  // Phase C: drop any cached keys from the previous session. The next
  // successful login will trigger a fresh load.
  enterpriseModelCache.wipe();
});
```

to:

```ts
ipcMain.handle(EnterpriseIpcChannel.Logout, async () => {
  await enterpriseClient.logout();
  // Phase C: drop any cached keys from the previous session. The next
  // successful login will trigger a fresh load.
  enterpriseModelCache.wipe();
});
```

- [ ] **Step 6: Update the `onEnterpriseMemberRevoked` callback so the clear runs to completion**

In `src/main/main.ts:3208-3221`, change the synchronous body of the callback to an async IIFE so the partition clear can finish before the next render-frame. The adapter's signature stays `() => void`; the IIFE swallows its own rejection (which is the whole point of best-effort):

```ts
onEnterpriseMemberRevoked: () => {
  void (async () => {
    try {
      await enterpriseClient.logout();
      enterpriseModelCache.wipe();
      console.warn('[Auth] enterprise membership revoked; clearing session and returning to login gate');
    } catch (error) {
      console.error('[Auth] failed to clear session on enterprise membership revocation:', error);
    }
  })();
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(EnterpriseIpcChannel.SessionRevoked);
    }
  });
},
```

Note: the IPC `SessionRevoked` broadcast is intentionally outside the IIFE so the renderer learns about the revocation immediately and the partition clear can finish in the background. Logout is best-effort and the renderer's UI state does not depend on it.

- [ ] **Step 7: Lint the touched files**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/auth/enterpriseClient.ts src/main/auth/enterpriseClient.test.ts src/main/ipcHandlers/enterpriseMt.ts src/main/main.ts`
Expected: clean (0 errors, 0 warnings).

- [ ] **Step 8: Re-run the test files to confirm nothing regressed**

Run:
- `npx vitest run src/main/auth/enterpriseClient.test.ts`
- `npx vitest run src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts` (the `onEnterpriseMemberRevoked` test from the spec's review focus #10 — it asserts the callback was called once, not awaited, so the IIFE is compatible)

Expected: both pass.

- [ ] **Step 9: Commit**

```bash
git add src/main/auth/enterpriseClient.ts src/main/auth/enterpriseClient.test.ts \
        src/main/ipcHandlers/enterpriseMt.ts src/main/main.ts
git commit -m "fix(sso): clear SSO BrowserWindow partition on logout"
```

---

### Task 2: IdP allowlist in `openOauthFlow` (Decision 5)

**Files:**
- Modify: `src/main/mcp/oauthBrowserFlow.ts:1-2` (extend the `electron` import to include `session`)
- Modify: `src/main/mcp/oauthBrowserFlow.ts` (add `deriveIdpAllowlist` helper, install listener in `openOauthFlow`, remove in `settle`)
- Modify: `src/main/mcp/oauthBrowserFlow.test.ts` (mock the `session` from `electron`, extend the mock to support the `webRequest.onBeforeRequest` listener, add new tests)

**Interfaces:**
- Consumes: `SSO_OAUTH_PARTITION` (already exported, line 20). `OAuthFlowOptions.authorizeUrl` (already required).
- Produces: `export function deriveIdpAllowlist(authorizeUrl: string): { etld1: string; allowHosts: string[] }` — exported for tests. `allowHosts` is a list of host strings; the `isAllowed(url)` predicate is internal. The function never throws on a well-formed URL; on a malformed URL it falls back to allowing only `localhost` and `127.0.0.1` (defensive default — the request filter will cancel everything else with a `console.warn`).

- [ ] **Step 1: Add the failing test — `deriveIdpAllowlist` returns the right eTLD+1 for each v1 IdP**

In `src/main/mcp/oauthBrowserFlow.test.ts`, first update the existing import on line 113 from:

```ts
import { openOauthFlow } from './oauthBrowserFlow';
```

to:

```ts
import { deriveIdpAllowlist, openOauthFlow } from './oauthBrowserFlow';
```

Then append a new `describe('deriveIdpAllowlist', ...)` block at the end of the file (after the existing `describe('openOauthFlow', ...)` block):

```ts
describe('deriveIdpAllowlist', () => {
  test('Feishu preset authorizes open.feishu.cn under feishu.cn', () => {
    const r = deriveIdpAllowlist('https://open.feishu.cn/open-apis/authen/v1/index');
    expect(r.etld1).toBe('feishu.cn');
    // subdomains under feishu.cn must be allowed
    expect(r.allowHosts).toEqual(
      expect.arrayContaining(['feishu.cn', 'open.feishu.cn', 'accounts.feishu.cn']),
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
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run src/main/mcp/oauthBrowserFlow.test.ts`
Expected: the 8 new `deriveIdpAllowlist` tests fail with `deriveIdpAllowlist is not a function`.

- [ ] **Step 3: Implement `deriveIdpAllowlist`**

In `src/main/mcp/oauthBrowserFlow.ts`, add the helper immediately after the `SSO_OAUTH_PARTITION` const (after line 20):

```ts
/**
 * Compute the IdP allowlist for the SSO BrowserWindow's request filter.
 *
 * Returns the registrable domain (eTLD+1) of the IdP's authorizeUrl plus
 * a list of host strings under it. The webRequest listener (installed in
 * openOauthFlow) uses this to cancel requests to third-party hosts — the
 * SSO BrowserWindow is a single-purpose identity surface and must never
 * load Google Analytics, DoubleClick, Bytedance captcha, etc.
 *
 * v1 ships a hardcoded lookup for the 5 v1 IdPs. Custom OIDC / SAML
 * (where the admin provides their own authorizeUrl) falls back to
 * "last two labels" — the admin already knows the IdP's domain and the
 * fallback matches the typical two-label shape (sso.example.com).
 *
 * Always allows `localhost` and `127.0.0.1` for the loopback OAuth callback.
 *
 * On a malformed URL, returns a safe allowlist of just loopback so the
 * request filter cancels everything else with a console.warn.
 */
export function deriveIdpAllowlist(authorizeUrl: string): { etld1: string; allowHosts: string[] } {
  // Hardcoded eTLD+1 lookup for v1 IdPs. The key is the rightmost label
  // (or two labels) of the IdP's host; the value is the registrable
  // domain. Match the longest suffix so future sub-brands (e.g.
  // `intra.feishu.cn` -> `feishu.cn`) keep working.
  const IDP_ETLD1: Record<string, string> = {
    'feishu.cn': 'feishu.cn',
    'microsoftonline.com': 'microsoftonline.com',
    'dingtalk.com': 'dingtalk.com',
    'weixin.qq.com': 'weixin.qq.com',
    'okta.com': 'okta.com',
  };

  let host: string;
  try {
    host = new URL(authorizeUrl).hostname.toLowerCase();
  } catch {
    return { etld1: '', allowHosts: ['localhost', '127.0.0.1'] };
  }
  if (host.startsWith('www.')) host = host.slice(4);

  // Hardcoded eTLD+1 lookup. Match the longest suffix of `host` against
  // the keys (e.g. `open.feishu.cn` -> suffix `feishu.cn` -> `feishu.cn`).
  let etld1 = '';
  for (const suffix of Object.keys(IDP_ETLD1).sort((a, b) => b.length - a.length)) {
    if (host === suffix || host.endsWith('.' + suffix)) {
      etld1 = IDP_ETLD1[suffix]!;
      break;
    }
  }

  // Fallback for custom OIDC: last two labels. e.g.
  // `sso.acme.example.com` -> `example.com`. We deliberately do NOT try
  // to be clever about co.uk / com.au here — those IdPs ship with a
  // custom admin-typed authorizeUrl and the admin knows the domain.
  if (!etld1) {
    const labels = host.split('.');
    etld1 = labels.length >= 2 ? labels.slice(-2).join('.') : host;
  }

  // Build the explicit allowlist: the eTLD+1 itself, and a sample of
  // common subdomains so the listener can match by suffix. The actual
  // matching is done by suffix comparison in the listener, not by
  // equality against this array — this array is for the helper's
  // public contract and for the snapshot test in Step 5.
  const allowHosts = [etld1, host, 'localhost', '127.0.0.1'];
  return { etld1, allowHosts };
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx vitest run src/main/mcp/oauthBrowserFlow.test.ts`
Expected: the 8 new `deriveIdpAllowlist` tests pass.

- [ ] **Step 5: Add the snapshot test against `providerPresets.ts` (pinned to all 3 Feishu URLs)**

The `providerPresets` import must be at the top of the test file (not inline in the test block). Add to the existing import block at the top of `src/main/mcp/oauthBrowserFlow.test.ts`:

```ts
import { PRESETS } from '../../../enterprise_server/src/sso/providerPresets';
```

The path is relative: `src/main/mcp/oauthBrowserFlow.test.ts` → `..` (→ `src/main/`) → `..` (→ `src/`) → `..` (→ repo root) → `enterprise_server/src/sso/providerPresets`. Vitest resolves this at test time; no `tsconfig` change needed.

Then append to the new `describe('deriveIdpAllowlist', ...)` block (inside the test file, alongside the other `deriveIdpAllowlist` tests):

```ts
describe('Feishu preset is fully under feishu.cn', () => {
  test('all 3 Feishu URLs derive to feishu.cn', () => {
    const feishu = PRESETS.feishu!;
    expect(deriveIdpAllowlist(feishu.authorizeUrl).etld1).toBe('feishu.cn');
    expect(deriveIdpAllowlist(feishu.tokenUrl).etld1).toBe('feishu.cn');
    expect(deriveIdpAllowlist(feishu.userinfoUrl).etld1).toBe('feishu.cn');
  });
});
```

This test pins the spec's review focus #7: a future preset edit that moves a Feishu URL to a different eTLD+1 will fail this test, forcing the developer to update the allowlist table.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/main/mcp/oauthBrowserFlow.test.ts`
Expected: all tests pass.

- [ ] **Step 7: Add the failing test — the request filter blocks third-party hosts**

The request filter lives inside `openOauthFlow`, so we need to capture the listener that production code registers on the partition's `webRequest.onBeforeRequest`. We do that by extending the existing `vi.mock('electron', ...)` block at the top of `src/main/mcp/oauthBrowserFlow.test.ts` to also export a `session` mock, then asserting on the captured listener.

**Change 1: declare module-scoped bookkeeping above the `vi.mock` call.** Add (just above the existing `vi.mock('electron', () => {` line):

```ts
// Bookkeeping for the request filter tests. Each call to
// `partition.webRequest.onBeforeRequest(listener)` pushes the
// listener onto `webRequestListeners`; each settle-time call to
// `partition.webRequest.onBeforeRequest(null)` pops the most
// recently-registered listener. After every openOauthFlow settles,
// the live listener count must return to 0.
const webRequestListeners: Array<unknown> = [];
const onBeforeRequestCalls: Array<unknown> = [];
export const __testWebRequest = {
  listeners: webRequestListeners,
  onBeforeRequestCalls,
  reset(): void {
    webRequestListeners.length = 0;
    onBeforeRequestCalls.length = 0;
  },
};
```

The `export` lets the production code (if needed for diagnostics) reference these; tests use `__testWebRequest` directly.

**Change 2: extend the `vi.mock` factory's return value.** In the existing `vi.mock('electron', () => { class MockBrowserWindow { ... } return { ... }; })` block, extend the return object from `{ BrowserWindow: MockBrowserWindow }` to include a `session` field. The factory function captures the module-scoped `webRequestListeners` / `onBeforeRequestCalls` by closure (they are declared above), so the mock can push to them.

Replace the closing `return { BrowserWindow: MockBrowserWindow };` with:

```ts
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
      },
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    })),
  };

  return {
    BrowserWindow: MockBrowserWindow,
    session: sessionMock,
  };
```

The factory now returns both the existing `BrowserWindow` mock and a new `session` mock. Existing tests do not touch `session` and are unaffected.

**Change 3: add the 5 request-filter tests.** Append to `src/main/mcp/oauthBrowserFlow.test.ts` (inside the existing `describe('openOauthFlow', ...)` block, after the last existing test):

The first 4 tests need to inspect the listener while the flow is still open (so `settle` has not yet removed it). We achieve that by using a `probe` that never resolves and disabling all timeouts — the flow stays open until the test calls `lastWindows[…].close()` to release it.

```ts
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
```

- [ ] **Step 8: Run the new tests to verify they fail (the production code does not yet install the listener)**

Run: `npx vitest run src/main/mcp/oauthBrowserFlow.test.ts`
Expected: the 4-5 new request-filter tests fail with `webRequestListeners.length` being 0 (the production code did not install the listener).

- [ ] **Step 9: Install the request filter in `openOauthFlow`**

In `src/main/mcp/oauthBrowserFlow.ts`, two changes:

1. Update the import (line 1):
   ```ts
   import { BrowserWindow, session } from 'electron';
   ```

2. Inside `openOauthFlow`, immediately AFTER the `BrowserWindow` is constructed (line 129) and BEFORE the `authWindow.on('closed', ...)` listener (line 131), add:

```ts
    // Decision 5: install a webRequest filter on the SSO partition that
    // blocks all third-party requests. The SSO BrowserWindow is a
    // single-purpose identity surface — it must never load Google
    // Analytics, DoubleClick, Bytedance captcha, etc. The IdP's
    // authorize page can still load its own resources (under the IdP's
    // eTLD+1) and the loopback callback still works.
    const { etld1 } = deriveIdpAllowlist(authorizeUrl);
    const partitionSession = session.fromPartition(SSO_OAUTH_PARTITION);
    const webRequestListener = (
      details: { url?: string },
      callback: (response: { cancel: boolean }) => void
    ) => {
      const url = details.url ?? '';
      // Pass through non-http(s) schemes (devtools://, chrome-extension://, etc.)
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        callback({ cancel: false });
        return;
      }
      try {
        const reqHost = new URL(url).hostname.toLowerCase();
        // Allow loopback (any port) for the OAuth callback.
        if (reqHost === 'localhost' || reqHost === '127.0.0.1') {
          callback({ cancel: false });
          return;
        }
        // Allow if the host equals the IdP's eTLD+1 or is a subdomain of it.
        if (reqHost === etld1 || reqHost.endsWith('.' + etld1)) {
          callback({ cancel: false });
          return;
        }
        console.warn(`[OAuthFlow] blocked non-IdP request to ${reqHost} in ${title}`);
        callback({ cancel: true });
      } catch {
        // Malformed URL: cancel defensively. This is a request to a
        // junk URL; the user never sees it and there's nothing to do
        // but deny.
        console.warn(`[OAuthFlow] blocked malformed request ${url} in ${title}`);
        callback({ cancel: true });
      }
    };
    partitionSession.webRequest.onBeforeRequest(webRequestListener);
```

3. Inside `settle`, after the existing `clearLoadDeadline();` line (so the listener is always removed even if settle is called via deadline), add:

```ts
      // Decision 5: remove the SSO partition's webRequest filter so we
      // don't leak listeners across calls on the long-lived partition.
      try {
        partitionSession.webRequest.onBeforeRequest(null);
      } catch (error) {
        console.warn(`[OAuthFlow] failed to remove webRequest filter for "${title}":`, error);
      }
```

But `partitionSession` is declared inside the Promise executor scope, so `settle` (which is also inside the executor) can see it via closure. The variable just needs to be declared before the `settle` const, OR `settle` is defined after `partitionSession`. Review the existing file: `settle` is defined at line 106, BEFORE the BrowserWindow construction at line 117. So `partitionSession` (declared at the new code) is after `settle` — but `settle`'s closure body is only invoked LATER (after settle is defined and the executor is set up), so the closure captures the binding, not the value. As long as `partitionSession` is `let`/`const` declared before any settle invocation, it works.

Reorder: declare `let partitionSession: Electron.Session | null = null;` BEFORE `settle`. Then assign it inside the new code block.

Actually, simpler: declare the `partitionSession` const INSIDE the new code block AFTER the BrowserWindow. The `settle` closure reads it via the JavaScript variable-hoisting rules — since `settle` is invoked LATER (after the executor has run), it can see `const`s declared later in the same scope as long as the assignment has happened. To be safe, declare `let partitionSession: ReturnType<typeof session.fromPartition> | null = null;` at the top of the executor body (right after `let settled = false`), then assign it in the new code block, then read it in `settle`.

- [ ] **Step 10: Run the new tests to verify they pass**

Run: `npx vitest run src/main/mcp/oauthBrowserFlow.test.ts`
Expected: all tests pass (the 4-5 new request-filter tests + the 8 `deriveIdpAllowlist` tests + the 1 preset snapshot test + all existing tests).

- [ ] **Step 11: Lint the touched files**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/mcp/oauthBrowserFlow.ts src/main/mcp/oauthBrowserFlow.test.ts src/main/auth/enterpriseClient.ts src/main/auth/enterpriseClient.test.ts src/main/ipcHandlers/enterpriseMt.ts src/main/main.ts`
Expected: clean.

- [ ] **Step 12: Run the broader SSO ecosystem tests to confirm no regression**

Run: `npx vitest run src/main/sso/startSsoMemberBind.test.ts src/main/sso/genericSsoLogin.test.ts src/main/mcp/qichachaMcpAuth.test.ts src/main/mcp/oauthBrowserFlow.test.ts src/main/auth/enterpriseClient.test.ts`
Expected: all pass. `startSsoMemberBind`, `genericSsoLogin`, and `qichachaMcpAuth` mock `openOauthFlow` directly and do not exercise the partition or the listener; the new behavior is invisible to them.

- [ ] **Step 13: Commit**

```bash
git add src/main/mcp/oauthBrowserFlow.ts src/main/mcp/oauthBrowserFlow.test.ts
git commit -m "fix(sso): block third-party requests in SSO BrowserWindow via webRequest allowlist"
```

---

### Task 3: Manual reproducer + final whole-branch review

**Files:**
- Touch: no new files; this task is the integration gate.

**Interfaces:**
- Consumes: the two commits from Tasks 1 and 2.
- Produces: a manual validation result on `npm run electron:dev` (the v2 rebind+relogin scenario no longer SIGSEGVs the app), and a final whole-branch review.

- [ ] **Step 1: Run the broader SSO test suite to confirm no regression**

Run: `npx vitest run src/main/sso/startSsoMemberBind.test.ts src/main/sso/genericSsoLogin.test.ts src/main/mcp/qichachaMcpAuth.test.ts src/main/mcp/oauthBrowserFlow.test.ts src/main/auth/enterpriseClient.test.ts`
Expected: all pass.

- [ ] **Step 2: Manual v2 reproducer (rebind + relogin)**

Run: `npm run electron:dev` on the same machine that reproduced the v2 crash.

1. Log into Enterprise (web). Bind Feishu to user A.
2. On the desktop, log in with "飞书授权登录" (Feishu SSO). Confirm the loopback callback works and the user lands on the desktop home.
3. **Without restarting the desktop**, go back to Enterprise. Unbind Feishu from user A, then rebind Feishu.
4. On the desktop, log out (use the user menu → log out).
5. On the desktop, click "飞书授权登录" again.
6. Expected: the Feishu login page loads. The main process log shows `[OAuthFlow] blocked non-IdP request to …` for the Google Tag Manager / DoubleClick / Google Analytics / Bytedance hosts (the third-party tracking), but the Feishu-owned resources load fine. The OAuth callback to `localhost:5175/callback?code=…` succeeds. The user lands on the desktop home. No SIGSEGV. No 4× `SSL handshake failed; net_error -100` errors in the main process log.

If the second attempt fails, the log should show the `[OAuthFlow] blocked non-IdP request to …` warnings but the Feishu resources (`open.feishu.cn`, `accounts.feishu.cn`, `passport.feishu.cn`) must still load. The Bytedance captcha on the Feishu login page will be blocked — that is the documented v1 limitation; the user sees a captcha failure and can retry. The app must remain alive.

- [ ] **Step 3: Manual v1 reproducer regression check (cancel + retry)**

In the same `npm run electron:dev` session, log out, click "飞书授权登录", force-close the BrowserWindow via Cmd-W at the Feishu authorize step, then click "飞书授权登录" again. Expected: the second attempt loads Feishu cleanly. App stays alive across both attempts. The new request filter does not interfere with Feishu's own resources.

- [ ] **Step 4: Manual password-login regression check**

In the same session, log out and log back in using **username + password** (not Feishu). Expected: password login works exactly as before. The new `webRequest` listener is bound to the SSO partition; password login uses a different code path and is unaffected.

- [ ] **Step 5: Final whole-branch review**

Run: `git log --oneline -5` and `git diff main --stat` to confirm only the two intended commits are in the branch. The diff should be:
- `src/main/mcp/oauthBrowserFlow.ts` (~50 lines: helper + listener install + listener remove)
- `src/main/mcp/oauthBrowserFlow.test.ts` (~150 lines: 8 helper tests + 1 preset snapshot + 5 listener tests)
- `src/main/auth/enterpriseClient.ts` (~10 lines: import + async logout + try/catch)
- `src/main/auth/enterpriseClient.test.ts` (~30 lines: vi.mock + 2 new tests)
- `src/main/ipcHandlers/enterpriseMt.ts` (1 line: `await`)
- `src/main/main.ts` (~5 lines: async IIFE wrap)
- `docs/superpowers/specs/2026-10-14-desktop-sso-sigsegv-resilience-design.md` (already committed before the plan was written)

If the broader test suite (Step 1) shows failures, fix them in a follow-up commit before the final review is considered clean.

---

## Execution Handoff

This plan is small (3 tasks, ~2 commits) and the work is highly cohesive. The two implementation tasks (Tasks 1 and 2) are **independent** at the code level — Task 1 touches `enterpriseClient.ts` + `enterpriseMt.ts` + `main.ts`; Task 2 touches `oauthBrowserFlow.ts`. The test file edits are also disjoint. The recommended execution:

- **Subagent-driven** — one fresh implementer per task, a fresh task-reviewer after each, then one final whole-branch review (Task 3). Three subagents total + two task reviews + one final review. Each implementer has a fresh context with only the relevant spec section, the relevant test mock patterns, and the standing constraints.
- **Native** — implement both tasks in this session, then dispatch one final reviewer on a fresh context.

I recommend **subagent-driven** for this plan: the request filter touches Electron's `webRequest` API whose mock patterns are subtle (the listener-registration/deregistration counter), and a fresh implementer who has not been inside the `openOauthFlow` file for hours is more likely to spot a closure-scope mistake or a missing `try/catch` than a tired in-session implementer.

Whichever approach you choose, the implementer must read the spec end-to-end before writing code, and the task reviewer must be given the spec's Review Focus (both the v1 5-item list and the v2 5-item list at the bottom) as the rubric.
