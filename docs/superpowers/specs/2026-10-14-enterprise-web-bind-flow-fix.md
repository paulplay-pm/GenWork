# Enterprise Web SSO Bind Flow Fix — Design

> **For agentic workers:** This spec fixes a bug in the bind flow of the just-shipped `/account/sso-bindings` page. Read this end-to-end before writing code; the existing `/me/sso-binding/start` and `self_binding` machinery is reused, and the change spans web + server.

## Problem

The enterprise web's "绑定 SSO 账号" page binds via direct navigation to `/auth/sso/:id/authorize?orgName=…` with no `?return=` param. The server's authorize handler defaults `returnTarget` to `'console'`, builds a callback URL pointed at the web's own `/auth/sso/callback`, and does NOT park a `self_binding` context.

Result on callback:
- The `self_binding` branch in `finishCallback` is skipped (no parked context).
- The flow falls through to `resolveUser`, which either JIT-provisions a new user keyed on the IdP's `externalId`, or logs the user in as whichever existing user matches the IdP's `externalId` — NOT the currently-logged-in user who clicked "绑定".
- A user who is already logged in as `alice@acme.com` can come back from the IdP logged in as `bob@acme.com` (whichever user `bob@feishu` belongs to), or as a brand-new JIT-provisioned user.
- The "bind" action effectively becomes a "log in as whoever this IdP identity is" action, with the binding written to the wrong (or new) user's row.

The desktop's bind flow does this correctly: it calls `POST /me/sso-binding/start`, which requires an enterprise JWT, parks a `self_binding` context with the calling `userId`, and the callback's `self_binding` branch writes the binding to that specific user. The web should do the same.

## Goal

When a logged-in enterprise-web user clicks "绑定" on a row, the bind must:
1. Target the **currently-logged-in user only**. No other user may end up bound.
2. Complete without re-prompting for login (the user is already authenticated).
3. Return the user to `/account/sso-bindings` with the binding applied.
4. Reject the bind with a clear error if the IdP's `externalId` is already bound to a different user.
5. Show a "绑定成功" toast on the post-bind page.
6. Show an "授权已取消" toast if the user cancels at the IdP.
7. Show a "该 SSO 账号已绑定其他用户" toast on duplicate-externalId.

## Architecture

Reuse the existing self-binding machinery the desktop already exercises (`/me/sso-binding/start` + `ssoLoginContextStore` `self_binding` kind + `finishCallback` `self_binding` branch). Add a third `returnTarget` value `'web'` that:

- `redirect_uri` = the web's own `/auth/sso/callback` (same as `'console'`).
- Routes the post-bind callback to a **new** server-rendered HTML page that:
  1. Reads the new `self_binding`-branch outcome (success → token; error → error code).
  2. On success: sets the new JWT into `localStorage` via the SPA's `useAuthStore.login()` (window message), sets `sessionStorage.ssoBindJustSucceeded = '1'`, and redirects to `/account/sso-bindings`.
  3. On error (externalId already bound to a different user, or any other self_binding error): sets `sessionStorage.ssoBindError = '<code>'`, redirects to `/account/sso-bindings?error=<code>`.
  4. On IdP error (`?error=access_denied` etc.): redirects to `/account/sso-bindings?error=sso_<idp_error>`.

The page reads `sessionStorage.ssoBindJustSucceeded` and `sessionStorage.ssoBindError` on mount, dispatches the matching toast via the existing `app:showToast` CustomEvent, and clears the flags.

The web's existing `SsoBindingsPage.onBind` currently does `window.location.assign('/auth/sso/{id}/authorize?orgName=...')` directly. After this change, it must instead:
1. `await apiClient.post('/me/sso-binding/start', { connectionId: id, returnTarget: 'web' })` (new param)
2. Receive `{ authorizeUrl }`
3. `window.location.assign(authorizeUrl)`

This requires `/me/sso-binding/start` to accept a `returnTarget` discriminator. Today it only accepts `returnTarget: 'desktop'` (hardcoded at `enterprise_server/src/routes/me/ssoBinding.ts:59-63`).

## Decisions Locked

- **New `returnTarget: 'web'` value** added to the existing `returnTarget: 'console' | 'desktop'` union at:
  - `enterprise_server/src/sso/types.ts:58` (`SsoStateRow.return_target`)
  - `enterprise_server/src/sso/state.ts:19` (`createState` param type)
  - `enterprise_server/src/sso/ssoLoginContext.ts:11` (`SsoLoginContext.returnTarget`)
