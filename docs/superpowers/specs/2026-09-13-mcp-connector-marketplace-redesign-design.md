# 桌面端连接器：内置市场 + 企业市场 — Design Spec

**Date:** 2026-09-13
**Owner:** paul
**Status:** Approved in brainstorm (approach A — extend the existing `/api/mcp-marketplace` route; desktop adds an `enterpriseClient` method)

## Goal

Rework the GenWork desktop **连接器 (MCP)** page from its current
two-tab shape (`市场` / `已安装`) into three tabs:

1. **内置市场** (renamed from `市场`) — the desktop's **built-in** MCP
   catalog, curated in code, **independent of enterprise_server**.
2. **企业市场** (new) — the MCPs configured in enterprise_server's
   **MCP 管理**, scoped to the logged-in user's role, with a category
   filter that shows **only categories relevant to MCPs the user can see**.
3. **已安装** (unchanged).

企业市场 is installable: to *use* an enterprise MCP the user completes
**that MCP's own** authorization on the desktop (OAuth or their own API
key). No secret ever ships from enterprise_server to the desktop.

## Background (what exists today)

- **The current `市场` tab is server-backed, not local.**
  `McpManager.tsx` → `mcpService.fetchMarketplace()`
  (`src/renderer/services/mcp.ts:221`) → IPC `mcp:fetchMarketplace`
  (`src/main/ipcHandlers/mcp/handlers.ts:323`, product access/refresh
  token) → `GET {enterprise}/api/mcp-marketplace`. A localStorage cache
  (`mcpMarketplaceCache.v1`) + `convertMarketplaceToRegistry` feed the
  first frame; `mergeMarketplaceRegistry` re-injects the app-managed
  qichacha bundle.
- **The app-managed local catalog is tiny.** `src/renderer/data/mcpRegistry.ts`
  holds only the qichacha bundle + the `mcpCategories` fallback list. The
  rich list shown in the UI comes from the server payload.
- **Tabs are data-driven.** `src/renderer/components/mcp/mcpTabs.ts`
  (`McpTab`, `MCP_TAB_ORDER`, `MCP_TAB_LABEL_KEYS`); labels resolve through
  `i18nService.t(key)` in `src/renderer/services/i18n.ts`.
- **enterprise_server MCP data model** (post-migration 018):
  `mcp_marketplace_servers` (id, name/name_zh, description_en/zh, icon,
  `category_id` FK, `transport_type`, `command`, env-key arrays, `kind`,
  `enabled`, **`server_url`**, **`auth_method`** ∈ none/bearer/api-key/oauth,
  `credential_cipher`, `api_key_header`, `timeout_seconds`, **`allowed_roles`**
  JSONB, status/latency) and `mcp_marketplace_categories` (category_id,
  name_zh, name_en, display_order). **No `org_id`** — MCPs are global, scoped
  purely by `allowed_roles`.
- **`GET /api/mcp-marketplace`** (`enterprise_server/src/routes/mcpMarketplace.ts`,
  `requireAuth`) **already role-scopes**: `super_admin` sees all enabled
  servers; everyone else sees rows whose `allowed_roles` intersect their JWT
  `roles`. **Gap:** it returns **all** categories unconditionally.
- **Wire shape drift.** The server's `McpServerView` (018) and the desktop's
  `McpMarketplaceServer` type have already diverged (`description` single
  string vs `description_zh`/`_en`; `serverUrl`/`authMethod`/`credentialMasked`
  vs `icon`/`defaultArgs`/`requiredEnvKeys`). This change aligns them.
- **Desktop → enterprise_server auth stacks.** Two coexist against the same
  base URL (`ENTERPRISE_SERVER_URL`).
  - **Stack A — `enterpriseClient`** (`src/main/auth/enterpriseClient.ts`):
    org-login JWT, `authorization: Bearer <jwt>`, 401 → `loginGate.lock()`.
    This is the `/enterprise-models` pattern (`listEnterpriseModels`,
    `enterpriseClient.ts:252`), guarded by `loginGate.requireEnterprise()`.
    **This is the stack 企业市场 uses** (the org JWT carries `roles`).
  - **Stack B — `AuthSessionManager`** (`src/main/libs/authSessionManager.ts`):
    product access/refresh token; what the *current* 市场 tab uses.
