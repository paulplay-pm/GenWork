# Enterprise Web: SSO 账号绑定 Self-Service Page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror the desktop's "SSO 账号绑定" page 1:1 in the enterprise web (`enterprise_server/web/`) as a top-level route so a logged-in user can see their org's enabled SSO connections, see which one they're bound to, bind an unbound one, or unbind the bound one — without going through the avatar-menu modal.

**Architecture:** New top-level route `/account/sso-bindings` mounted inside `<Shell>` + `<AuthGuard>` (no role requirement — every authenticated user can manage their own bindings). The list comes from the server's existing `GET /me/sso-binding/connections` endpoint (added in the desktop plan). Bind uses direct navigation to the server's existing `/auth/sso/:id/authorize?orgName=…` route (web returnTarget = the server callback, which binds the user and 302s back). Unbind uses the server's existing `DELETE /me/sso-binding` endpoint.

**Tech Stack:** React 19 + Vite 7 + TypeScript + TanStack Query v5 + react-router-dom v7 + Tailwind v4 + the web's existing `src/i18n.ts` flat-dotted-key en+zh dict. Same conventions as the rest of the web (e.g. `pages/sso/SSOConnectionsPage.tsx`, `pages/sso/SSOConnectionDrawer.tsx`).

**Spec companions:**
- Desktop plan: `docs/superpowers/plans/2026-10-13-sso-binding-management-page.md`
- Desktop spec: `docs/superpowers/specs/2026-10-13-sso-binding-management-page-design.md`
- Server endpoint (already shipped): `enterprise_server/src/routes/me/ssoBinding.ts`

## Global Constraints