- **`/me/sso-binding/start` accepts `{ connectionId, returnTarget }`** (default `returnTarget: 'desktop'` for backward compat with the existing desktop caller). When `returnTarget === 'web'`, it sets `redirect_uri = ${origin}/auth/sso/callback` (same as console) and stores the parked `self_binding` context with `returnTarget: 'web'`.
- **A single shared callback URL** at `GET /auth/sso/callback`. The org admin only registers ONE web URL with the IdP (Feishu/Okta/etc.) for the login flow. The web self-binding flow's `redirect_uri` MUST point at this same URL — any second URL would trigger Feishu 20029 "redirect_uri mismatch" on every org that hasn't registered the new URL. The existing `/auth/sso/callback` handler is extended with a `returnTarget === 'web'` branch that renders the post-bind HTML (localStorage token + sessionStorage.ssoBindJustSucceeded + redirect to `/account/sso-bindings`). The pre-bind `returnTarget` is read from the parked `self_binding` context or the consumed state row's `return_target` column.
- **Pre-check before bind**: `SsoBindingsPage.onBind` first checks `GET /me/sso-binding/connections` for the row's `bound` flag (already loaded by `useQuery`). If the user already has any bound row, the bind is allowed. The duplicate-externalId check happens server-side in the `self_binding` branch — we add a `SELECT` before the `UPDATE` to detect "externalId belongs to a different user" and return a distinct error code.
- **Post-bind error codes** (server → sessionStorage → toast):
  - `bind_external_id_exists` — the IdP's externalId is bound to a different user
  - `bind_user_disabled` — the currently logged-in user is disabled
  - `bind_org_mismatch` — the parked context's orgId doesn't match the user's current org
  - `bind_duplicate_race` — concurrent bind won the index
  - `bind_failed` — generic fallback
  - `sso_<idp_error>` — IdP rejected (`access_denied`, etc.)
- **No `?return=` query string** in the bind URL. The discriminator is in the `POST /me/sso-binding/start` body, not the URL. This keeps the `redirect_uri` deterministic for the IdP's registered-app allowlist (a `?return=` change wouldn't be reflected in `redirect_uri` anyway, but the `authorizeUrl` returned by `/me/sso-binding/start` is built once server-side and consumed once client-side, so adding a query param risks IdP mismatch).

## File Layout

### Server

- **Modify** `enterprise_server/src/sso/types.ts:58` — add `'web'` to the `return_target` union.
- **Modify** `enterprise_server/src/sso/state.ts:19` — add `'web'` to the `createState` `returnTarget` type.
- **Modify** `enterprise_server/src/sso/ssoLoginContext.ts:11,16,19` — add `'web'` to all `returnTarget` unions.
- **Modify** `enterprise_server/src/routes/me/ssoBinding.ts:29-80` — accept `returnTarget` body param; when `'web'`, use `${origin}/auth/sso/callback` as `redirect_uri`; park the context with the same `returnTarget`; add the pre-check `SELECT id, status FROM users WHERE sso_connection_id = $1 AND sso_external_id = $2` … wait, the externalId isn't known until the IdP returns it, so the pre-check must live in `finishCallback` not in `/me/sso-binding/start`. **Rethink:** the pre-check is in `finishCallback`'s `self_binding` branch.
- **Modify** `enterprise_server/src/sso/finishCallback.ts:116-176` — the `self_binding` branch:
  - Before the `UPDATE`, run `SELECT id FROM users WHERE sso_connection_id = $1 AND sso_external_id = $2 AND id <> $3 AND org_id = $4` (find any other user bound to the same externalId). If found, return `{ error: 'bind_external_id_exists' }`.
  - Map the existing error returns (`bind_org_mismatch`, `user_disabled`, `sso_binding_duplicate`) to the new `bind_*` codes.
  - On success, return `{ kind: 'web_self_binding_success', token, userId, orgId }` instead of `{ token }` (so the new callback HTML can route correctly).
