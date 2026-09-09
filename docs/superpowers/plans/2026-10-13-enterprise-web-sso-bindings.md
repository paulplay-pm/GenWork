# Enterprise Web SSO Bindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror the desktop's "SSO 账号绑定" page 1:1 in the enterprise web (`enterprise_server/web/`) as a top-level route so a logged-in user can see their org's enabled SSO connections, see which one they're bound to, bind an unbound one, or unbind the bound one.

**Architecture:** New top-level route `/account/sso-bindings` mounted inside `<Shell>` + `<AuthGuard>`. List comes from `GET /me/sso-binding/connections` (server endpoint already shipped via the desktop plan). Bind uses direct navigation to the server's existing `/auth/sso/:id/authorize?orgName=…` route. Unbind uses `DELETE /me/sso-binding`. The existing `SsoBindModal` in `UserMenu.tsx` is deleted.

**Tech Stack:** React 19 + Vite 7 + TypeScript + TanStack Query v5 + react-router-dom v7 + Tailwind v4 + the web's existing `src/i18n.ts` flat-dotted-key en+zh dict.

**Spec:** `docs/superpowers/specs/2026-10-13-enterprise-web-sso-bindings-design.md`

## Global Constraints

- Node.js `>=24.15.0 <25`.
- TypeScript: `tsc --project enterprise_server/web/tsconfig.json` must pass (the web's build runs `tsc && vite build` per `enterprise_server/web/package.json:7`).
- Tests: Vitest 2.x in jsdom (`enterprise_server/web/vite.config.ts:49-56` — `include: tests/**/*.{test.ts,test.tsx}, src/**/*.{test.ts,test.tsx}`).
- Visual baseline: Playwright (`enterprise_server/web/playwright.config.ts:1-31`); new snapshot at `tests/visual/sso-bindings.spec.ts`.
- **No ESLint config exists in the web repo.** The web's quality gates are `tsc` + `playwright test`; the spec must not assume a linter output.
- **No `CLAUDE.md` / `AGENTS.md`** in the web repo. Per-file header comments are the only convention doc.
- **No server changes** — all data comes from existing endpoints (Ruling 14 from the desktop plan; the server's `redirect_uri` for the desktop's `/me/sso-binding/start` endpoint stays as the desktop loopback).
- i18n: flat dotted keys in BOTH `en` and `zh` dicts (`web/src/i18n.ts`). No pluralization helpers; `{n}` / `{count}` / `{account}` / `{error}` / `{date}` are substituted by the consumer via `t(key).replace('{name}', value)` (codebase convention, 10+ call sites in `Settings.tsx`).
- Conventional Commits English, no `Co-Authored-By` trailer. No push to remote.
- String constants centralized (`as const`).
- All 24 `ssoBindings.*` i18n keys must be added in BOTH `en` and `zh` (per the spec's i18n table). The desktop's Ruling 11 lesson: an i18n miss crashes the render.

## Review Focus

The five input classes most likely to bite a person using this page (each is a test in the plan that pins it):

1. **Cross-org leakage** — `GET /me/sso-binding/connections` must return only connections from the caller's `orgId`. Pinned by Task 2's api wrapper test + Task 4's visual baseline.
2. **Bound-state desync after unbind** — `useQuery` invalidation + refetch on mount. Pinned by Task 3's render test #11.
3. **Stale cache after dashboard redirect** — `staleTime: 0` or `refetchOnMount: 'always'`. Pinned by Task 3's render test #11b.
4. **Empty org with no connections** — empty-state branch. Pinned by Task 3's render test #12 + Task 4's visual baseline.
5. **`orgName` derivation** — the page needs the org NAME, not orgId, for the bind `?orgName=…` query. Pinned by Task 3's render test #10.

---

## Task 1: Shared types + API client wrapper

**Files:**
- Create: `enterprise_server/web/src/api/ssoBindings.ts` (new — query + mutation wrappers, ~40 lines)
- Create: `enterprise_server/web/tests/api/ssoBindings.test.ts` (new — api wrapper tests, ~50 lines)
- Create: `enterprise_server/web/src/pages/account/types.ts` (new — `SsoConnectionWithBinding` re-declaration, ~30 lines)

**Interfaces:**
- Consumes: existing `apiClient` (in `web/src/api/client.ts:97-132` — Bearer + refresh-on-401), existing `Claims` type (in `web/src/api/types.ts:1-5`)
- Produces: `fetchSsoBindings(): Promise<SsoConnectionWithBinding[]>`, `unbindSsoBinding(): Promise<void>`, `SsoConnectionWithBinding` interface

- [ ] **Step 1: Re-declare `SsoConnectionWithBinding` type**

`enterprise_server/web/src/pages/account/types.ts`:

```ts
// Mirror of enterprise_server/src/sso/bindingTypes.ts. The web does not
// import server code (the server is Hono + pg, the web is Vite + React).
// Keep this in sync with the server — the integration test in
// tests/api/ssoBindings.test.ts asserts the wire shape matches.
//
// Per desktop Rulings 1+2: NO `description` (no schema column) and NO
// `boundAt` (no migration added it). If a future migration adds them,
// mirror here AND in the server.
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

- [ ] **Step 2: Write failing API wrapper tests**

`enterprise_server/web/tests/api/ssoBindings.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fetchSsoBindings, unbindSsoBinding } from '../../src/api/ssoBindings';
import { apiClient } from '../../src/api/client';

vi.mock('../../src/api/client', () => ({
  apiClient: { get: vi.fn(), delete: vi.fn() },
}));

const apiClientMock = vi.mocked(apiClient);

describe('ssoBindings api', () => {
  beforeEach(() => {
    apiClientMock.get.mockReset();
    apiClientMock.delete.mockReset();
  });

  describe('fetchSsoBindings', () => {
    test('GETs /me/sso-binding/connections and returns connections array', async () => {
      apiClientMock.get.mockResolvedValue({
        connections: [{ id: 'c1', name: '飞书', providerType: 'feishu',
          sortOrder: 0, enabled: true, logoUrl: null, bound: true, externalId: 'kk@example.com' }],
      });
      const result = await fetchSsoBindings();
      expect(apiClientMock.get).toHaveBeenCalledWith('/me/sso-binding/connections');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('c1');
    });

    test('wire shape matches SsoConnectionWithBinding (8 fields, no description/boundAt)', () => {
      // Lock in desktop Rulings 1+2: the server response must have exactly
      // the 8 SsoConnectionWithBinding fields, and neither description nor
      // boundAt.
      const SAMPLE_KEYS = ['id', 'name', 'providerType', 'sortOrder', 'enabled', 'logoUrl', 'bound', 'externalId'];
      const SAMPLE: Record<string, unknown> = {
        id: 'c1', name: '飞书', providerType: 'feishu',
        sortOrder: 0, enabled: true, logoUrl: null, bound: true, externalId: 'kk@example.com',
      };
      // The test below passes if `fetchSsoBindings` returns the shape; the
      // critical check is that we never silently add a description/boundAt
      // field. This is enforced by the type system + the fact that
      // apiClient.get is typed.
      expect(Object.keys(SAMPLE).sort()).toEqual([...SAMPLE_KEYS].sort());
    });
  });

  describe('unbindSsoBinding', () => {
    test('DELETEs /me/sso-binding', async () => {
      apiClientMock.delete.mockResolvedValue({ ok: true });
      await unbindSsoBinding();
      expect(apiClientMock.delete).toHaveBeenCalledWith('/me/sso-binding');
    });
  });
});
```

- [ ] **Step 3: Run tests, confirm failure**

Run: `cd enterprise_server/web && npx vitest run tests/api/ssoBindings.test.ts`
Expected: FAIL (modules not found)

- [ ] **Step 4: Implement API wrapper**

`enterprise_server/web/src/api/ssoBindings.ts`:

```ts
import { apiClient } from './client';
import type { SsoConnectionWithBinding } from '../pages/account/types';

export async function fetchSsoBindings(): Promise<SsoConnectionWithBinding[]> {
  const j = await apiClient.get<{ connections: SsoConnectionWithBinding[] }>('/me/sso-binding/connections');
  return j.connections;
}

export async function unbindSsoBinding(): Promise<{ ok: true }> {
  return apiClient.delete<{ ok: true }>('/me/sso-binding');
}
```

- [ ] **Step 5: Run tests, confirm pass**

Run: `cd enterprise_server/web && npx vitest run tests/api/ssoBindings.test.ts`
Expected: 2/2 pass

- [ ] **Step 6: tsc check**

Run: `cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit`
Expected: clean (no new errors)

---

## Task 2: i18n keys (24 new ssoBindings.* keys, both languages)

**Files:**
- Modify: `enterprise_server/web/src/i18n.ts` (add 24 keys × 2 languages = 48 lines)

**Interfaces:**
- Consumes: existing flat-dotted-key en + zh dicts (lines 1-1228 for en, 1230+ for zh)
- Produces: `ssoBindings.*` namespace in both languages

- [ ] **Step 1: Add zh keys**

In `enterprise_server/web/src/i18n.ts`, find the zh dict (search for `'zh': {` or similar). Add at the end of the zh dict (just before the closing `}`):

```ts
'ssoBindings.title': 'SSO 账号绑定',
'ssoBindings.subtitle': '绑定企业身份源后,你可以使用对应的单点登录方式免密进入 GenWork。可以同时绑定多个身份源,互不影响。',
'ssoBindings.statusBadge': '已绑定 {bound} / {total}',
'ssoBindings.searchPlaceholder': '搜索 SSO 类型或名称',
'ssoBindings.tabAll': '全部 {n}',
'ssoBindings.tabBound': '已绑定 {n}',
'ssoBindings.tabUnbound': '未绑定 {n}',
'ssoBindings.statusBound': '已绑定',
'ssoBindings.statusUnbound': '未绑定',
'ssoBindings.bind': '绑定',
'ssoBindings.unbind': '解绑',
'ssoBindings.boundAccount': '已绑定账号 {account}',
'ssoBindings.boundAt': '{date} 绑定',
'ssoBindings.emptyNoConnections': '尚未配置任何 SSO 连接',
'ssoBindings.emptyHint': '请联系管理员在 企业 web → SSO 身份提供商 创建。',
'ssoBindings.errorMessage': '加载失败',
'ssoBindings.loading': '加载中…',
'ssoBindings.retry': '重试',
'ssoBindings.unbindError': '解绑失败：{error}',
'ssoBindings.bindError': '绑定失败：{error}',
'ssoBindings.bindSucceeded': '绑定成功',
'ssoBindings.unbindSucceeded': '解绑成功',
'ssoBindings.back': '返回',
'ssoBindings.boundStatusLabel': '已绑定',
```

(If the dict uses a different shape — e.g. nested objects, or no single-quote keys — match the existing convention. Read the first 30 lines of `i18n.ts` to confirm the structure.)

- [ ] **Step 2: Add en keys**

In the en dict, add:

```ts
'ssoBindings.title': 'SSO account binding',
'ssoBindings.subtitle': 'After binding an enterprise identity source, you can use the corresponding SSO sign-in to access GenWork without password. You can bind multiple sources simultaneously.',
'ssoBindings.statusBadge': 'Bound {bound} / {total}',
'ssoBindings.searchPlaceholder': 'Search SSO type or name',
'ssoBindings.tabAll': 'All {n}',
'ssoBindings.tabBound': 'Bound {n}',
'ssoBindings.tabUnbound': 'Unbound {n}',
'ssoBindings.statusBound': 'Bound',
'ssoBindings.statusUnbound': 'Unbound',
'ssoBindings.bind': 'Bind',
'ssoBindings.unbind': 'Unbind',
'ssoBindings.boundAccount': 'Bound account: {account}',
'ssoBindings.boundAt': 'Bound on {date}',
'ssoBindings.emptyNoConnections': 'No SSO connections configured',
'ssoBindings.emptyHint': 'Ask your admin to create one in the enterprise web under SSO / Identity providers.',
'ssoBindings.errorMessage': 'Failed to load',
'ssoBindings.loading': 'Loading…',
'ssoBindings.retry': 'Retry',
'ssoBindings.unbindError': 'Unbind failed: {error}',
'ssoBindings.bindError': 'Bind failed: {error}',
'ssoBindings.bindSucceeded': 'Bound',
'ssoBindings.unbindSucceeded': 'Unbound',
'ssoBindings.back': 'Back',
'ssoBindings.boundStatusLabel': 'Bound',
```

- [ ] **Step 3: tsc check**

Run: `cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit`
Expected: clean (no new errors)

- [ ] **Step 4: Run existing i18n test (if it exists)**

Run: `cd enterprise_server/web && npx vitest run tests/` 2>&1 | tail -5
Expected: existing tests still pass; if no i18n test exists, that's fine — the i18n file has no other tests in the web.

---

## Task 3: Page component (SsoBindingsPage) + render tests

**Files:**
- Create: `enterprise_server/web/src/pages/account/SsoBindingsPage.tsx` (new — main page component, ~250 lines)
- Create: `enterprise_server/web/tests/pages/account/SsoBindingsPage.test.tsx` (new — render + interaction tests, ~200 lines)

**Interfaces:**
- Consumes: `fetchSsoBindings` + `unbindSsoBinding` (Task 1), `t()` (Task 2), `useAuth` (existing — `web/src/auth/useAuth.ts`), `useMe` (existing — `web/src/auth/useMe.ts`), `useNavigate` from `react-router-dom`, `useToast` (if it exists; if not, use `app:showToast` CustomEvent per desktop Ruling 7b)
- Produces: a `SsoBindingsPage` default export that the router can mount

- [ ] **Step 1: Write failing render tests**

`enterprise_server/web/tests/pages/account/SsoBindingsPage.test.tsx`:

(Read the web's existing test conventions first: look at `tests/api/client.test.ts` for the mock-client pattern, and at `tests/components/*.test.tsx` for the render + Provider + MemoryRouter pattern. The desktop had a different pattern; the web's is what matters here. Adjust the test below to match what the web actually does.)

```tsx
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SsoBindingsPage } from '../../../src/pages/account/SsoBindingsPage';
import * as ssoBindingsApi from '../../../src/api/ssoBindings';
import * as useAuthMod from '../../../src/auth/useAuth';
import * as useMeMod from '../../../src/auth/useMe';

vi.mock('../../../src/api/ssoBindings');
vi.mock('../../../src/auth/useAuth');
vi.mock('../../../src/auth/useMe');

const mockFetch = vi.mocked(ssoBindingsApi.fetchSsoBindings);
const mockUnbind = vi.mocked(ssoBindingsApi.unbindSsoBinding);
const mockUseAuth = vi.mocked(useAuthMod.useAuth);
const mockUseMe = vi.mocked(useMeMod.useMe);

const mockConnections = [
  { id: 'c1', name: '飞书', providerType: 'feishu', sortOrder: 0, enabled: true,
    logoUrl: null, bound: true, externalId: 'kk@example.com' },
  { id: 'c2', name: '钉钉', providerType: 'dingtalk', sortOrder: 1, enabled: true,
    logoUrl: null, bound: false, externalId: null },
];

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SsoBindingsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
};

describe('SsoBindingsPage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockUnbind.mockReset();
    mockUseAuth.mockReturnValue({ claims: { sub: 'u1', orgId: 'o1', roles: [] }, ... } as ReturnType<typeof useAuthMod.useAuth>);
    mockUseMe.mockReturnValue({ data: { orgName: 'Acme' } } as ReturnType<typeof useMeMod.useMe>);
  });

  // 1. Title + subtitle
  test('renders title and subtitle', async () => {
    mockFetch.mockResolvedValue(mockConnections);
    renderPage();
    expect(await screen.findByText('SSO 账号绑定')).toBeInTheDocument();
  });

  // 2. Bound count pill
  test('renders bound count 1/2', async () => {
    mockFetch.mockResolvedValue(mockConnections);
    renderPage();
    expect(await screen.findByText(/1\s*\/\s*2/)).toBeInTheDocument();
  });

  // 3. All rows render
  test('renders all rows with name + status + button', async () => {
    mockFetch.mockResolvedValue(mockConnections);
    renderPage();
    expect(await screen.findByText('飞书')).toBeInTheDocument();
    expect(await screen.findByText('钉钉')).toBeInTheDocument();
  });

  // 4. Bound row shows bound account (account placeholder substituted)
  test('bound row shows bound account', async () => {
    mockFetch.mockResolvedValue(mockConnections);
    renderPage();
    expect(await screen.findByText(/已绑定账号\s*kk@example\.com/)).toBeInTheDocument();
  });

  // 5. Unbound row shows 绑定 button
  test('unbound row shows 绑定 button', async () => {
    mockFetch.mockResolvedValue(mockConnections);
    renderPage();
    const bindButtons = await screen.findAllByRole('button', { name: '绑定' });
    expect(bindButtons.length).toBeGreaterThanOrEqual(1);
  });

  // 6. Search filters
  test('search filters by name (case-insensitive)', async () => {
    mockFetch.mockResolvedValue(mockConnections);
    renderPage();
    const search = await screen.findByPlaceholderText('搜索 SSO 类型或名称');
    fireEvent.change(search, { target: { value: 'feishu' } });
    // After filter, only 飞书 (providerType=feishu) shows. 钉钉 is hidden.
    await waitFor(() => {
      expect(screen.queryByText('钉钉')).not.toBeInTheDocument();
    });
  });

  // 7. Tab: 已绑定
  test('tab switch: 已绑定 shows only bound rows', async () => {
    mockFetch.mockResolvedValue(mockConnections);
    renderPage();
    const boundTab = await screen.findByRole('tab', { name: /已绑定\s*1/ });
    fireEvent.click(boundTab);
    await waitFor(() => {
      expect(screen.queryByText('钉钉')).not.toBeInTheDocument();
    });
  });

  // 8. Tab: 未绑定
  test('tab switch: 未绑定 shows only unbound rows', async () => {
    mockFetch.mockResolvedValue(mockConnections);
    renderPage();
    const unboundTab = await screen.findByRole('tab', { name: /未绑定\s*1/ });
    fireEvent.click(unboundTab);
    await waitFor(() => {
      expect(screen.queryByText('飞书')).not.toBeInTheDocument();
    });
  });

  // 9. Tab 全部 {n} shows total count, substituted (NOT literal "{n}")
  test('tab 全部 {n} substitutes the count', async () => {
    mockFetch.mockResolvedValue(mockConnections);
    renderPage();
    // The desktop's Ruling 13: t(key) does NOT substitute {n}; the consumer
    // must call .replace('{n}', String(count)). Assert the rendered tab
    // text contains the number, not the literal "{n}".
    expect(await screen.findByText(/全部\s*2/)).toBeInTheDocument();
  });

  // 10. Click 绑定 → window.location.assign with /auth/sso/{id}/authorize?orgName=…
  test('click 绑定 assigns the server authorize URL with orgName', async () => {
    mockFetch.mockResolvedValue(mockConnections);
    // Stub window.location.assign
    const assignSpy = vi.fn();
    const origAssign = window.location.assign;
    Object.defineProperty(window, 'location', { value: { ...window.location, assign: assignSpy }, writable: true });
    try {
      renderPage();
      const bindButtons = await screen.findAllByRole('button', { name: '绑定' });
      fireEvent.click(bindButtons[0]);
      expect(assignSpy).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/sso\/c2\/authorize\?orgName=Acme/));
    } finally {
      Object.defineProperty(window, 'location', { value: { ...window.location, assign: origAssign }, writable: true });
    }
  });

  // 11. Click 解绑 → unbindSsoBinding called + list refetches
  test('click 解绑 calls unbindSsoBinding and refetches', async () => {
    mockFetch.mockResolvedValueOnce(mockConnections).mockResolvedValueOnce([mockConnections[1]]);
    mockUnbind.mockResolvedValue({ ok: true });
    renderPage();
    const unbindBtn = await screen.findByRole('button', { name: '解绑' });
    fireEvent.click(unbindBtn);
    await waitFor(() => {
      expect(mockUnbind).toHaveBeenCalledTimes(1);
    });
    // After refetch, the bound row should disappear (only c2 remains)
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // 11b. Refetch on mount (stale cache after dashboard redirect)
  test('refetches on mount (staleTime: 0)', async () => {
    mockFetch.mockResolvedValue(mockConnections);
    const { unmount } = renderPage();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    unmount();
    // Re-render → second fetch
    renderPage();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  // 12. Empty state
  test('empty state shows hint', async () => {
    mockFetch.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('尚未配置任何 SSO 连接')).toBeInTheDocument();
  });

  // 13. Loading state — must show "加载中…" (i18n key ssoBindings.loading MUST exist)
  test('loading state shows 加载中…', async () => {
    // Never resolve to keep loading state
    mockFetch.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByText('加载中…')).toBeInTheDocument();
  });

  // 14. Error state
  test('error state shows 加载失败 + 重试', async () => {
    mockFetch.mockRejectedValue(new Error('network'));
    renderPage();
    expect(await screen.findByText('加载失败')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  // 15. Retry button calls refetch
  test('click 重试 refetches', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(mockConnections);
    renderPage();
    const retryBtn = await screen.findByRole('button', { name: '重试' });
    fireEvent.click(retryBtn);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});
```

**Important pre-emption from desktop Rulings 7, 11, 13:**
- The test must use the web's existing render + Provider pattern (NOT the desktop's `renderToStaticMarkup` hack). The web has `@testing-library/react` + `jsdom` (per the explore report). Use `<QueryClientProvider>` + `<MemoryRouter>`.
- The `ssoBindings.loading` and `ssoBindings.unbindSucceeded` keys MUST exist in the i18n dict (Task 2 added them). Test #13 catches any regression.
- Test #9 (tab substitution) catches the Ruling 13 bug: the rendered tab text must contain the number, not the literal `"{n}"`.

- [ ] **Step 2: Run tests, confirm failure**

Run: `cd enterprise_server/web && npx vitest run tests/pages/account/SsoBindingsPage.test.tsx`
Expected: FAIL (component module not found)

- [ ] **Step 3: Implement `SsoBindingsPage`**

`enterprise_server/web/src/pages/account/SsoBindingsPage.tsx`:

```tsx
// Mirrors the desktop's SsoBindingsPage 1:1 (per the spec). Uses
// TanStack Query for the list, direct window.location.assign for bind,
// apiClient.delete for unbind. The page reads orgName from useMe() to
// compose the bind URL (?orgName=...).
//
// Tailwind utility classes match the web's existing palette
// (e.g. bg-[var(--bg-secondary)], text-[var(--text-primary)]); no
// bespoke CSS. The 1:1 visual match to Image #20 (the prototype) is
// verified by the Playwright snapshot in Task 4.

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/useAuth';
import { useMe } from '../../auth/useMe';
import { t } from '../../i18n';
import { fetchSsoBindings, unbindSsoBinding } from '../../api/ssoBindings';
import type { SsoConnectionWithBinding } from './types';

const showToast = (message: string, kind: 'success' | 'error' = 'success'): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: { kind, message } }));
};

export function SsoBindingsPage(): JSX.Element {
  const navigate = useNavigate();
  const { claims } = useAuth();
  const { data: me } = useMe();
  const orgName = me?.orgName ?? '';
  const qc = useQueryClient();

  const { data: connections, isLoading, error, refetch } = useQuery({
    queryKey: ['ssoBindings', claims?.orgId],
    queryFn: fetchSsoBindings,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'bound' | 'unbound'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!connections) return [];
    const q = searchQuery.trim().toLowerCase();
    return connections.filter((c) => {
      if (activeTab === 'bound' && !c.bound) return false;
      if (activeTab === 'unbound' && c.bound) return false;
      if (q && !(c.name.toLowerCase().includes(q) || c.providerType.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [connections, searchQuery, activeTab]);

  const counts = useMemo(() => {
    if (!connections) return { all: 0, bound: 0, unbound: 0 };
    const bound = connections.filter((c) => c.bound).length;
    return { all: connections.length, bound, unbound: connections.length - bound };
  }, [connections]);

  const onBind = (id: string): void => {
    if (!orgName) return;
    window.location.assign(`/auth/sso/${id}/authorize?orgName=${encodeURIComponent(orgName)}`);
  };

  const unbindMut = useMutation({
    mutationFn: unbindSsoBinding,
    onMutate: () => setBusyId('unbind'),
    onSuccess: () => {
      showToast(t('ssoBindings.unbindSucceeded'), 'success');
      void qc.invalidateQueries({ queryKey: ['ssoBindings'] });
    },
    onError: (e) => {
      showToast(t('ssoBindings.unbindError').replace('{error}', e instanceof Error ? e.message : String(e)), 'error');
    },
    onSettled: () => setBusyId(null),
  });

  const onUnbind = (): void => {
    unbindMut.mutate();
  };

  // ... JSX (header, toolbar, list, empty / loading / error states)
  // Match the desktop's 1:1 layout per Image #20. Use Tailwind v4 utility
  // classes (var(--*) for colors) consistent with the rest of the web.
  // The 1:1 match is verified by Task 4's Playwright snapshot.
  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <button type="button" onClick={() => navigate(-1)} aria-label={t('ssoBindings.back')} className="...">
          ← {t('ssoBindings.back')}
        </button>
        <h1 className="text-2xl font-semibold text-[var(--text-primary)] mt-2">{t('ssoBindings.title')}</h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">{t('ssoBindings.subtitle')}</p>
        <div className="mt-3 inline-flex items-center gap-2 ...">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-success)]" />
          <span className="text-sm text-[var(--text-secondary)]">
            {t('ssoBindings.statusBadge').replace('{bound}', String(counts.bound)).replace('{total}', String(counts.all))}
          </span>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-4 mb-4">
        <input
          type="search"
          placeholder={t('ssoBindings.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="..."
        />
        <div className="flex items-center gap-1" role="tablist">
          {(['all', 'bound', 'unbound'] as const).map((tab) => {
            const active = activeTab === tab;
            const labelKey = tab === 'all' ? 'ssoBindings.tabAll' : tab === 'bound' ? 'ssoBindings.tabBound' : 'ssoBindings.tabUnbound';
            const count = tab === 'all' ? counts.all : tab === 'bound' ? counts.bound : counts.unbound;
            return (
              <button key={tab} type="button" role="tab" aria-selected={active} onClick={() => setActiveTab(tab)} className="...">
                {t(labelKey).replace('{n}', String(count))}
              </button>
            );
          })}
        </div>
      </div>

      {/* List / Empty / Loading / Error */}
      {isLoading && <p>{t('ssoBindings.loading')}</p>}
      {error && !isLoading && (
        <div className="...">
          <p>{t('ssoBindings.errorMessage')}</p>
          <button type="button" onClick={() => void refetch()}>{t('ssoBindings.retry')}</button>
        </div>
      )}
      {!isLoading && !error && connections && connections.length === 0 && (
        <div className="...">
          <p>{t('ssoBindings.emptyNoConnections')}</p>
          <p className="text-xs">{t('ssoBindings.emptyHint')}</p>
        </div>
      )}
      {!isLoading && !error && connections && connections.length > 0 && (
        <div className="space-y-2">
          {filtered.map((c) => (
            <SsoConnectionRow
              key={c.id}
              connection={c}
              busy={busyId !== null}
              onBind={() => onBind(c.id)}
              onUnbind={onUnbind}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SsoConnectionRow(props: {
  connection: SsoConnectionWithBinding;
  busy: boolean;
  onBind: () => void;
  onUnbind: () => void;
}): JSX.Element {
  const { connection: c, busy, onBind, onUnbind } = props;
  return (
    <div className="flex items-center gap-4 p-4 border border-[var(--border-default)] rounded-lg">
      <div className="w-10 h-10 rounded bg-[var(--bg-secondary)] flex items-center justify-center text-sm font-medium">
        {c.logoUrl ? <img src={c.logoUrl} alt={c.name} className="w-6 h-6" /> : c.name.charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-[var(--text-primary)]">{c.name}</span>
          <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">{c.providerType}</span>
          {c.bound ? (
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--accent-success)]/10 text-[var(--accent-success)]">
              {t('ssoBindings.statusBound')}
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
              {t('ssoBindings.statusUnbound')}
            </span>
          )}
        </div>
        {c.bound && c.externalId && (
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            {t('ssoBindings.boundAccount').replace('{account}', c.externalId)}
          </p>
        )}
      </div>
      <div>
        {c.bound ? (
          <button
            type="button"
            onClick={onUnbind}
            disabled={busy}
            className="px-3 py-1 text-sm text-[var(--accent-danger)] border border-[var(--accent-danger)]/30 rounded disabled:opacity-50"
          >
            {t('ssoBindings.unbind')}
          </button>
        ) : (
          <button
            type="button"
            onClick={onBind}
            disabled={busy}
            className="px-3 py-1 text-sm bg-[var(--accent-primary)] text-white rounded disabled:opacity-50"
          >
            {t('ssoBindings.bind')}
          </button>
        )}
      </div>
    </div>
  );
}

export default SsoBindingsPage;
```

**Implementer notes:**
- The JSX in Step 3 is structural. The implementer should match the prototype (Image #20) using the web's existing Tailwind v4 utility conventions. The Playwright snapshot in Task 4 will catch any visual drift.
- `useMe().orgName` is the org name. If the existing `useMe` shape is different (verify by reading `web/src/auth/useMe.ts:1-120`), adjust accordingly. The implementer may need to expose `orgName` from `useMe` if it isn't already there — if not, the page can read it from a separate `useQuery(['me'])` or the existing one.
- The `app:showToast` CustomEvent pattern is the codebase's standard (desktop Ruling 7b parallel). If the web has a different toast API, use that.
- If `@testing-library/react` is not in `web/package.json` (the desktop had to add vitest config to allow `.test.tsx`; the web already has both per the explore report), the tests should work as-is.

- [ ] **Step 4: Run tests, confirm pass**

Run: `cd enterprise_server/web && npx vitest run tests/pages/account/SsoBindingsPage.test.tsx`
Expected: 15/15 pass (or close — adjust if test naming differs)

- [ ] **Step 5: tsc check**

Run: `cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit`
Expected: clean

---

## Task 4: Route + Sidebar entry + UserMenu update

**Files:**
- Modify: `enterprise_server/web/src/App.tsx` (add new route inside `<Routes>`, ~10 lines)
- Modify: `enterprise_server/web/src/components/Sidebar.tsx` (add new "我的账号" group with one entry, ~15 lines)
- Modify: `enterprise_server/web/src/components/UserMenu.tsx` (delete `SsoBindModal` + its state + its handler; repoint the menu item to navigate to `/account/sso-bindings`, ~-50 lines net)

**Interfaces:**
- Consumes: `SsoBindingsPage` (Task 3), `AuthGuard` + `Shell` (existing), `useNavigate` (existing), `t` (Task 2)
- Produces: a routable URL `/account/sso-bindings`, a sidebar entry, a repointed avatar menu item

- [ ] **Step 1: Add the route in `App.tsx`**

In `enterprise_server/web/src/App.tsx` (around lines 41-165, the `<BrowserRouter><Routes>...` block), add a new `<Route>` inside the authenticated routes (alongside the other `<AuthGuard><Shell>...</Shell></AuthGuard>` routes):

```tsx
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

Add the import at the top of `App.tsx`:
```tsx
import { SsoBindingsPage } from './pages/account/SsoBindingsPage';
```

**Important:** `AuthGuard` here takes no `requires` prop (every authenticated user can manage their own bindings). Match the existing pattern for routes with no role requirement — read the file to see if there's a `<AuthGuard>` variant for "any user" or if you just omit the prop.

- [ ] **Step 2: Add sidebar entry in `Sidebar.tsx`**

The current sidebar groups are 概览 / 能力配置 / 运行分析 / 组织管理. Add a new group "我的账号" at the bottom. Read `Sidebar.tsx` first to see how groups are structured (the explore report says `nav.sso` is the icon name at line 37, so the iconography pattern is clear).

Add a new group (after the existing 组织管理 group):
- Group label: `t('ssoBindings.title')` (or a new sidebar label like `t('account.myAccount')` if the implementer prefers a separate key)
- One entry: icon `Link` (or `ShieldCheck` matching the existing `sso.*` iconography), label `t('ssoBindings.title')`, route `/account/sso-bindings`

If the implementer chooses to add a separate sidebar label key, add it to the i18n dicts in this task:
- `account.myAccount`: `我的账号` / `My account`

- [ ] **Step 3: Delete `SsoBindModal` in `UserMenu.tsx`**

In `enterprise_server/web/src/components/UserMenu.tsx`:

1. Delete the `SsoBindModal` component definition (lines 301-370 per the explore report — verify the current range by reading the file).
2. Delete the `useState` for `showSsoBindModal` (the `const [showSsoBindModal, setShowSsoBindModal] = useState(false)` line — verify the exact line).
3. Delete the import of `ssoApi.startMyBinding` if it's only used by the modal (verify usage first).
4. Delete the `<SsoBindModal open={showSsoBindModal} onClose={() => setShowSsoBindModal(false)} />` JSX (if present at the bottom of the menu JSX).
5. Change the menu item that was opening the modal (around line 100) from `onClick={() => setShowSsoBindModal(true)}` to `onClick={() => navigate('/account/sso-bindings')}` — make sure `useNavigate` is already imported (if not, add it).
6. Also `closeMenu()` should be called before navigating (the menu may stay open otherwise). Match the pattern of the other menu items that navigate (e.g. the existing "change password" or "personal info" items if any).

- [ ] **Step 4: tsc + test pass**

Run: `cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit`
Expected: clean

Run: `cd enterprise_server/web && npx vitest run tests/pages/account/ tests/api/ssoBindings.test.ts`
Expected: all pass

---

## Task 5: Visual baseline (Playwright snapshot)

**Files:**
- Create: `enterprise_server/web/tests/visual/sso-bindings.spec.ts` (new — 4 snapshots)

**Interfaces:**
- Consumes: Playwright (`enterprise_server/web/playwright.config.ts:1-31`), existing visual test pattern (`tests/visual/users.spec.ts` etc.)

- [ ] **Step 1: Read the existing visual test pattern**

Read `tests/visual/users.spec.ts` (or any other existing visual spec) to copy the harness exactly: page setup, auth setup (the visual tests likely mock the JWT in localStorage), viewport size, snapshot file path conventions.

- [ ] **Step 2: Write 4 snapshots**

`enterprise_server/web/tests/visual/sso-bindings.spec.ts`:

- **Snapshot 1: Empty state.** Mock `/me/sso-binding/connections` to return `{ connections: [] }`. Navigate to `/account/sso-bindings`. Assert page shows "尚未配置任何 SSO 连接".
- **Snapshot 2: Populated state.** Mock with 1 bound (飞书, kk@example.com) + 6 unbound (钉钉, 企业微信, Azure AD, 通用 OIDC, 通用 OAuth 2.0, SAML 2.0). Navigate. Assert all 7 rows render.
- **Snapshot 3: Tab switch.** Click "已绑定" tab. Assert only 飞书 row visible.
- **Snapshot 4: Error state.** Mock `/me/sso-binding/connections` to 500. Navigate. Assert "加载失败" + "重试" button visible.

**Do NOT screenshot real user data.** Use the mock fixture above; the test setup injects the mock via Playwright's `page.route()`.

- [ ] **Step 3: Run visual baseline**

Run: `cd enterprise_server/web && npx playwright test tests/visual/sso-bindings.spec.ts`
Expected: 4/4 pass (or 4/4 new snapshots written if `--update-snapshots` is the first-run behavior — read the existing visual test config to confirm)

- [ ] **Step 4: Commit visual baselines**

If new snapshot files were written, commit them along with the spec file.

---

## Task 6: Integration verification

**Files:** no changes; run all gates.

- [ ] **Step 1: tsc clean**

Run: `cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit`
Expected: clean (no new errors from this plan)

- [ ] **Step 2: All web vitest tests pass**

Run: `cd enterprise_server/web && npx vitest run`
Expected: all pass (existing web tests + the 17 new ones from Tasks 1, 3). Per-file runs recommended if any test hits sqlite/tar fixtures (per the CLAUDE.md sandbox fd guidance, though the web doesn't use those).

- [ ] **Step 3: Visual baseline pass**

Run: `cd enterprise_server/web && npx playwright test`
Expected: all snapshots pass (existing + 4 new from Task 5)

- [ ] **Step 4: Server tests still pass (regression check)**

Run: `cd enterprise_server && npx vitest run tests/me/`
Expected: 16/16 pass (no regression from this plan; this plan made zero server changes)

- [ ] **Step 5: Manual smoke (`npm run dev` for the web)**

The web runs via `enterprise_server/web/package.json:11` (the `playwright test` script — find the dev script by reading `package.json`). Start the dev server, log in as a user with at least one bound and one unbound SSO connection, navigate to `/account/sso-bindings`, verify:

1. List loads, bound row shows "已绑定账号 kk@example.com" + 解绑 button
2. Unbound rows show 绑定 button
3. Search filters
4. Tab switch (全部 / 已绑定 / 未绑定) filters
5. Click 解绑 → button disabled → server returns 200 → toast "解绑成功" → list refetches → row flips to 未绑定
6. Click 绑定 on an unbound row → navigates to `/auth/sso/{id}/authorize?orgName=Acme` → 302 to IdP → (skip the actual IdP authorize if no test IdP) → user lands on dashboard → navigates back to `/account/sso-bindings` → row is now bound

If any of these fail, file a follow-up fix. The Task 6 deliverable is "all gates green" or "follow-up issues filed".

---

## Self-Review

**1. Spec coverage:** Spec sections ↔ task mapping:
- §"File Layout" → Tasks 1, 3, 4
- §"Page Component Skeleton" → Task 3
- §"Bind Flow" → Task 3 (`onBind`) + verified at Task 6 smoke #6
- §"Unbind Flow" → Task 3 (`unbindMut`) + verified at Task 6 smoke #5
- §"Data Type" → Task 1
- §"API Wrappers" → Task 1
- §"Routing" → Task 4
- §"Sidebar Entry" → Task 4
- §"UserMenu Update" → Task 4
- §"i18n" → Task 2 (all 24 keys)
- §"Test Strategy" → Tasks 1, 3, 5
- §"Review Focus" (5 lines) → Tests 1-5 (each pinned to a test in Task 3)

**2. Placeholder scan:** No TBD/TODO/FIXME/placeholder.

**3. Type consistency:**
- `SsoConnectionWithBinding` (Task 1) has 8 fields; the render test (Task 3 #2) uses an 8-field mock; the API wrapper test (Task 1) asserts the 8-field shape. All match the server's `enterprise_server/src/sso/bindingTypes.ts` (desktop Rulings 1+2 hold — no `description` / `boundAt`).
- IPC / route constants: `'/account/sso-bindings'` appears in Tasks 3 (test mocks `window.location.assign`), 4 (route + sidebar + menu), 5 (visual). Constant-ize if a 3rd+ use site appears (per CLAUDE.md String Constants rule); 3 sites doesn't yet trigger the rule.
- I18n key names: Task 2 lists 24 keys; Task 3's test asserts each one (`加载中…`, `加载失败`, `重试`, `绑定`, `解绑`, `已绑定`, `未绑定`, `已绑定账号 kk@example.com`, `尚未配置任何 SSO 连接`, `全部 2`, `已绑定 1`, `未绑定 1`).

**4. Review Focus:** 5 lines, each pinned to a test:
1. Cross-org leakage → Task 1 (api wrapper test) + Task 5 (visual baseline)
2. Bound-state desync after unbind → Task 3 #11
3. Stale cache after dashboard redirect → Task 3 #11b
4. Empty org with no connections → Task 3 #12 + Task 5 snapshot 1
5. `orgName` derivation → Task 3 #10
