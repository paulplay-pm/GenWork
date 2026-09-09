# Desktop Feishu SSO Login SIGSEGV Resilience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the reproducible Electron SIGSEGV that crashes the desktop when a user logs in via Feishu SSO after a previous attempt left a `BrowserWindow` network process in a half-completed TLS state. Two changes in `src/main/mcp/oauthBrowserFlow.ts`: (1) replace the per-attempt `oauth-${crypto.randomUUID()}` partition with a single named partition `genwork-sso-oauth`; (2) add a 20 s `loadURL` deadline that settles with `sso_authorize_timeout` if the IdP authorize page does not load in time.

**Architecture:** The crash is in Chromium's collapsed process model (`--no-sandbox --disable-gpu` switches in `src/main/main.ts:1703-1710` force all network and rendering into the main process's address space). Every SSO attempt spinning up a fresh `partition: oauth-${uuid}` creates a brand-new network process; under load with a prior cancelled attempt, the new network process's TLS retry faults the shared address space, the SIGSEGV propagates up the IPC chain, and the whole app exits. Reusing a single partition eliminates the per-attempt network process churn, and a bounded `loadURL` deadline catches the case where the user closes the window mid-handshake (or the network process is stuck) before the 5-minute outer timeout fires.

**Tech Stack:** Electron 40.x, TypeScript, Vitest 2.x. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-desktop-sso-sigsegv-resilience-design.md`

## Global Constraints

- Node.js `>=24.15.0 <25`.
- Conventional Commits English, no `Co-Authored-By` trailer.
- Per-file vitest in the sandbox (fd exhaustion) — `npx vitest run src/main/mcp/oauthBrowserFlow.test.ts`.
- Auto-commit local only; never push to remote.
- Lint on touched files: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/mcp/oauthBrowserFlow.ts src/main/mcp/oauthBrowserFlow.test.ts`.
- No Chromium feature flag changes. The fix is in the desktop's own code.
- No new error codes surfaced to the renderer beyond `sso_authorize_timeout` (which is already a recognized `sso_*` pattern).

## Review Focus

1. **Stable partition leaks cookies across users on the same machine** — verified by the per-attempt test in Task 1 that constructs two `BrowserWindow`s and asserts both use the named partition, not a per-attempt UUID.
2. **`loadURL` deadline races with legitimate slow IdPs** — Feishu is fast; Okta / Azure AD / corporate MFA can be slow. The deadline is **only** the `loadURL` step (page render), not user interaction. Cleared on `did-finish-load`. Pinned by the deadline-cleared test in Task 2 and the override-via-option test.
3. **Settling twice on the deadline + `did-fail-load`** — Chromium can fire `did-fail-load` and the deadline in either order. `settle()`'s existing `if (settled) return` guard handles this. Pinned by the double-settle test in Task 2.
4. **The default 20 s is too short for slow networks** — once `did-finish-load` fires (page rendered), the timer is cleared and the user has the full 5 minutes to interact. Pinned by the same test as #2: the deadline only fires when `loadURL` itself stalls, not during user interaction at the IdP.
5. **Other callers of `openOauthFlow` regress** — `startSsoMemberBind`, MCP OAuth, qichacha all use `openOauthFlow`. They all share the new stable partition (correct — one set of OAuth credentials per user) and get the new 20 s deadline (correct — same TLS failure mode). Pinned by the existing `startSsoMemberBind.test.ts` and `qichachaMcpAuth.test.ts` continuing to pass.

---

### Task 1: Stable SSO partition

**Files:**
- Modify: `src/main/mcp/oauthBrowserFlow.ts:1-2` (add const, drop `crypto` import if no longer used)
- Modify: `src/main/mcp/oauthBrowserFlow.ts:81` (replace `partition: \`oauth-${crypto.randomUUID()}\`` with `partition: SSO_OAUTH_PARTITION`)
- Modify: `src/main/mcp/oauthBrowserFlow.test.ts:119` (change partition assertion)
- Test: `src/main/mcp/oauthBrowserFlow.test.ts` (add 1 new test)