- **Create** `enterprise_server/src/routes/auth/ssoBindCallback.ts` — the new server-rendered HTML page at `GET /auth/sso/bind-callback` that:
  - Reads `?state`, `?code`, `?error` from the URL.
  - Calls `finishCallback` with the existing `self_binding`-aware logic.
  - On success: emits HTML that calls `window.opener.postMessage({ type: 'ssoBindSuccess', token }, '*')` — but since the original window was a `window.location.assign` (not a popup), the postMessage target is `window.opener` or `window` itself. The simplest mechanism: emit HTML that uses `localStorage.setItem` and `sessionStorage.setItem` then `window.location.replace('/account/sso-bindings')`. The SPA must already be loaded in this tab; if the user opens a new tab, the localStorage/sessionStorage writes happen in the new tab and the original tab's session is unchanged. **Decision:** the bind flow must run in the SAME tab as the page (the page does `window.location.assign` which navigates the current tab — verified by the existing `SsoBindingsPage.tsx:100`). So the callback HTML runs in the same tab; it writes localStorage/sessionStorage then redirects.
  - On error: writes `sessionStorage.ssoBindError = '<code>'` and redirects to `/account/sso-bindings?error=<code>`.
  - On IdP `?error=...`: writes `sessionStorage.ssoBindError = 'sso_<error>'` and redirects to `/account/sso-bindings?error=sso_<error>`.
- **Modify** `enterprise_server/src/server.ts` (or wherever routes are mounted) — mount the new `ssoBindCallback` route.
- **Modify** `enterprise_server/src/sso/consoleCallback.ts` — the existing `renderConsoleCallbackHtml` is reused; add a sibling `renderWebBindCallbackHtml` (or extend the existing one with a `kind` param).

### Web

- **Modify** `enterprise_server/web/src/api/ssoBindings.ts` — add `startSsoBinding(connectionId, returnTarget)` that calls `POST /me/sso-binding/start` with `{ connectionId, returnTarget: 'web' }` and returns the `authorizeUrl`.
- **Modify** `enterprise_server/web/src/pages/account/SsoBindingsPage.tsx:95-101` — change `onBind`:
  ```ts
  const startBind = useMutation({
    mutationFn: (id: string) => startSsoBinding(id, 'web'),
    onSuccess: (j) => { window.location.assign(j.authorizeUrl); },
    onError: (e) => { showToast(t('ssoBindings.bindError').replace('{error}', e instanceof Error ? e.message : String(e)), 'error'); },
  });
  ```
  Bind button now calls `startBind.mutate(c.id)`.
- **Modify** `enterprise_server/web/src/pages/account/SsoBindingsPage.tsx` (mount-time) — on mount, check `sessionStorage.ssoBindJustSucceeded` → toast "绑定成功" + clear; check `window.location.search` for `?error=...` → toast + clean URL.
- **Modify** `enterprise_server/web/src/i18n.ts` — add 4 keys (1 success, 1 duplicate, 1 cancel, 1 generic bind error in zh + en = 8 entries):
  - `ssoBindings.bindSucceeded: '绑定成功'` / `'Bound'`
  - `ssoBindings.bindErrorExternalIdExists: '该 SSO 账号已绑定其他用户'` / `'This SSO account is already bound to another user'`
  - `ssoBindings.bindErrorCancelled: '授权已取消'` / `'Authorization cancelled'`
  - `ssoBindings.bindErrorGeneric: '绑定失败：{error}'` (likely already covered by `bindError`, reuse if so)

### Tests

- **Server:** add tests for the new `returnTarget: 'web'` flow:
  - `/me/sso-binding/start` with `returnTarget: 'web'` returns `authorizeUrl` whose `redirect_uri` is the web's `/auth/sso/callback` (not the desktop loopback).
  - The parked context's `returnTarget` is `'web'`.
  - `finishCallback` self_binding branch with an externalId already bound to a different user returns `bind_external_id_exists` and does NOT mutate any user's `users.sso_*` columns.
  - `finishCallback` self_binding branch with the same externalId already bound to the SAME user (overwrite case) succeeds and updates the row.
  - `GET /auth/sso/bind-callback` with `?error=access_denied` from the IdP returns HTML that sets `sessionStorage.ssoBindError = 'sso_access_denied'` and redirects to `/account/sso-bindings?error=sso_access_denied`.
  - `GET /auth/sso/bind-callback` with successful state+code returns HTML that sets `localStorage[genwork.enterprise.auth.token]`, `sessionStorage.ssoBindJustSucceeded = '1'`, and redirects to `/account/sso-bindings`.