- **i18n keys** (`src/renderer/services/i18n.ts`): `mcpMarketplace` (市场),
  `mcpInstalled` (已安装), `mcpAuthorized`, `mcpAddServer`, `mcpInstall`,
  `mcpServersCount`, `mcpSourceMarketplace`, `mcpInstalledEmptyMarket`,
  `mcpCategoryAll/Search/Browser/Developer/Productivity/Design/DataApi`.

## Decisions (locked)

| Decision | Choice |
| --- | --- |
| 内置市场 content | **Local curated catalog in code** — extend `mcpRegistry.ts` with a starter set of well-known public MCPs + the screenshot's categories. No enterprise dependency. |
| 企业市场 content | **`GET /api/mcp-marketplace`** (kept + fixed), role-scoped. Reads the admin-configured MCP list + categories. |
| Approach | **A — extend the existing route** (only change: category filter). Desktop adds `enterpriseClient.listEnterpriseMcps()` on the **org JWT** (Stack A). |
| Category filter (req #4) | **Server-side**: return only categories present in the user's *visible* server set (super_admin sees all). |
| Using an enterprise MCP | **Per-MCP, user-side auth** — OAuth browser flow or the user pasting their own key (reusing the qichacha-OAuth + MCP env-key patterns). **No secret shipped from enterprise.** |
| Existing `mcp:fetchMarketplace` desktop path | **Deleted** (becomes dead code once 内置市场 is local). The **server route is kept**, repurposed as the 企业市场 source. |
| Wire shape | **Align** desktop type to the server's `McpServerView` (018). |
| Audit row on 企业市场 reads | **Not added** (approach A). |

## Changes, in detail

### 1. Desktop — tabs & rename (UI shell)

- `mcpTabs.ts`: add `McpTab.EnterpriseMarket = 'enterprise-market'`.
  Order → `[McpTab.Marketplace /*内置市场*/, McpTab.EnterpriseMarket, McpTab.Installed]`.
  Add label key mapping.
- `i18n.ts`:
  - `mcpMarketplace`: `市场` → `内置市场` / `Marketplace` → `Built-in Marketplace`.
  - new `mcpEnterpriseMarketplace`: `企业市场` / `Enterprise Marketplace`.
  - update `mcpSourceMarketplace`, `mcpInstalledEmptyMarket` `市场` strings to
    `内置市场`.
- `McpManager.tsx` tab row (`~1249`) renders the new tab; count + active-state
  styling reuse existing `tabClass` / `tabIndicatorClass`.

### 2. Desktop — 内置市场 (local, no enterprise)

- Data source = app-managed catalog. **Extend `mcpRegistry.ts`** with a
  curated starter set of well-known public MCPs spanning the screenshot's
  categories (search / browser / developer / productivity / design / data-api),
  plus the existing qichacha bundle. (Starter entries are placeholders; the
  exact list is adjustable.)
- Categories for this tab = the local `mcpCategories` list (already
  i18n-keyed) — **not** the server.
- Card behavior unchanged: install / 已授权 / qichacha-OAuth.
- The 内置市场 tab no longer calls the enterprise endpoint.

### 3. Desktop — 企业市场 (enterprise, role-scoped)

- **Data flow:** `enterpriseClient.listEnterpriseMcps()` (org JWT, mirrors
  `listEnterpriseModels`) → `GET {enterprise}/api/mcp-marketplace` → new IPC
  channel → `mcpService.fetchEnterpriseMarketplace()` (own cache key).
  New IPC handler guarded by `loginGate.requireEnterprise()` (same pattern as
  the `enterpriseModels` handlers).
- **Contract:** align the desktop MCP type to the server's `McpServerView`
  (`name`, `name_zh`, `description`, `category`, `transportType`, `serverUrl`,
  `command`, `authMethod`, `credentialMasked`, `timeoutSeconds`, `allowedRoles`,
  `enabled`). `credentialMasked` / `allowedRoles` are display/telemetry only —
  **no real secret crosses the wire.**
- **Categories & filter:** chip row (styled per the reference image) built from
  the server's filtered `categories`; active chip filters the enterprise cards
  by `category`. Reuses the `dynamicCategories` + `filteredMarketplace`
  patterns but on the enterprise dataset.
- **Empty / unauth states:** enterprise not configured or not logged in →
  prompt to configure/log in (via `getBootstrapStatus`); role sees no MCPs →
  empty state.

### 4. Per-MCP authorization to use an enterprise MCP

- 企业市场 cards are browseable with a **Connect** action. Connecting triggers
  **that MCP's own** auth flow (never a secret from enterprise):
  - `auth_method: oauth` → OAuth browser flow (pattern: qichacha `connectQichacha`).
  - `auth_method: api-key` / `bearer` → a field for the user to paste their own
    key (pattern: MCP env-key input), stored per-server locally.
  - `auth_method: none` → connect with `serverUrl`.
- After auth it is a normal installed MCP in OpenClaw; shows 已授权.

### 5. enterprise_server — category filter (the one real gap)

- `src/routes/mcpMarketplace.ts`: after role-filtering the visible servers,
  derive the returned `categories` as the **distinct** `category_id`s among
  the visible set, joined to `mcp_marketplace_categories` (ordered by
  `display_order`). `super_admin` (sees all enabled servers) gets all of
  their categories. A category with zero visible servers is **not** returned.
  This satisfies "只加载登录用户有权限的 mcp 相关的 mcp 分类".

### 6. Cleanup — remove the dead desktop path (scoped step)

Once 内置市场 is fully local and 企业市场 uses `enterpriseClient`:
- Remove IPC channel `mcp:fetchMarketplace` (`shared/mcp/constants.ts`) +
  handler (`main/ipcHandlers/mcp/handlers.ts:323`) + its test
  (`handlers.test.ts` "FetchMarketplace handler").
- Remove `mcpService.fetchMarketplace` + the MCP marketplace localStorage
  cache (`MARKETPLACE_CACHE_KEY`, `read/writeMarketplaceCache`,
  `getCachedMarketplace`) + `convertMarketplaceToRegistry` **if** no longer
  referenced by 企业市场 (if 企业市场 reuses the same `McpServerView` shape it
  will have its own converter).
- **Keep** the unrelated skills `skills:fetchMarketplace` path.
- **Keep** the enterprise_server route.

## Testing

- **Server:** unit test the category filter — a restricted-role user sees only
  categories of their visible servers; a super_admin sees all; a category with
  no visible servers is absent. (Follow the existing `tests/` pglite harness.)
- **Desktop:**
  - Component: new tab renders; 企业市场 category chips render from the
    filtered server payload and filter cards; 内置市场 renders the local
    catalog.
  - Service: `fetchEnterpriseMarketplace` maps the `McpServerView` payload;
    unauth/not-configured returns a distinct state.
  - The deleted `FetchMarketplace` handler test is removed.

## Out of scope / follow-ups

- Authoring the **final** built-in MCP catalog list (this spec ships a
  starter set; the exact entries are product data to confirm).
- Position-inherited role scoping (today authz uses JWT `roles` =
  `extra_roles` only) — consistent with all existing gates; not widened here.
- Shipping decrypted credentials to the desktop — **explicitly rejected**
  (per-MCP user-side auth instead).

## Affected files (estimated)

Desktop:
- `src/renderer/components/mcp/mcpTabs.ts`
- `src/renderer/services/i18n.ts`
- `src/renderer/components/mcp/McpManager.tsx`
- `src/renderer/data/mcpRegistry.ts`
- `src/renderer/services/mcp.ts`
- `src/renderer/types/mcp.ts`, `src/renderer/types/electron.d.ts`
- `src/main/preload.ts`
- `src/main/ipcHandlers/mcp/handlers.ts` (+ test)
- `src/main/auth/enterpriseClient.ts`
- `src/shared/mcp/constants.ts`

enterprise_server:
- `src/routes/mcpMarketplace.ts`
- (test) category-filter coverage