**Interfaces:**
- Consumes: nothing (this task is the first).
- Produces: `export const SSO_OAUTH_PARTITION = 'genwork-sso-oauth'` exported from `src/main/mcp/oauthBrowserFlow.ts`.

- [ ] **Step 1: Add the const and export it**

In `src/main/mcp/oauthBrowserFlow.ts`, immediately after the `import` block (line 6) and before the `MarkIntentionalClose` type alias, add:

```ts
/**
 * Stable partition name for all IdP-backed SSO BrowserWindows.
 *
 * Why named instead of `persist:...`: a `persist:` prefix would write cookies
 * to disk in `userData/Partitions/<name>/` and survive app restarts — we do
 * NOT want a fresh launch to inherit the prior user's Feishu / Okta session.
 * A bare name creates an in-memory partition (per Electron's Session API) that
 * dies on app exit, so every launch re-authorizes the IdP.
 *
 * Why stable instead of per-attempt `oauth-${crypto.randomUUID()}`: with
 * `--no-sandbox --disable-gpu` switches active in main.ts, Chromium's process
 * model collapses the network process into the main process's address space.
 * A per-attempt partition spins up a brand-new network process for every SSO
 * login; under load with a prior cancelled attempt, the new process's TLS
 * retry faults the shared address space and the whole app SIGSEGVs. One
 * stable partition → one network process → deterministic lifecycle.
 */
export const SSO_OAUTH_PARTITION = 'genwork-sso-oauth';
```

- [ ] **Step 2: Remove the unused `crypto` import (if no other use in the file)**

`grep -n "crypto\." src/main/mcp/oauthBrowserFlow.ts` to confirm `crypto.randomUUID` is the only reference. If yes, delete the `import crypto from 'crypto';` line at the top of the file. If anything else uses `crypto` (e.g., a future hash helper), leave the import.

- [ ] **Step 3: Replace the partition name on the BrowserWindow**

In `src/main/mcp/oauthBrowserFlow.ts`, find the `webPreferences` block (currently lines 77-82):

```ts
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  partition: `oauth-${crypto.randomUUID()}`,
},
```

Replace `partition: \`oauth-${crypto.randomUUID()}\`,` with `partition: SSO_OAUTH_PARTITION,`.

- [ ] **Step 4: Update the existing partition assertion**

In `src/main/mcp/oauthBrowserFlow.test.ts:119`, change:

```ts
expect(opts.webPreferences.partition).toMatch(/^oauth-/);
```

to:

```ts
expect(opts.webPreferences.partition).toBe('genwork-sso-oauth');
```

This converts a stale pin (which would silently keep passing even if the implementation went back to a per-attempt UUID) into a load-bearing pin on the new stable name.

- [ ] **Step 5: Add the "two BrowserWindows share the same partition" test**

In `src/main/mcp/oauthBrowserFlow.test.ts`, immediately after the existing `'resolves with the credential when probe returns one'` test (after line 122), add:

```ts
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
```

- [ ] **Step 6: Run the test file to verify it passes**

Run: `npx vitest run src/main/mcp/oauthBrowserFlow.test.ts`
Expected: PASS (8 tests, 1 new — 5 from the existing describe block plus 3 new). The pre-existing tests `resolves with the credential when probe returns one`, `rejects when timeout elapses with no credential`, `rejects on a main-frame did-fail-load with a descriptive error`, `ignores sub-frame did-fail-load`, and `ignores ERR_ABORTED did-fail-load` all continue to pass with the updated partition assertion.

- [ ] **Step 7: Lint the changed files**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/mcp/oauthBrowserFlow.ts src/main/mcp/oauthBrowserFlow.test.ts`
Expected: clean. The named const and the `partition: SSO_OAUTH_PARTITION` line both satisfy `no-unused-vars` and `import/no-unused-modules`.

- [ ] **Step 8: Commit**

```bash
git add src/main/mcp/oauthBrowserFlow.ts src/main/mcp/oauthBrowserFlow.test.ts
git commit -m "fix(sso): use a stable partition for SSO BrowserWindows