- **Web:** update `SsoBindingsPage.test.tsx`:
  - Test 10 (click 绑定 → assign) must change: instead of asserting `assignSpy` was called with `/auth/sso/c2/authorize?orgName=Acme`, assert that:
    - `apiClient.post('/me/sso-binding/start', { connectionId: 'c2', returnTarget: 'web' })` was called.
    - After the post resolves, `assignSpy` was called with the returned `authorizeUrl`.
  - Add 3 new tests:
    - Mount with `sessionStorage.ssoBindJustSucceeded = '1'` → toast "绑定成功" dispatched, sessionStorage cleared.
    - Mount with `?error=bind_external_id_exists` in URL → toast "该 SSO 账号已绑定其他用户" dispatched, URL cleaned.
    - Mount with `?error=sso_access_denied` in URL → toast "授权已取消" dispatched, URL cleaned.

## Review Focus (5 input classes most likely to bite)

1. **Reusing the same JWT after bind** — the post-bind callback must set the new token in the SAME `useAuthStore` instance the page reads from. Because the callback HTML runs in the same tab (via `window.location.replace`), `localStorage` write + `window.location.replace` to `/account/sso-bindings` triggers a full page reload, which re-initializes `useAuthStore` from `localStorage` (see `auth/store.ts:readStoredSession`). **Pinned by:** the new test "GET /auth/sso/bind-callback success → HTML writes localStorage token and redirects" + the new web test "after bind, useAuth reflects the new token's claims".
2. **`returnTarget: 'web'` typing** — every site that reads `returnTarget` must handle the new `'web'` value. If any site defaults to `'desktop'`-specific behavior, the web flow will silently fail. **Pinned by:** the type-union expansion test (compile-time) + a runtime test that the callback's `returnTarget` matches what the `/me/sso-binding/start` body specified.
3. **ExternalId already bound to the SAME user (overwrite)** — the new pre-check must NOT block this. Pre-check returns `bind_external_id_exists` only if `id <> $currentUserId`. **Pinned by:** the server test "overwrite case succeeds".
4. **IdP callback order** — the page's `useEffect` reading `sessionStorage` must run AFTER the page's TanStack Query for `/me/sso-binding/connections` resolves (so the refetch picks up the new bind) AND before the user can see the old state. **Pinned by:** the test "sessionStorage flag triggers toast + page refetches" (the existing `refetchOnMount: 'always'` already ensures the refetch).
5. **Token rotation** — when the bind completes, the user gets a NEW token (the existing self_binding branch in `finishCallback` issues one). The new token's `sub`/`orgId` is unchanged, but `exp` is fresh. The callback must write the new token to localStorage, not preserve the old one. **Pinned by:** the new test "callback HTML writes the new token, not the old one" (verified by checking the response body's HTML contains the new JWT).

## Ruling 20 — single shared callback URL (2026-10-14 post-shipment fix)

The original plan called for a new `GET /auth/sso/bind-callback` route to sidestep the `returnTarget === 'desktop' | === 'console'` branches in `sso.ts` (Ruling 19's concern). After shipping, the Feishu integration surfaced a regression: the new URL was never registered in the org admin's Feishu developer console, so every bind attempt failed with Feishu error **20029 "redirect_uri 不匹配"** (the admin only registered `${origin}/auth/sso/callback` for the login flow, and Feishu rejects any redirect_uri that is not on the registered allowlist).

**Fix:** drop the new route; the web self-binding flow's `redirect_uri` is `${origin}/auth/sso/callback` (same as the console flow). The existing `/auth/sso/callback` handler is extended with a `returnTarget === 'web'` branch that reads the parked `self_binding` context's `returnTarget` and renders the post-bind HTML (localStorage token + `sessionStorage.ssoBindJustSucceeded` + redirect to `/account/sso-bindings`). The `web_self_binding_success` shape from `finishCallback` is the discriminator. **This also closes Ruling 19's gap directly** (the existing branches now have explicit `returnTarget === 'web'` handling) rather than routing around it. The page-side code (mount-time `useEffect`, i18n keys) is unchanged.

**Cost if wrong:** the Feishu allowlist was the actual issue, not the route design. If a future IdP requires a separate URL per flow, the design reverses back to a dedicated route and the org admin must register that URL.

## Out of Scope (explicit non-goals for v2)

- Server support for `?return=desktop` in the bind URL (the `returnTarget` goes through `POST /me/sso-binding/start` body, not the URL — see Decisions).
- A "Bind from the admin user-detail page" feature (admin binding uses a different path; out of scope).
- Pre-checking the externalId BEFORE the IdP redirect (impossible — we don't know the externalId until the IdP returns it).
- A "switch user" feature that lets the admin bind an SSO identity to a different user (the explicit "no" answer from the user).
- Visual snapshot changes (no UI changes that would require new baselines; the page render is unchanged).