- Node.js `>=24.15.0 <25`.
- TypeScript: `tsc --project enterprise_server/web/tsconfig.json` must pass (the web's build runs `tsc && vite build` per `enterprise_server/web/package.json:7`).
- Tests: Vitest 2.x in jsdom (`enterprise_server/web/vite.config.ts:49-56` — `include: tests/**/*.{test.ts,test.tsx}, src/**/*.{test.ts,test.tsx}`); per-feature test file under `tests/` or `src/`.
- Visual baseline: Playwright (`enterprise_server/web/playwright.config.ts:1-31`); new snapshot at `tests/visual/sso-bindings.spec.ts`.
- **No ESLint config exists in the web repo** (verified). The web's quality gates are `tsc` + `playwright test`; the spec must not assume a linter output. Cosmetic-only changes (the missing-space pattern flagged in desktop Rulings 3, 6) are not gated here.
- **No `CLAUDE.md` / `AGENTS.md`** in the web repo (verified). Per-file header comments are the only convention doc.
- **No server changes** — all data comes from existing endpoints.
- i18n: flat dotted keys in BOTH `en` and `zh` dicts (`web/src/i18n.ts`). No pluralization helpers; `{n}` / `{count}` / `{account}` / `{error}` / `{date}` are substituted by the consumer (the codebase's `i18n.t(key).replace('{name}', value)` pattern, used 10+ times in `Settings.tsx` per the desktop-side Ruling 13 fix).
- Conventional Commits English, no `Co-Authored-By` trailer. No push to remote.
- i18n sync zh + en.
- String constants centralized (`as const`).

## What This Plan Reuses From the Desktop Plan (Verbatim, No Server Changes)

| Artifact | Source | Used by web page as |
|---|---|---|
| `GET /me/sso-binding/connections` | `enterprise_server/src/routes/me/ssoBinding.ts:106-149` (added in desktop Task 1) | Page list query |
| `DELETE /me/sso-binding` | `enterprise_server/src/routes/me/ssoBinding.ts:82-102` (added in desktop Task 1) | Unbind action |
| `SsoConnectionWithBinding` type | `enterprise_server/src/sso/bindingTypes.ts:15-27` (added in desktop Task 1) | Row type, redeclared at `web/src/api/ssoBindings.ts:1-30` to avoid server-import boundary (precedent: `web/src/api/me.ts:8-15` redeclares server's `MeProfile` shape) |
| 8-field row shape (no `description` / `boundAt` per Rulings 1+2) | desktop plan ruling | Row rendering |
| 23 i18n keys `ssoBindings.*` | desktop Task 8 (zh + en) | Page labels |
| `sso.profile.bindMenuItem` | desktop Task 8 (zh + en); was already in `enterprise_server/web/src/i18n.ts:1216` per the explore grep | Avatar menu label (unchanged) |
| `logoUrl` is absolute URL | server `resolveProviderLogoUrl` (`me/ssoBinding.ts:144`) | `<img src>` (no base-url rebuild) |

## What This Plan Does NOT Reuse (Learnings From the Desktop Plan)

These are 7 defects caught post-implementation in the desktop plan (Rulings 6, 7, 9, 11, 12, 13, 14 in `docs/superpowers/plans/2026-10-13-sso-binding-management-page.md`). The web plan must pre-empt them:

| Ruling | Defect | Pre-emption in this spec |
|---|---|---|
| 6 | Preload surface gap | N/A — web uses `apiClient`, not a preload bridge. Already correct. |
| 7 | Brief assumed React test infra that doesn't exist (no `@testing-library/react`, no jsdom) | Spec mandates TanStack Query test wrapper + `tests/pages/account/SsoBindingsPage.test.tsx` matching the existing `tests/api/client.test.ts` shape |
| 9 | i18n brief had wrong key names (consumer code used different ones) | Spec lists BOTH the desktop's 23 key names AND verifies each against the consumer — see i18n section below |
| 11 | i18n missing keys for `loading` and `unbindSucceeded` | Spec includes those 2 keys in the i18n section explicitly |
| 12 | IPC handlers passed relative paths to `net.fetch` | N/A — web uses `apiClient` with `Authorization` header; no URL composition. Already correct. |
| 13 | i18n `t(key)` doesn't substitute `{n}` placeholders | Spec uses `t(key).replace('{n}', String(n))` pattern (codebase convention, 10+ call sites in `Settings.tsx`) |
| 14 | Server endpoint baked wrong `redirect_uri` (server callback instead of desktop loopback) | N/A — the web page uses the existing `/auth/sso/:id/authorize` route (NOT `/me/sso-binding/start`), and `returnTarget: 'console'` is exactly what the web wants (server's `/auth/sso/callback` is the right target for a browser) |

## Architecture

### File Layout

```
enterprise_server/web/src/
  pages/
    account/
      SsoBindingsPage.tsx       (new — main page component, ~250 lines)
      SsoBindingsPage.test.tsx  (new — render + interaction tests, ~200 lines)
      types.ts                  (new — SsoConnectionWithBinding re-declaration + page-local types)
  api/
    ssoBindings.ts              (new — query + mutation wrappers, ~40 lines)
    ssoBindings.test.ts         (new — api wrapper tests, ~50 lines)
  i18n.ts                       (modified — append ~25 new ssoBindings.* keys in en + zh)
  App.tsx                       (modified — add /account/sso-bindings route)
  components/
    Sidebar.tsx                 (modified — add nav entry under a new "Account" group OR a "Me" group)
    UserMenu.tsx                (modified — delete SsoBindModal; repoint menu item to navigate to the new page)
  index.css                     (no change)
enterprise_server/web/tests/
  visual/
    sso-bindings.spec.ts        (new — Playwright snapshot of the empty + populated states)
```

### Page Component Skeleton (Pseudo-Code)

```tsx
// pages/account/SsoBindingsPage.tsx
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { t } from '../../i18n';
import { useAuth } from '../../auth/useAuth';
import { useToast } from '../../components/toastStore';
import { fetchSsoBindings, unbindSsoBinding } from '../../api/ssoBindings';
import type { SsoConnectionWithBinding } from './types';

export function SsoBindingsPage(): JSX.Element {
  const navigate = useNavigate();
  const { claims } = useAuth();
  const orgName = /* derive from /me or claims; see Step 4 */;
  const toast = useToast();
  const qc = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['ssoBindings', claims?.orgId],
    queryFn: () => fetchSsoBindings(),
  });

  const unbindMut = useMutation({
    mutationFn: unbindSsoBinding,
    onSuccess: () => {
      toast.success(t('ssoBindings.unbindSucceeded'));
      void qc.invalidateQueries({ queryKey: ['ssoBindings'] });
    },
    onError: (e) => toast.error(t('ssoBindings.unbindError').replace('{error}', e instanceof Error ? e.message : String(e))),
  });

  const onBind = (connectionId: string) => {
    // Direct nav to the server's authorize route. No iframe, no popup.
    // The server redirects to the IdP, IdP back to /auth/sso/callback,
    // the server binds the user and 302s back to /account/sso-bindings.
    window.location.assign(`/auth/sso/${connectionId}/authorize?orgName=${encodeURIComponent(orgName)}`);
  };

  // ... render: header (back button + title + subtitle), toolbar (search + tabs),
  // list (each row = brand-tile fallback + name + providerType + bound/unbound badge + action button),
  // empty / loading / error states
}
```

### Bind Flow (Detailed)

1. User on `/account/sso-bindings` clicks "绑定" on an unbound row.
2. `onBind(connectionId)` calls `window.location.assign('/auth/sso/' + connectionId + '/authorize?orgName=' + encodedOrgName)`.
3. Server's `GET /auth/sso/:id/authorize` (`enterprise_server/src/routes/sso.ts:82-131`):
   - `returnTarget` defaults to `'console'` (web) — the spec's `?return=` query is absent
   - Builds `redirect_uri = ${origin}/auth/sso/callback`
   - 302 to IdP with PKCE challenge + state
4. IdP authenticates the user (QR scan / login on IdP side), 302 back to `https://server/auth/sso/callback?code=…&state=…`
5. Server's `finishSsoCallback` (`enterprise_server/src/sso/finishCallback.ts`) runs:
   - Exchanges code for IdP token
   - Looks up the user — user is already logged in (session cookie)
   - Writes `users.sso_connection_id` + `users.sso_external_id`
   - Renders the callback HTML page with `redirectTo: '/'` (server's hardcoded default at `sso.ts:175,196`)
6. Browser follows the `redirectTo: '/'` to the dashboard. The user can click the new sidebar entry to see the updated binding.

**v1 scope:** No server-side `returnTo` support. The user lands on the dashboard after a bind. This is the same UX as the existing `SsoBindModal` (which had the same dashboard redirect, but additionally was broken because it used the desktop-only `/me/sso-binding/start` endpoint). The new page fixes the broken flow and adds the bound-state display; the dashboard-redirect is a known v1 limitation. A future plan can extend the server's `SsoLoginState` schema with a `return_to` column and have the authorize route accept `?return=…`.

### Unbind Flow (Detailed)

1. User on `/account/sso-bindings` clicks "解绑" on the bound row.
2. `unbindMut.mutate()` calls `DELETE /me/sso-binding` via the existing `apiClient` (auth header injected automatically).
3. Server clears `users.sso_connection_id` + `users.sso_external_id` (the desktop Task 1 endpoint).
4. On success, the page refetches the list and the row flips to "未绑定" with a "绑定" button.
5. On error, the toast shows the error.

### Data Type (Re-Declared in Web, Not Imported From Server)

```ts
// pages/account/types.ts
// Mirror of enterprise_server/src/sso/bindingTypes.ts. The web does not
// import server code (the server is Hono + pg, the web is Vite + React).
// Keep this in sync with the server — the integration test in
// tests/api/ssoBindings.test.ts asserts the wire shape matches.
export interface SsoConnectionWithBinding {
  id: string;
  name: string;
  providerType: string;
  sortOrder: number;
  enabled: boolean;
  /** Absolute URL for <img src>, or null. Server's resolveProviderLogoUrl
   *  fills this — see enterprise_server/src/sso/logos.ts. */
  logoUrl: string | null;
  bound: boolean;
  externalId: string | null;
}
```

No `description` / `boundAt` fields. The server schema doesn't have them (desktop Rulings 1+2; not a web plan concern but documented for the implementer).

### API Wrappers

```ts
// api/ssoBindings.ts
import { apiClient } from './client';
import type { SsoConnectionWithBinding } from '../pages/account/types';

export async function fetchSsoBindings(): Promise<SsoConnectionWithBinding[]> {
  const j = await apiClient.get<{ connections: SsoConnectionWithBinding[] }>('/me/sso-binding/connections');
  return j.connections;
}

export async function unbindSsoBinding(): Promise<void> {
  await apiClient.delete('/me/sso-binding');
}
```

`apiClient` is the existing wrapper at `web/src/api/client.ts:97-132` (auth header + refresh-on-401). No new fetch plumbing.

### Routing

```tsx
// App.tsx — new route inside the authenticated <Routes> block
<Route
  path="/account/sso-bindings"
  element={
    <AuthGuard>
      <Shell>
        <SsoBindingsPage />
      </Shell>
    </AuthGuard>
  }
/>
```

`AuthGuard` requires no role (every authenticated user can manage their own bindings). `Shell` is the existing sidebar + main + toast layout used by every other authenticated route (`App.tsx:55-165`).

### Sidebar Entry

The current sidebar groups are 概览 / 能力配置 / 运行分析 / 组织管理. SSO bindings is a per-user account surface, not an admin or config surface. **Add a new group "我的账号"** at the bottom with the entry "SSO 账号绑定" (icon: `ShieldCheck` or `Link`, matching the existing `sso.*` iconography in `Sidebar.tsx:37`).

### UserMenu Update

`SsoBindModal` (`web/src/components/UserMenu.tsx:301-370`) is **deleted**. The avatar menu item "Bind SSO account" (line 100, label = `t('sso.profile.bindMenuItem')`) is changed from `onClick={() => setShowSsoBindModal(true)}` to `onClick={() => navigate('/account/sso-bindings')}` (UserMenu already imports `useNavigate` or uses `useAuth`-driven navigation — verify in Step 4).

## Internationalization

The desktop plan added 23 `ssoBindings.*` keys + 1 `sso.profile.bindMenuItem` in `src/renderer/services/i18n.ts` (zh + en). The web already has `sso.profile.bindMenuItem` in `enterprise_server/web/src/i18n.ts` (line 1216, per the explore agent's grep — value `'绑定 SSO 账号'` / `'Bind SSO account'`).

**Add a fresh `ssoBindings.*` namespace to `web/src/i18n.ts`** with the same 23 keys the desktop has, in both `en` and `zh`. Key names verified against the desktop consumer code (Ruling 9 — the brief was wrong; the implementer caught it and used the consumer names; the web spec uses the verified consumer names directly).

| Key | zh | en |
|---|---|---|
| `ssoBindings.title` | `SSO 账号绑定` | `SSO account binding` |
| `ssoBindings.subtitle` | `绑定企业身份源后,你可以使用对应的单点登录方式免密进入 GenWork。可以同时绑定多个身份源,互不影响。` | `After binding an enterprise identity source, you can use the corresponding SSO sign-in to access GenWork without password. You can bind multiple sources simultaneously.` |
| `ssoBindings.statusBadge` | `已绑定 {bound} / {total}` | `Bound {bound} / {total}` |
| `ssoBindings.searchPlaceholder` | `搜索 SSO 类型或名称` | `Search SSO type or name` |
| `ssoBindings.tabAll` | `全部 {n}` | `All {n}` |
| `ssoBindings.tabBound` | `已绑定 {n}` | `Bound {n}` |
| `ssoBindings.tabUnbound` | `未绑定 {n}` | `Unbound {n}` |
| `ssoBindings.statusBound` | `已绑定` | `Bound` |
| `ssoBindings.statusUnbound` | `未绑定` | `Unbound` |
| `ssoBindings.bind` | `绑定` | `Bind` |
| `ssoBindings.unbind` | `解绑` | `Unbind` |
| `ssoBindings.boundAccount` | `已绑定账号 {account}` | `Bound account: {account}` |
| `ssoBindings.boundAt` | `{date} 绑定` | `Bound on {date}` |
| `ssoBindings.emptyNoConnections` | `尚未配置任何 SSO 连接` | `No SSO connections configured` |
| `ssoBindings.emptyHint` | `请联系管理员在 企业 web → SSO 身份提供商 创建。` | `Ask your admin to create one in the enterprise web under SSO / Identity providers.` |
| `ssoBindings.errorMessage` | `加载失败` | `Failed to load` |
| `ssoBindings.loading` | `加载中…` | `Loading…` |
| `ssoBindings.retry` | `重试` | `Retry` |
| `ssoBindings.unbindError` | `解绑失败：{error}` | `Unbind failed: {error}` |
| `ssoBindings.bindError` | `绑定失败：{error}` | `Bind failed: {error}` |
| `ssoBindings.bindSucceeded` | `绑定成功` | `Bound` |
| `ssoBindings.unbindSucceeded` | `解绑成功` | `Unbound` |
| `ssoBindings.back` | `返回` | `Back` |
| `ssoBindings.boundStatusLabel` | `已绑定` | `Bound` (for status pill) |

**All 24 keys must be added in BOTH `en` and `zh`.** The desktop's Ruling 11 lesson: an i18n miss crashes the render. The `loading` and `unbindSucceeded` keys (which the desktop missed) are included in this spec from the start.

The web's `t(key)` does NOT substitute placeholders (desktop Ruling 13). Consumer code must do `t('ssoBindings.tabAll').replace('{n}', String(count))` — see the codebase precedent (10+ call sites in `Settings.tsx` per the explore report).

## Test Strategy

### Per-Feature Tests (Vitest + jsdom)

`tests/pages/account/SsoBindingsPage.test.tsx` (~200 lines, matching the `tests/components/*.test.tsx` precedent):

- **Render harness**: `QueryClientProvider` + `MemoryRouter` (no `<Shell>` / `<AuthGuard>` — those are tested separately)
- **Mock `api/ssoBindings`**: `vi.mock('../../src/api/ssoBindings', ...)` returns mock connection lists
- **Mock `auth/useAuth`**: returns a fake `claims.orgId = 'o1'`
- **Mock `useNavigate`**: from `react-router-dom` via `vi.mock('react-router-dom', ...)` (the codebase pattern in `web/src/components/EnterpriseMtAccountMenu.test.ts` per the explore — wait, that's the desktop, not the web. Use whatever the web's `tests/components/*.test.tsx` already does.)
- **Mock `useToast`**: from `web/src/components/toastStore` if it's testable, otherwise spy on `dispatchEvent`

Test cases:
1. Renders title + subtitle
2. Renders bound count pill (`1 / 7`)
3. Renders all rows with provider name + status badge + action button
4. Bound row shows bound account (`{account}` substituted)
5. Unbound row shows "绑定" button
6. Search filters rows by name (case-insensitive)
7. Tab "已绑定" shows only bound rows
8. Tab "未绑定" shows only unbound rows
9. Tab "全部 {n}" shows the total count, substituted
10. Click "绑定" → `window.location.assign` called with `/auth/sso/{id}/authorize?orgName=…`
11. Click "解绑" → `unbindSsoBinding` called → list refetches
12. Empty state when `connections = []` → shows "尚未配置任何 SSO 连接" + admin hint
13. Loading state → shows "加载中…"
14. Error state → shows "加载失败" + "重试" button
15. "重试" button calls `refetch`

### API Wrapper Tests

`tests/api/ssoBindings.test.ts` (matching `tests/api/client.test.ts` precedent):

- `fetchSsoBindings()` returns the `connections` array from the response
- `unbindSsoBinding()` sends `DELETE /me/sso-binding` and resolves on 200
- **Integration shape test**: assert the `SsoConnectionWithBinding` field set in `web/src/pages/account/types.ts` exactly matches the 8 fields the server returns (per desktop Rulings 1+2 — no `description`, no `boundAt`)

### Visual Baseline

`tests/visual/sso-bindings.spec.ts` (Playwright, matching the existing `tests/visual/users.spec.ts` etc.):

- Snapshot 1: empty state (no connections)
- Snapshot 2: populated state (1 bound + 6 unbound)
- Snapshot 3: bound state with bound account visible
- Snapshot 4: error state (force a 500 from the server)

## Review Focus

Five input classes most likely to bite a person using this page (each is a line in the test plan; the test that pins it is named):

1. **Cross-org leakage** — the `GET /me/sso-binding/connections` endpoint must return only connections from the caller's `orgId`, not all orgs. Server-side SQL already has `WHERE c.org_id = $2` (desktop Task 1 §2); the web test asserts that mocking the API to return another org's connections would still render correctly (because the page trusts the server) — but the visual baseline test will catch this if the server is misconfigured.
2. **Bound-state desync after unbind** — if the user unbind, then navigates away and back, the page must refetch and show "未绑定". The test asserts `useQuery` is invalidated and re-fetched.
3. **Stale cache after dashboard redirect** — after a successful bind, the user lands on `/` (dashboard) and may click back to the SSO bindings page. The TanStack Query cache may show stale data if `staleTime` is too long. The test asserts that the page refetches on mount (`staleTime: 0` or `refetchOnMount: 'always'`).
4. **Empty org with no connections** — the page must not crash when `connections = []`; it must show the "请联系管理员" hint. The visual baseline test snapshots this.
5. **`orgName` derivation** — the page needs the org's NAME (not the orgId) to compose the `?orgName=…` query param for the authorize route. The orgId is in `claims` (`useAuth().claims.orgId`); the org name is in `useMe().orgName` (the existing `/me` response). The test mocks `useMe` to return `{ orgName: 'Acme' }` and asserts the `window.location.assign` URL contains `orgName=Acme`.

## Out of Scope (Explicitly)

- **No server changes.** The new endpoint (`GET /me/sso-binding/connections`) and the unbind endpoint (`DELETE /me/sso-binding`) are already shipped (desktop plan). The web uses them as-is.
- **No `?return=` post-bind redirect.** User lands on the dashboard after a successful bind. A future plan can extend the server's `SsoLoginState` schema with a `return_to` column and have the authorize route accept `?return=…` if the extra click is annoying.
- **No bind via popup window.** The user chose direct navigation. A popup flow can be added later if the user requests.
- **No "currently bound to X" on the avatar menu.** The avatar menu now just navigates to the new page; the page is the single source of truth for the bound state.
- **No bulk bind / unbind.** Per-row actions only.
- **No admin-side management of *other users'* bindings.** The existing `/admin/users/:id/sso-binding` DELETE (`UserDetailPage.tsx:43,58,93,153-154,351-353`) handles that.
- **No audit log display.** The desktop's audit log entries (`sso_user_binding_start`, `sso_user_self_unbound`) are written server-side; the web doesn't surface them.
- **No bind-via-`/bind-sso` iframe path.** The user clarified that direct navigation is the right flow for a logged-in user. The iframe path is for the strict-mode password-proof scenario (different feature).