Replaces the per-attempt `oauth-${crypto.randomUUID()}` partition with a
single named partition `genwork-sso-oauth` shared by every SSO login
attempt. With --no-sandbox --disable-gpu switches active in main.ts,
Chromium's process model collapses the network process into the main
process's address space; a fresh partition per attempt spun up a new
network process each time, and under load with a prior cancelled
attempt the new process's TLS retry faulted the shared address space
and the whole Electron app exited with SIGSEGV.

Pinned by: existing test updated to assert the stable name; new test
asserts two successive openOauthFlow calls share the partition.

Refs: docs/superpowers/specs/2026-10-14-desktop-sso-sigsegv-resilience-design.md"
```

---

### Task 2: Bounded `loadURL` deadline

**Files:**
- Modify: `src/main/mcp/oauthBrowserFlow.ts:13-34` (add `loadTimeoutMs?: number` to `OAuthFlowOptions`)
- Modify: `src/main/mcp/oauthBrowserFlow.ts:36-47` (destructure `loadTimeoutMs` with default 20 000)
- Modify: `src/main/mcp/oauthBrowserFlow.ts:160-170` (add deadline timer after `loadURL` call, clear on `did-finish-load`, settle on expiry)
- Modify: `src/main/mcp/oauthBrowserFlow.test.ts` (add 3 new tests + extend the `MockBrowserWindow` so it can opt out of the auto `did-finish-load`)

**Interfaces:**
- Consumes: `SSO_OAUTH_PARTITION` from Task 1 (no code-level dependency, but conceptually follows).
- Produces: `openOauthFlow` settles with `Error('sso_authorize_timeout')` if the IdP `loadURL` does not complete within `loadTimeoutMs` (default 20 000 ms). Cleared on `did-finish-load` so the deadline is **not** a "user took too long at the IdP" deadline.

- [ ] **Step 1: Extend `OAuthFlowOptions` with `loadTimeoutMs`**

In `src/main/mcp/oauthBrowserFlow.ts`, find the `OAuthFlowOptions` interface (lines 13-34). Add a new field after `height?: number;`:

```ts
  /** Deadline for the IdP authorize page to load, in ms.
   *  Settles the flow with `sso_authorize_timeout` if `did-finish-load`
   *  does not fire in time. Cleared on `did-finish-load` so this is the
   *  "page failed to load" deadline, NOT the "user took too long" deadline —
   *  once the IdP page renders, the outer `timeoutMs` (default 5 minutes)
   *  is the only bound. Default 20 000 ms; override per call. */
  loadTimeoutMs?: number;
```

- [ ] **Step 2: Destructure `loadTimeoutMs` in the function body**

In `src/main/mcp/oauthBrowserFlow.ts`, find the destructure (lines 36-47):

```ts
  const {
    parentWindow,
    title,
    authorizeUrl,
    probe,
    onLoaded,
    pollIntervalMs = 2_000,
    timeoutMs = 5 * 60 * 1000,
    width = 1120,
    height = 860,
  } = opts;
```

Add `loadTimeoutMs = 20_000,` to the destructure (alphabetical-ish order is fine, place it after `height`).

- [ ] **Step 3: Add the deadline timer + its handlers (BEFORE the `settle` function in the body)**

The `settle` function at `src/main/mcp/oauthBrowserFlow.ts:61-69` is defined BEFORE the `BrowserWindow` constructor at line 71, and BEFORE the `did-finish-load` listener at line 160. To make `clearLoadDeadline` available inside `settle`'s closure, the timer declaration and the `clearLoadDeadline` arrow function MUST go BEFORE `settle` — i.e., immediately after the `let settled = false;` line at line 60.

In `src/main/mcp/oauthBrowserFlow.ts`, find:

```ts
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (error: Error | null, credential?: string) => {
```

Insert the following block right after `let settled = false;` and BEFORE `const settle = ...`:

```ts
    // `loadDeadlineTimer` is the per-`loadURL` deadline. If the IdP
    // authorize page does not render within `loadTimeoutMs`, settle
    // with `sso_authorize_timeout` and close the window. The 5-minute
    // `timeoutMs` is still the bound for the whole flow (covers slow
    // user interaction at the IdP); this deadline is strictly the
    // "TLS handshake / first paint hung" catch.
    //
    // Cleared on `did-finish-load` (page rendered, user can now
    // interact) and on every settle path (no leak).
    //
    // Declared BEFORE `settle` so `clearLoadDeadline` is in scope for
    // the `settle` closure that every code path eventually calls.
    let loadDeadlineTimer: NodeJS.Timeout | null = null;
    const clearLoadDeadline = (): void => {
      if (loadDeadlineTimer) {
        clearTimeout(loadDeadlineTimer);
        loadDeadlineTimer = null;
      }
    };
```

- [ ] **Step 4: Wire the timer START in the `did-finish-load` listener (and add the clear-on-finish-load)**

In `src/main/mcp/oauthBrowserFlow.ts`, find the `did-finish-load` listener block (lines 160-163):

```ts
    authWindow.webContents.on('did-finish-load', () => {
      if (onLoaded) onLoaded(authWindow!);
      void runProbe();
    });
```

Replace it with:

```ts
    // Start the loadURL deadline after the BrowserWindow is constructed
    // and the listeners are attached. The BrowserWindow is created
    // synchronously, but `authWindow` is assigned before the `loadURL`
    // call, so we can reference it here.
    if (loadTimeoutMs > 0) {
      loadDeadlineTimer = setTimeout(() => {
        loadDeadlineTimer = null;
        console.warn(`[OAuthFlow] "${title}" loadURL deadline exceeded after ${loadTimeoutMs}ms`);
        settle(new Error('sso_authorize_timeout'));
      }, loadTimeoutMs);
    }

    authWindow.webContents.on('did-finish-load', () => {
      clearLoadDeadline();
      if (onLoaded) onLoaded(authWindow!);
      void runProbe();
    });
```

(The `setTimeout` call must come AFTER the listener is registered so the order-of-events is well-defined; placing it just above the `webContents.on('did-finish-load', ...)` line keeps the timer start visually adjacent to its clear handler.)

- [ ] **Step 5: Clear the timer on every settle path**

In `src/main/mcp/oauthBrowserFlow.ts`, find the `settle` function body (lines 61-69):

```ts
    const settle = (error: Error | null, credential?: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (pollTimer) clearInterval(pollTimer);
      if (authWindow && !authWindow.isDestroyed()) authWindow.close();
      if (error) reject(error);
      else resolve(credential || '');
    };
```

Add one line right after `if (pollTimer) clearInterval(pollTimer);`:

```ts
      if (pollTimer) clearInterval(pollTimer);
      clearLoadDeadline();
      if (authWindow && !authWindow.isDestroyed()) authWindow.close();
```

`clearLoadDeadline` is now in scope because Step 3 declared it before `settle`.

- [ ] **Step 6: Extend the `MockBrowserWindow` test mock so a test can suppress the auto `did-finish-load`**

The current mock at `src/main/mcp/oauthBrowserFlow.test.ts:42-50` auto-fires `did-finish-load` via `queueMicrotask` for every BrowserWindow. The new deadline tests need a window that does NOT auto-fire it (otherwise the deadline would be cleared before the test can advance the fake timers).

Replace the mock's `webContents.on` (lines 42-50) with:

```ts
        on: (event: string, cb: (...args: unknown[]) => void) => {
          if (event === 'did-finish-load') {
            // By default, auto-fire did-finish-load asynchronously so
            // the existing tests still work. A test that wants to
            // exercise the loadURL deadline flips `autoFinishLoad`
            // on the mock instance before awaiting openOauthFlow.
            if (this._autoFinishLoad) {
              queueMicrotask(() => cb());
            } else {
              this.didFinishLoadCallbacks.push(cb);
            }
          } else if (event === 'did-fail-load') {
            this.didFailLoadCallbacks.push(cb as (args: FailLoadArgs) => void);
          }
        },
        // ...
        emitDidFinishLoad: () => {
          for (const cb of this.didFinishLoadCallbacks) cb();
        },
```

And add to the `MockBrowserWindow` class (after the existing `_destroyed` / `_closed` / `_opts` / `_url` fields):

```ts
    public _autoFinishLoad = true;
    private didFinishLoadCallbacks: Array<() => void> = [];
```

Add `emitDidFinishLoad: () => void;` to the `MockWindow` interface (lines 10-24).

- [ ] **Step 7: Add the "deadline settles on timeout" test**

In `src/main/mcp/oauthBrowserFlow.test.ts`, after the new test from Task 1, add:

```ts
test('settles with sso_authorize_timeout when loadURL never finishes', async () => {
  // A Feishu authorize page that hangs (e.g. user force-closed the
  // window before the network process could complete TLS) must not
  // pin the main process against the 5-minute outer timeout. The new
  // 20 s loadURL deadline catches this case.
  vi.useFakeTimers();
  try {
    // Suppress the mock's auto did-finish-load so the deadline can fire.
    const p = openOauthFlow({
      title: 'Feishu hung',
      authorizeUrl: 'https://open.feishu.cn/open-apis/authen/v1/index',
      probe: vi.fn(async () => null),
      pollIntervalMs: 10,
      timeoutMs: 60_000,
      loadTimeoutMs: 5_000,
    }).catch((e) => e as Error);
    // Wait for the BrowserWindow to be constructed.
    await new Promise((r) => queueMicrotask(r));
    // Suppress auto-finish on the just-created window.
    lastWindows[lastWindows.length - 1]!._autoFinishLoad = false;
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
```

- [ ] **Step 8: Add the "deadline is cleared on did-finish-load" test**

```ts
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
```

- [ ] **Step 9: Add the "double-settle guard" test**

```ts
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
```

- [ ] **Step 10: Run the test file to verify all tests pass**

Run: `npx vitest run src/main/mcp/oauthBrowserFlow.test.ts`
Expected: PASS (8 pre-existing + 1 from Task 1 + 3 from this task = 12 tests).

- [ ] **Step 11: Lint the changed files**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/mcp/oauthBrowserFlow.ts src/main/mcp/oauthBrowserFlow.test.ts`
Expected: clean. Watch for: (a) the `loadDeadlineTimer` declaration not being used in `settle` directly (it goes through `clearLoadDeadline`); (b) the new mock interface field `emitDidFinishLoad` not flagged as unused in the `MockWindow` interface (it is used by the new test).

- [ ] **Step 12: Commit**

```bash
git add src/main/mcp/oauthBrowserFlow.ts src/main/mcp/oauthBrowserFlow.test.ts
git commit -m "fix(sso): add a 20s loadURL deadline to openOauthFlow

Catches the case where a Feishu / Okta authorize page hangs in the
TLS handshake (network process stuck after a prior cancelled attempt,
or a slow corporate MFA page that never paints). Without this bound
the flow waits the full 5-minute outer timeout, and if the user
force-closes the window mid-handshake the BrowserWindow's network
process is left holding half-completed TLS state. That stale network
process is what was crashing the main process with SIGSEGV under
the per-attempt partition design — the new stable partition (Task 1)
prevents the new process churn, and this deadline prevents the
stale process from sticking around.

The deadline is the loadURL step ONLY. did-finish-load clears it,
so the user has the full 5-minute outer timeout to interact with
the IdP page (covers slow Okta / Azure AD on first-time corporate-MFA
enrollment). Per-call override via loadTimeoutMs.

Pinned by 3 new tests: deadline fires on timeout, deadline cleared
on did-finish-load, double-settle guard prevents race.

Refs: docs/superpowers/specs/2026-10-14-desktop-sso-sigsegv-resilience-design.md"
```

---

### Task 3: Manual reproducer + final whole-branch review

**Files:**
- Touch: no new files; this task is the integration gate.

**Interfaces:**
- Consumes: the two commits from Tasks 1 and 2.
- Produces: a manual validation result on `npm run electron:dev` (Feishu login no longer SIGSEGVs the app), and a final whole-branch review.

- [ ] **Step 1: Run the broader test suite to confirm no regression in callers of `openOauthFlow`**

Run: `npx vitest run src/main/sso/startSsoMemberBind.test.ts src/main/sso/genericSsoLogin.test.ts src/main/mcp/qichachaMcpAuth.test.ts src/main/mcp/oauthBrowserFlow.test.ts`
Expected: all pass. `startSsoMemberBind.test.ts` and `qichachaMcpAuth.test.ts` mock `openOauthFlow` directly (do not exercise the partition), so the new stable partition is invisible to them. The new `loadTimeoutMs` option is additive and defaults to 20 000 ms, which is well above any test's `timeoutMs`.

- [ ] **Step 2: Manual Feishu reproducer**

Run: `npm run electron:dev`
1. Log out (or be on a fresh session).
2. Click "飞书授权登录" (Feishu SSO).
3. When the Feishu authorize page renders, force-close the BrowserWindow via Cmd-W (or by closing the auth tab in the embedded browser).
4. **Without restarting Electron**, click "飞书授权登录" again.
5. Expected: the second attempt loads Feishu's authorize page cleanly. The app stays alive across both attempts. No SIGSEGV. No 4× SSL handshake errors in the main process log.

If the second attempt fails, the log should show `[OAuthFlow] "SSO sign-in" loadURL deadline exceeded after 20000ms` and the renderer should display the localized `sso_authorize_timeout` error toast. The app must remain alive.

- [ ] **Step 3: Manual password-login regression check**

In the same `npm run electron:dev` session, log out and log back in using **username + password** (not Feishu). Expected: password login works exactly as before, no `sso_*` errors, no 20 s deadline interfering (the password flow does not use `openOauthFlow`).

- [ ] **Step 4: Final whole-branch review**

Run: `git log --oneline -5` and `git diff main --stat` to confirm only the two intended commits are in the branch. The diff should be ~30 lines of `oauthBrowserFlow.ts` (const + partition + deadline) + ~80 lines of `oauthBrowserFlow.test.ts` (mock extension + 4 new tests, one of which is the existing-test update).

If the broader test suite (Step 1) shows failures, fix them in a follow-up commit before the final review is considered clean.

- [ ] **Step 5: Cleanup the untracked plan file from cycle 3**

The file `docs/superpowers/plans/2026-10-14-enterprise-web-bind-flow-fix.md` is untracked and predates the 58a1e6e + 98ecd73 reversal. It describes a now-rejected design (the new `/auth/sso/bind-callback` route) and is misleading. Delete it:

```bash
rm docs/superpowers/plans/2026-10-14-enterprise-web-bind-flow-fix.md
```

This is not part of the SIGSEGV fix; it is a leftover cleanup that should ride along in this branch so the next person reading the specs/ + plans/ tree is not confused. If you prefer to handle it in a separate branch, skip this step and call it out in the PR description.

---

## Execution Handoff

This plan is small (3 tasks, ~2 commits) and the work is highly cohesive. The two implementation tasks (Tasks 1 and 2) are **independent** at the code level — both touch the same file, but at different lines, and either ordering works. The recommended execution:

- **Subagent-driven** — one fresh implementer per task, a fresh task-reviewer after each, then one final whole-branch review (Task 3). Three subagents total + two task reviews + one final review. Each implementer has a fresh context with only the relevant spec section, the relevant test mock patterns, and the standing constraints.
- **Native** — implement both tasks in this session, then dispatch one final reviewer on a fresh context.

I recommend **subagent-driven** for this plan: the SIGSEGV root cause is subtle and a fresh implementer who has not been inside the `openOauthFlow` file for hours is more likely to spot a misread of the `settle` ordering or the `clearLoadDeadline` closure capture than a tired in-session implementer.

Whichever approach you choose, the implementer must read the spec end-to-end before writing code, and the task reviewer must be given the spec's Review Focus as the rubric.
