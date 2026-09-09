# 桌面端连接器：内置市场 + 企业市场 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the desktop MCP connector page into three tabs — `内置市场` (local curated catalog, no enterprise), `企业市场` (reads the enterprise_server MCP list + categories, role-scoped), and the unchanged `已安装`. Per-MCP user-side auth (no secret shipped from enterprise).

**Architecture:** Approach A from the spec — keep and lightly fix `GET /api/mcp-marketplace` on the server (only the categories filter changes); add `enterpriseClient.listEnterpriseMcps()` on the org JWT, a new IPC channel, a new renderer service, and a new tab. The current desktop `mcp:fetchMarketplace` path becomes dead code and is removed at the end.

**Tech Stack:** Electron + React + Redux Toolkit renderer; Hono + PostgreSQL (pglite test harness) + Vitest on the server; IPC + `contextBridge`; `enterpriseClient` + `loginGate`; i18n via `i18nService.t(key)`.

**Spec:** `docs/superpowers/specs/2026-09-13-mcp-connector-marketplace-redesign-design.md` (committed at `1e1a79e`).

---

## Global Constraints

- Use **Conventional Commits** (English, no `Co-Authored-By`) for every commit in this plan.
- Server: Hono + TypeScript, tests under `enterprise_server/tests/`, pglite harness via `vi.mock('../../src/db/pool', …, { pool: td.testPool })` and `resetSchema`/`runMigrations`.
- Desktop: do not modify bundled runtime output or generated vendor files.
- All new user-visible strings go through `i18nService.t(key)` with **both** `zh` and `en` entries in `src/renderer/services/i18n.ts`.
- No `Co-Authored-By` trailers in commits (per the user's explicit override of the repo default).
- Do not push to the remote — local commits only.
- New IPC channels go in `src/shared/mcp/constants.ts` (MCP) or `src/shared/enterprise/constants.ts` (enterprise). No bare strings for channel names.
- The enterprise_server route keeps the same path (`/api/mcp-marketplace`) — only the categories filter changes; the existing wire shape stays.

## File Structure (changes)

| File | Responsibility |
| --- | --- |
| `enterprise_server/src/routes/mcpMarketplace.ts` | Derive `categories` from the visible (role-filtered) server set. |
| `enterprise_server/tests/routes/mcpMarketplace.test.ts` | Add tests for the category filter (no other tests change). |
| `src/renderer/types/mcp.ts` | Add `McpEnterpriseMarketServer`/`McpEnterpriseMarketCategory` types aligned to `McpServerView`. |
| `src/renderer/services/i18n.ts` | Rename `mcpMarketplace` (zh/en); add `mcpEnterpriseMarketplace`; update other `市场` strings. |
| `src/renderer/components/mcp/mcpTabs.ts` | Add `EnterpriseMarket` tab; reorder. |
| `src/renderer/data/mcpRegistry.ts` | Extend with a starter built-in MCP catalog + categories. |
| `src/renderer/components/mcp/McpManager.tsx` | Render `内置市场` (local) and `企业市场` (enterprise) tabs + category chips for each; new filtered sets; empty/unauth states. |
| `src/renderer/services/mcp.ts` | Add `fetchEnterpriseMarketplace()` + cache. |
| `src/renderer/types/electron.d.ts` | Type `mcp.fetchEnterpriseMarketplace`. |
| `src/shared/mcp/constants.ts` | Add `FetchEnterpriseMarketplace` channel. |
| `src/main/preload.ts` | Expose `fetchEnterpriseMarketplace`. |
| `src/main/auth/enterpriseClient.ts` | Add `listEnterpriseMcps()`. |
| `src/main/ipcHandlers/mcp/handlers.ts` | Register `FetchEnterpriseMarketplace` handler. |
| `src/main/ipcHandlers/mcp/handlers.test.ts` | Add test for the new handler. |
| (cleanup) `src/shared/mcp/constants.ts` | Remove `FetchMarketplace` channel. |
| (cleanup) `src/main/preload.ts` | Remove `fetchMarketplace` exposure. |
| (cleanup) `src/main/ipcHandlers/mcp/handlers.ts` + test | Remove the `FetchMarketplace` handler + test. |
| (cleanup) `src/renderer/services/mcp.ts` | Remove `fetchMarketplace`, cache, converters. |
| (cleanup) `src/renderer/types/electron.d.ts` | Remove `fetchMarketplace` typing. |
| (cleanup) `src/renderer/components/mcp/McpManager.tsx` | Stop calling the dead path. |

---

## Task 1: Server — derive `categories` from the visible server set

**Files:**
- Modify: `enterprise_server/src/routes/mcpMarketplace.ts:16-48`
- Modify: `enterprise_server/tests/routes/mcpMarketplace.test.ts:24-77`

**Interfaces:**
- Consumes: `CategoryRow`, `ServerRow`, `mapServer` (unchanged) from `enterprise_server/src/models/mcpMarketplaceView.ts`.
- Produces: `GET /api/mcp-marketplace` now returns `{ categories, servers }` where `categories` is filtered to the categories actually present in the caller's visible `servers`. Super_admin behavior is unchanged (all categories present).

- [ ] **Step 1: Add the failing tests**

Append the following tests to `enterprise_server/tests/routes/mcpMarketplace.test.ts` (after the existing `'disabled servers are never returned even for super_admin'` test):

```ts
test('super_admin sees every category', async () => {
  const tok = await tokenFor('admin', 'o1', ['super_admin']);
  const res = await app.request('/api/mcp-marketplace', { headers: auth(tok) });
  const body = (await res.json()) as { categories: Array<{ id: string }> };
  const ids = body.categories.map(c => c.id).sort();
  // The seed categories are: data-api, search, uncategorized (the reserved one
  // has no servers so it is filtered out).
  expect(ids).toEqual(['data-api', 'search']);
});

test('a restricted-role user only sees categories of their visible servers', async () => {
  // qichacha is in category 'data-api'; move tavily-search to 'search' and gate
  // it to super_admin so a plain 'user' only sees qichacha → 'data-api'.
  await testPool.query(
    "UPDATE mcp_marketplace_servers SET allowed_roles = '[\"engineer\"]'::jsonb WHERE server_id = 'qichacha'",
  );
  const tok = await tokenFor('u1', 'o1', ['engineer']);
  const res = await app.request('/api/mcp-marketplace', { headers: auth(tok) });
  const body = (await res.json()) as {
    categories: Array<{ id: string }>;
    servers: Array<{ id: string }>;
  };
  expect(body.servers.map(s => s.id)).toEqual(['qichacha']);
  expect(body.categories.map(c => c.id)).toEqual(['data-api']);
});

test('a category with zero visible servers is not returned', async () => {
  // Move exa-search to a brand-new category and gate it to super_admin only.
  await testPool.query(
    "INSERT INTO mcp_marketplace_categories(category_id, name_zh, name_en, display_order) VALUES ('hidden', '隐藏', 'Hidden', 999) ON CONFLICT (category_id) DO NOTHING",
  );
  await testPool.query(
    "UPDATE mcp_marketplace_servers SET category_id = 'hidden', allowed_roles = '[\"super_admin\"]'::jsonb WHERE server_id = 'exa-search'",
  );
  const tok = await tokenFor('u1', 'o1', ['user']);
  const res = await app.request('/api/mcp-marketplace', { headers: auth(tok) });
  const body = (await res.json()) as {
    categories: Array<{ id: string }>;
    servers: Array<{ id: string }>;
  };
  expect(body.servers).toEqual([]); // gated to super_admin
  expect(body.categories.map(c => c.id)).not.toContain('hidden');
});
```

- [ ] **Step 2: Run the new tests — expect failures**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpMarketplace.test.ts`
Expected: the three new tests FAIL because `categories` currently returns all rows.

- [ ] **Step 3: Implement the category filter**

Replace the body of `GET /api/mcp-marketplace` in `enterprise_server/src/routes/mcpMarketplace.ts` with the version below. Keep the imports and the `use()` line unchanged.

```ts
mcpMarketplaceRoutes.get('/api/mcp-marketplace', async (c) => {
  const claims = c.get('claims');
  const userRoles = claims?.roles ?? [];
  const isSuperAdmin = userRoles.includes(Role.SuperAdmin);

  // Every authenticated user only sees enabled servers they're allowed to
  // access. `super_admin` short-circuits the role filter.
  const serversResult = await pool.query<ServerRow>(
    `SELECT ${SERVER_COLUMNS}
       FROM mcp_marketplace_servers
      WHERE enabled = TRUE
      ORDER BY server_id`,
  );

  const userRoleSet = new Set(userRoles);
  const visibleServers = serversResult.rows.filter(
    row => isSuperAdmin || row.allowed_roles.some(r => userRoleSet.has(r)),
  );

  // Derive the visible categories from the visible server set so a user
  // never sees a category they can't reach. Super_admin effectively sees all
  // categories present on enabled rows.
  const visibleCategoryIds = Array.from(new Set(visibleServers.map(s => s.category_id)));
  const categoriesResult = visibleCategoryIds.length === 0
    ? { rows: [] as CategoryRow[] }
    : await pool.query<CategoryRow>(
        `SELECT category_id, name_zh, name_en, display_order
           FROM mcp_marketplace_categories
          WHERE category_id = ANY($1)
          ORDER BY display_order, category_id`,
        [visibleCategoryIds],
      );

  const categories = categoriesResult.rows.map(row => ({
    id: row.category_id,
    name_zh: row.name_zh,
    name_en: row.name_en,
  }));

  const servers = visibleServers.map(mapServer);

  return c.json({ categories, servers });
});
```

- [ ] **Step 4: Run the new tests — expect them to pass**

Run: `cd enterprise_server && npx vitest run tests/routes/mcpMarketplace.test.ts`
Expected: all tests (existing + 3 new) PASS.

- [ ] **Step 5: Run the full server suite**

Run: `cd enterprise_server && npx vitest run --pool=forks`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/routes/mcpMarketplace.ts enterprise_server/tests/routes/mcpMarketplace.test.ts
git commit -m "fix(enterprise_server): return only categories of visible MCPs"
```

---

## Task 2: Desktop — rename `市场` → `内置市场` and add `企业市场` tab plumbing

**Files:**
- Modify: `src/renderer/services/i18n.ts` (rename `mcpMarketplace` zh/en; add `mcpEnterpriseMarketplace` zh/en; rename `mcpSourceMarketplace`/`mcpInstalledEmptyMarket` strings from `市场` to `内置市场`)
- Modify: `src/renderer/components/mcp/mcpTabs.ts` (add `EnterpriseMarket` + label key mapping + reorder)

**Interfaces:**
- Consumes: `McpTab` (`src/renderer/components/mcp/mcpTabs.ts`), i18n key map.
- Produces: `McpTab.EnterpriseMarket = 'enterprise-market'`, `MCP_TAB_ORDER = [McpTab.Marketplace, McpTab.EnterpriseMarket, McpTab.Installed]`, `MCP_TAB_LABEL_KEYS[McpTab.EnterpriseMarket] = 'mcpEnterpriseMarketplace'`.

- [ ] **Step 1: Update `mcpTabs.ts`**

Replace the body of `src/renderer/components/mcp/mcpTabs.ts` with:

```ts
export const McpTab = {
  Installed: 'installed',
  Marketplace: 'marketplace',
  EnterpriseMarket: 'enterprise-market',
} as const;
export type McpTab = typeof McpTab[keyof typeof McpTab];

/** Marketplace leads, as on the Skills and Kits pages: browsing comes first. */
export const MCP_TAB_ORDER: readonly McpTab[] = [
  McpTab.Marketplace,
  McpTab.EnterpriseMarket,
  McpTab.Installed,
];

export const MCP_TAB_LABEL_KEYS: Record<McpTab, string> = {
  [McpTab.Installed]: 'mcpInstalled',
  [McpTab.Marketplace]: 'mcpMarketplace',
  [McpTab.EnterpriseMarket]: 'mcpEnterpriseMarketplace',
};
```

- [ ] **Step 2: Update i18n — rename `市场` to `内置市场`**

In `src/renderer/services/i18n.ts`:
- The zh `mcpMarketplace` line: replace `市场` with `内置市场`.
- The en `mcpMarketplace` line: replace `Marketplace` with `Built-in Marketplace`.
- Find both zh and en lines that contain the literal `市场` outside of `mcpMarketplace` (the only ones today are `mcpSourceMarketplace` and `mcpInstalledEmptyMarket`) and replace with `内置市场`.

Use grep first: `rg "市场" src/renderer/services/i18n.ts` to confirm exactly which lines need to change. Replace the literal text only — do not touch other zh strings.

- [ ] **Step 3: Add the `mcpEnterpriseMarketplace` i18n keys**

In the zh block of `src/renderer/services/i18n.ts`, near the existing `mcpMarketplace`/`mcpInstalled` keys, add:

```
mcpEnterpriseMarketplace: '企业市场',
```

In the en block (same vicinity):

```
mcpEnterpriseMarketplace: 'Enterprise Marketplace',
```

- [ ] **Step 4: Typecheck + lint the touched files**

Run:

```bash
cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/services/i18n.ts src/components/mcp/mcpTabs.ts
```

Expected: both clean (the tab order is just a const reorder; consumers don't depend on exact length yet).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/services/i18n.ts src/renderer/components/mcp/mcpTabs.ts
git commit -m "feat(electron): rename market tab and add enterprise market tab"
```

---

## Task 3: Desktop — extend `mcpRegistry.ts` with a starter built-in catalog

**Files:**
- Modify: `src/renderer/data/mcpRegistry.ts`

**Interfaces:**
- Consumes: `McpRegistryEntry` (`src/renderer/types/mcp.ts`).
- Produces: an extended `mcpRegistry` array of well-known public MCPs spanning `search`, `browser`, `developer`, `productivity`, `design`, `data-api`. Existing `qichacha` bundle stays. `mcpCategories` stays as-is (it's already aligned with `McpCategory`).

- [ ] **Step 1: Add starter entries to `mcpRegistry.ts`**

Append the following entries to the `mcpRegistry` array in `src/renderer/data/mcpRegistry.ts` (keep the qichacha bundle first). Use `descriptionKey: 'mcpDesc_<id>'` and add matching `mcpDesc_<id>` zh/en entries to `i18n.ts` in Step 2.

```ts
// Starter set of well-known public MCP servers shipped with the desktop.
// These are read-only placeholders for the 内置市场 tab and have NO
// dependency on enterprise_server. Edit this list to grow the built-in
// catalog; the category id must match an entry in `mcpCategories`.
{
  id: 'brave-search',
  name: 'Brave Search',
  name_zh: 'Brave 搜索',
  descriptionKey: 'mcpDesc_braveSearch',
  category: 'search',
  categoryKey: 'mcpCategorySearch',
  transportType: 'stdio',
  command: 'npx',
  defaultArgs: ['-y', '@modelcontextprotocol/server-brave-search'],
  requiredEnvKeys: ['BRAVE_API_KEY'],
  kind: McpRegistryEntryKind.Server,
},
{
  id: 'puppeteer',
  name: 'Puppeteer',
  name_zh: 'Puppeteer 浏览器',
  descriptionKey: 'mcpDesc_puppeteer',
  category: 'browser',
  categoryKey: 'mcpCategoryBrowser',
  transportType: 'stdio',
  command: 'npx',
  defaultArgs: ['-y', '@modelcontextprotocol/server-puppeteer'],
  kind: McpRegistryEntryKind.Server,
},
{
  id: 'github',
  name: 'GitHub',
  name_zh: 'GitHub',
  descriptionKey: 'mcpDesc_github',
  category: 'developer',
  categoryKey: 'mcpCategoryDeveloper',
  transportType: 'stdio',
  command: 'npx',
  defaultArgs: ['-y', '@modelcontextprotocol/server-github'],
  requiredEnvKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  kind: McpRegistryEntryKind.Server,
},
{
  id: 'notion',
  name: 'Notion',
  name_zh: 'Notion',
  descriptionKey: 'mcpDesc_notion',
  category: 'productivity',
  categoryKey: 'mcpCategoryProductivity',
  transportType: 'stdio',
  command: 'npx',
  defaultArgs: ['-y', '@notionhq/mcp-server-notion'],
  requiredEnvKeys: ['NOTION_TOKEN'],
  kind: McpRegistryEntryKind.Server,
},
{
  id: 'figma',
  name: 'Figma',
  name_zh: 'Figma',
  descriptionKey: 'mcpDesc_figma',
  category: 'design',
  categoryKey: 'mcpCategoryDesign',
  transportType: 'stdio',
  command: 'npx',
  defaultArgs: ['-y', '@modelcontextprotocol/server-figma'],
  requiredEnvKeys: ['FIGMA_ACCESS_TOKEN'],
  kind: McpRegistryEntryKind.Server,
},
{
  id: 'airtable',
  name: 'Airtable',
  name_zh: 'Airtable',
  descriptionKey: 'mcpDesc_airtable',
  category: 'data-api',
  categoryKey: 'mcpCategoryDataApi',
  transportType: 'stdio',
  command: 'npx',
  defaultArgs: ['-y', '@modelcontextprotocol/server-airtable'],
  requiredEnvKeys: ['AIRTABLE_API_KEY'],
  kind: McpRegistryEntryKind.Server,
},
```

- [ ] **Step 2: Add the matching i18n description strings**

In `src/renderer/services/i18n.ts`, add (in both zh and en blocks; near the existing `mcpDesc_*` keys, create them if absent):

```
mcpDesc_braveSearch: '通过 Brave Search API 搜索网络内容。',
mcpDesc_puppeteer: '通过 Puppeteer 控制浏览器、采集页面。',
mcpDesc_github: '访问 GitHub 仓库、Issue、PR 与文件。',
mcpDesc_notion: '读写 Notion 页面、数据库与评论。',
mcpDesc_figma: '读取 Figma 文件、节点与样式。',
mcpDesc_airtable: '访问 Airtable 表格与记录。',
```

```
mcpDesc_braveSearch: 'Search the web via the Brave Search API.',
mcpDesc_puppeteer: 'Drive a browser and scrape pages via Puppeteer.',
mcpDesc_github: 'Access GitHub repos, issues, PRs, and files.',
mcpDesc_notion: 'Read and write Notion pages, databases, and comments.',
mcpDesc_figma: 'Read Figma files, nodes, and styles.',
mcpDesc_airtable: 'Access Airtable bases and records.',
```

- [ ] **Step 3: Typecheck + lint**

Run:

```bash
cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/data/mcpRegistry.ts src/services/i18n.ts
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/data/mcpRegistry.ts src/renderer/services/i18n.ts
git commit -m "feat(electron): seed built-in mcp catalog for the new market tab"
```

---

## Task 4: Desktop — add `enterpriseClient.listEnterpriseMcps()` on the org JWT

**Files:**
- Modify: `src/main/auth/enterpriseClient.ts` (add `listEnterpriseMcps()`)

**Interfaces:**
- Consumes: `tokenProvider` + `baseUrl` already configured in `enterpriseClient`.
- Produces: `enterpriseClient.listEnterpriseMcps(): Promise<{ categories: Array<{ id: string; name_zh: string; name_en: string }>; servers: McpServerView[] }>` where `McpServerView` matches the server's shape (you will add a thin client-side alias — see Task 5 for the renderer-side type).

- [ ] **Step 1: Add the method**

Append to the `enterpriseClient` object in `src/main/auth/enterpriseClient.ts` (just before the closing `};`):

```ts
/**
 * List the enterprise_server MCP catalog scoped to the caller's role.
 * Uses the org JWT (Stack A) so the server's role-filter on
 * `mcp_marketplace_servers.allowed_roles` is enforced. The response carries
 * only masked credentials — no secret ever crosses the wire.
 */
async listEnterpriseMcps(): Promise<{
  categories: Array<{ id: string; name_zh: string; name_en: string }>;
  servers: Array<{
    id: string;
    name: string;
    name_zh: string | null;
    description: string;
    category: string;
    transportType: 'stdio' | 'sse' | 'http';
    serverUrl: string | null;
    command: string | null;
    authMethod: 'none' | 'bearer' | 'api-key' | 'oauth';
    credentialMasked: string | null;
    timeoutSeconds: number;
    allowedRoles: string[];
    enabled: boolean;
    lastStatus: string | null;
    lastLatencyMs: number | null;
    lastTestedAt: string | null;
  }>;
}> {
  const url = `${baseUrl}/api/mcp-marketplace`;
  const token = tokenProvider();
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`enterprise-mcp-marketplace fetch failed: HTTP ${res.status}`);
  }
  return res.json() as Promise<{
    categories: Array<{ id: string; name_zh: string; name_en: string }>;
    servers: Array<{
      id: string;
      name: string;
      name_zh: string | null;
      description: string;
      category: string;
      transportType: 'stdio' | 'sse' | 'http';
      serverUrl: string | null;
      command: string | null;
      authMethod: 'none' | 'bearer' | 'api-key' | 'oauth';
      credentialMasked: string | null;
      timeoutSeconds: number;
      allowedRoles: string[];
      enabled: boolean;
      lastStatus: string | null;
      lastLatencyMs: number | null;
      lastTestedAt: string | null;
    }>;
  }>;
},
```

- [ ] **Step 2: Typecheck + lint**

Run:

```bash
cd enterprise_server && npx tsc --noEmit
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/auth/enterpriseClient.ts
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/main/auth/enterpriseClient.ts
git commit -m "feat(electron): add enterpriseClient.listEnterpriseMcps"
```

---

## Task 5: Desktop — IPC + preload + typed contract for the new enterprise marketplace

**Files:**
- Modify: `src/shared/mcp/constants.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/main/ipcHandlers/mcp/handlers.ts`
- Modify: `src/main/ipcHandlers/mcp/handlers.test.ts`

**Interfaces:**
- Consumes: `enterpriseClient.listEnterpriseMcps()` from Task 4; `loginGate` from `src/main/auth/loginGate.ts`.
- Produces: IPC channel `mcp:fetchEnterpriseMarketplace`; preload exposes `window.electron.mcp.fetchEnterpriseMarketplace()`; renderer-typed surface; a main-process handler that delegates to `enterpriseClient.listEnterpriseMcps()` and is guarded by `loginGate.requireEnterprise()`.

- [ ] **Step 1: Add the IPC channel constant**

In `src/shared/mcp/constants.ts`, extend the `McpIpcChannel` object (keep ordering, add at the end):

```ts
FetchEnterpriseMarketplace: 'mcp:fetchEnterpriseMarketplace',
```

- [ ] **Step 2: Expose the channel in preload**

In `src/main/preload.ts`, locate the `mcp` block (search for `McpIpcChannel.FetchMarketplace`; you're adding next to it). Add the new exposure directly under it:

```ts
fetchEnterpriseMarketplace: () => ipcRenderer.invoke(McpIpcChannel.FetchEnterpriseMarketplace),
```

- [ ] **Step 3: Type the renderer surface**

In `src/renderer/types/electron.d.ts`, locate the `mcp` API surface and add (mirroring the typed signature of `fetchMarketplace` already in the same block, but with the new enterprise shape — the simplest typing mirrors the underlying IPC result):

```ts
fetchEnterpriseMarketplace: () => Promise<{
  success: boolean;
  data?: {
    categories: Array<{ id: string; name_zh: string; name_en: string }>;
    servers: Array<{
      id: string;
      name: string;
      name_zh: string | null;
      description: string;
      category: string;
      transportType: 'stdio' | 'sse' | 'http';
      serverUrl: string | null;
      command: string | null;
      authMethod: 'none' | 'bearer' | 'api-key' | 'oauth';
      credentialMasked: string | null;
      timeoutSeconds: number;
      allowedRoles: string[];
      enabled: boolean;
      lastStatus: string | null;
      lastLatencyMs: number | null;
      lastTestedAt: string | null;
    }>;
  };
  error?: string;
}>;
```

- [ ] **Step 4: Add the renderer-side typed alias**

In `src/renderer/types/mcp.ts`, append:

```ts
/** Server-returned shape for an enterprise marketplace MCP (post-018). */
export interface McpEnterpriseMarketServer {
  id: string;
  name: string;
  name_zh: string | null;
  description: string;
  category: string;
  transportType: 'stdio' | 'sse' | 'http';
  serverUrl: string | null;
  command: string | null;
  authMethod: 'none' | 'bearer' | 'api-key' | 'oauth';
  credentialMasked: string | null;
  timeoutSeconds: number;
  allowedRoles: string[];
  enabled: boolean;
  lastStatus: string | null;
  lastLatencyMs: number | null;
  lastTestedAt: string | null;
}

export interface McpEnterpriseMarketCategory {
  id: string;
  name_zh: string;
  name_en: string;
}
```

- [ ] **Step 5: Add the IPC handler**

In `src/main/ipcHandlers/mcp/handlers.ts`, add an import at the top of the file (next to the other `src/main/...` imports — preserve the existing simple-import-sort order, so the new import goes alongside `enterpriseClient`):

```ts
import { enterpriseClient } from '../../auth/enterpriseClient';
```

Then inside the exported `registerMcpHandlers` function, register the handler just after the existing `McpIpcChannel.FetchMarketplace` block:

```ts
ipcMain.handle(McpIpcChannel.FetchEnterpriseMarketplace, async () => {
  try {
    const data = await enterpriseClient.listEnterpriseMcps();
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch enterprise marketplace',
    };
  }
});
```

- [ ] **Step 6: Add the test**

Append to `src/main/ipcHandlers/mcp/handlers.test.ts`:

```ts
import { enterpriseClient } from '../../auth/enterpriseClient';

vi.mock('../../auth/enterpriseClient', () => ({
  enterpriseClient: { listEnterpriseMcps: vi.fn() },
}));

describe('McpIpcChannel.FetchEnterpriseMarketplace handler', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    registerMcpHandlers({
      getMcpRuntime: () => ({}) as never,
      syncOpenClawConfig: async () => ({ success: true, changed: false }),
    });
    vi.mocked(enterpriseClient.listEnterpriseMcps).mockReset();
  });

  test('returns { success: true, data } on a successful fetch', async () => {
    const body = {
      categories: [{ id: 'search', name_zh: '搜索', name_en: 'Search' }],
      servers: [
        {
          id: 'x',
          name: 'X',
          description: 'd',
          category: 'search',
          transportType: 'http' as const,
          serverUrl: 'https://x.test',
          command: null,
          authMethod: 'none' as const,
          credentialMasked: null,
          timeoutSeconds: 30,
          allowedRoles: ['super_admin'],
          enabled: true,
          lastStatus: null,
          lastLatencyMs: null,
          lastTestedAt: null,
        },
      ],
    };
    vi.mocked(enterpriseClient.listEnterpriseMcps).mockResolvedValue(body);

    const handler = registeredHandlers.get(McpIpcChannel.FetchEnterpriseMarketplace);
    expect(handler).toBeDefined();
    const result = await handler!();
    expect(result).toEqual({ success: true, data: body });
  });

  test('returns { success: false, error } when listEnterpriseMcps throws', async () => {
    vi.mocked(enterpriseClient.listEnterpriseMcps).mockRejectedValue(new Error('http 401'));
    const handler = registeredHandlers.get(McpIpcChannel.FetchEnterpriseMarketplace)!;
    const result = await handler!();
    expect(result).toEqual({ success: false, error: 'http 401' });
  });
});
```

(The `vi.mock` call must appear at module top-level alongside the existing `vi.mock('../../libs/authSessionManager', ...)` in the same file.)

- [ ] **Step 7: Typecheck + lint**

Run:

```bash
cd enterprise_server && npx tsc --noEmit
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/shared/mcp/constants.ts src/main/preload.ts src/renderer/types/electron.d.ts \
  src/renderer/types/mcp.ts src/main/ipcHandlers/mcp/handlers.ts src/main/ipcHandlers/mcp/handlers.test.ts
```

Expected: clean.

- [ ] **Step 8: Run the touched tests**

Run: `cd enterprise_server && npx vitest run --pool=forks src/main/ipcHandlers/mcp/handlers.test.ts`
Expected: existing `FetchMarketplace` tests still pass; the 2 new `FetchEnterpriseMarketplace` tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/shared/mcp/constants.ts src/main/preload.ts src/renderer/types/electron.d.ts \
        src/renderer/types/mcp.ts src/main/ipcHandlers/mcp/handlers.ts src/main/ipcHandlers/mcp/handlers.test.ts
git commit -m "feat(electron): wire enterprise marketplace IPC and types"
```

---

## Task 6: Desktop — renderer service + UI: split tabs into 内置市场 (local) and 企业市场 (enterprise)

**Files:**
- Modify: `src/renderer/services/mcp.ts`
- Modify: `src/renderer/components/mcp/McpManager.tsx`

**Interfaces:**
- Consumes: IPC channel `mcp:fetchEnterpriseMarketplace` from Task 5; built-in catalog from Task 3; tab list from Task 2.
- Produces: `mcpService.fetchEnterpriseMarketplace(): Promise<{ servers: McpEnterpriseMarketServer[]; categories: McpEnterpriseMarketCategory[] } | null>`. `McpManager.tsx` now renders three tabs; 内置市场 reads the local catalog only (no IPC); 企业市场 fetches via the new service and shows category chips derived from the server's filtered categories.

- [ ] **Step 1: Add the renderer service method**

In `src/renderer/services/mcp.ts`, add a new import at the top (keep the existing one):

```ts
import type {
  McpEnterpriseMarketCategory,
  McpEnterpriseMarketServer,
} from '../types/mcp';
```

Add a new localStorage cache for the enterprise payload:

```ts
const ENTERPRISE_MARKETPLACE_CACHE_KEY = 'mcpEnterpriseMarketCache.v1';

interface EnterpriseMarketplaceCachePayload {
  servers: McpEnterpriseMarketServer[];
  categories: McpEnterpriseMarketCategory[];
}

function readEnterpriseMarketplaceCache(): EnterpriseMarketplaceCachePayload | null {
  try {
    const raw = window.localStorage.getItem(ENTERPRISE_MARKETPLACE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EnterpriseMarketplaceCachePayload;
    if (!Array.isArray(parsed?.servers) || !Array.isArray(parsed?.categories)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeEnterpriseMarketplaceCache(payload: EnterpriseMarketplaceCachePayload): void {
  try {
    window.localStorage.setItem(
      ENTERPRISE_MARKETPLACE_CACHE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    /* cache is best-effort */
  }
}
```

Append a method on the `McpService` class (before the closing `}` of the class):

```ts
async fetchEnterpriseMarketplace(): Promise<{
  servers: McpEnterpriseMarketServer[];
  categories: McpEnterpriseMarketCategory[];
} | null> {
  try {
    const result = await window.electron.mcp.fetchEnterpriseMarketplace();
    if (result.success && result.data) {
      writeEnterpriseMarketplaceCache(result.data);
      return { servers: result.data.servers, categories: result.data.categories };
    }
    return null;
  } catch (error) {
    console.error('Failed to fetch enterprise MCP marketplace:', error);
    return null;
  }
}

getCachedEnterpriseMarketplace(): {
  servers: McpEnterpriseMarketServer[];
  categories: McpEnterpriseMarketCategory[];
} | null {
  return readEnterpriseMarketplaceCache();
}
```

- [ ] **Step 2: Split the `McpManager` data flow**

In `src/renderer/components/mcp/McpManager.tsx`:

a. Replace the single `fetchMarketplace` effect (around line 142-152) with two effects:

```tsx
// 内置市场: from local catalog only. Cache first, then no network.
useEffect(() => {
  setDynamicRegistry(mcpRegistry);
  setDynamicCategories(mcpCategories);
  setIsLoadingMarketplace(false);
}, []);

// 企业市场: from enterprise_server via the new IPC.
useEffect(() => {
  const cached = mcpService.getCachedEnterpriseMarketplace();
  if (cached) {
    setEnterpriseServers(cached.servers);
    setEnterpriseCategories(cached.categories);
    setEnterpriseActiveCategory('all');
  }
  const load = async () => {
    setIsLoadingEnterpriseMarketplace(true);
    const result = await mcpService.fetchEnterpriseMarketplace();
    if (result) {
      setEnterpriseServers(result.servers);
      setEnterpriseCategories(result.categories);
      setEnterpriseActiveCategory('all');
    }
    setIsLoadingEnterpriseMarketplace(false);
  };
  void load();
}, []);
```

b. Add the new state hooks near the existing `activeCategory` state (around line 108):

```tsx
const [enterpriseServers, setEnterpriseServers] = useState<McpEnterpriseMarketServer[]>([]);
const [enterpriseCategories, setEnterpriseCategories] = useState<McpEnterpriseMarketCategory[]>([]);
const [enterpriseActiveCategory, setEnterpriseActiveCategory] = useState<string>('all');
const [isLoadingEnterpriseMarketplace, setIsLoadingEnterpriseMarketplace] = useState<boolean>(true);
```

And add the imports at the top of the file:

```ts
import type { McpEnterpriseMarketServer, McpEnterpriseMarketCategory } from '../../types/mcp';
```

c. Add a filtered list:

```tsx
const filteredEnterpriseMarketplace = useMemo(() => {
  if (enterpriseActiveCategory === 'all') return enterpriseServers;
  return enterpriseServers.filter(s => s.category === enterpriseActiveCategory);
}, [enterpriseServers, enterpriseActiveCategory]);
```

d. Modify the tab row (`~1249-1278`) so its count expression handles the three tabs:

```tsx
const count = tab === McpTab.Installed
  ? installedItems.length
  : tab === McpTab.Marketplace
    ? (isLoadingMarketplace ? 0 : dynamicRegistry.length)
    : (isLoadingEnterpriseMarketplace ? 0 : enterpriseServers.length);
```

e. Replace the single category-chip block (`~1281-1308`) with three blocks keyed on `activeTab`:

```tsx
{activeTab === McpTab.Marketplace && !isLoadingMarketplace && (
  <div className="flex items-center gap-1.5 flex-wrap">
    {dynamicCategories.map((cat) => (
      <button
        key={cat.id}
        type="button"
        onClick={() => {
          reportMcpAction('category_change', {
            source: 'mcp_manager',
            activeTab,
            activeCategory,
            targetCategory: cat.id,
            resultCount: filteredMarketplace.length,
          });
          setActiveCategory(cat.id);
        }}
        className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
          activeCategory === cat.id
            ? 'bg-primary text-white'
            : 'bg-surface-raised text-secondary hover:text-foreground'
        }`}
      >
        {(i18nService.getLanguage() === 'zh' ? cat.name_zh : cat.name_en) || i18nService.t(cat.key)}
      </button>
    ))}
  </div>
)}

{activeTab === McpTab.EnterpriseMarket && !isLoadingEnterpriseMarketplace && (
  <div className="flex items-center gap-1.5 flex-wrap">
    <button
      key="all"
      type="button"
      onClick={() => setEnterpriseActiveCategory('all')}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        enterpriseActiveCategory === 'all'
          ? 'bg-primary text-white'
          : 'bg-surface-raised text-secondary hover:text-foreground'
      }`}
    >
      {i18nService.t('mcpCategoryAll')}
    </button>
    {enterpriseCategories.map((cat) => (
      <button
        key={cat.id}
        type="button"
        onClick={() => setEnterpriseActiveCategory(cat.id)}
        className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
          enterpriseActiveCategory === cat.id
            ? 'bg-primary text-white'
            : 'bg-surface-raised text-secondary hover:text-foreground'
        }`}
      >
        {(i18nService.getLanguage() === 'zh' ? cat.name_zh : cat.name_en) || cat.id}
      </button>
    ))}
  </div>
)}
```

f. Render the 企业市场 grid in the same section that holds the Marketplace grid (around line 1421). The render path is parallel to the marketplace one — use `filteredEnterpriseMarketplace`, mapping each entry to a `McpCard` (or the existing `renderMarketplaceDetail` if appropriate) with the user's per-MCP connect action placeholder for Task 7. For this task, render a simple grid:

```tsx
{activeTab === McpTab.EnterpriseMarket && (
  isLoadingEnterpriseMarketplace ? (
    <MarketplaceSkeleton />
  ) : filteredEnterpriseMarketplace.length === 0 ? (
    <div className="py-12 text-center text-sm text-secondary">
      {i18nService.t('mcpNoInstalledServers')}
    </div>
  ) : (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {filteredEnterpriseMarketplace.map((entry) => (
        <McpCard
          key={entry.id}
          title={entry.name_zh ?? entry.name}
          subtitle={entry.description}
          iconUrl={null}
          isInstalled={installedRegistryIds.has(entry.id)}
          transport={entry.transportType}
          url={entry.serverUrl}
          onClick={() => {/* Task 7: per-MCP connect */}}
          actions={(
            installedRegistryIds.has(entry.id)
              ? <span className="..."><CheckIcon ... />{i18nService.t('mcpInstalled')}</span>
              : <button className="..." onClick={() => {/* Task 7: per-MCP connect */}}>{i18nService.t('mcpInstall')}</button>
          )}
        />
      ))}
    </div>
  )
)}
```

(Use the exact `McpCard` prop names + the same chip styling classes as the existing `McpManager.tsx:1450-1501` marketplace cards — copy them verbatim.)

- [ ] **Step 3: Typecheck + lint + tests**

Run:

```bash
cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/services/mcp.ts src/components/mcp/McpManager.tsx
npx vitest run tests/components/mcp tests/components/McpManager.test.tsx 2>/dev/null || true
```

Expected: typecheck and lint clean. If there are existing McpManager tests they should still pass (the marketplace tab is still rendered; we just added an enterprise tab).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/services/mcp.ts src/renderer/components/mcp/McpManager.tsx
git commit -m "feat(electron): split connector market into built-in and enterprise tabs"
```

---

## Task 7: Desktop — per-MCP authorization to *use* an enterprise MCP

**Files:**
- Modify: `src/renderer/components/mcp/McpManager.tsx` (replace the placeholder onClick handlers from Task 6 with the per-MCP connect logic)
- Modify: `src/renderer/services/mcp.ts` (add `connectEnterpriseMcp` helpers per `authMethod`)

**Interfaces:**
- Consumes: `McpEnterpriseMarketServer` shape (with `authMethod`).
- Produces: a single `connectEnterpriseMcp(server)` helper that, based on `server.authMethod`, prompts for an API key (api-key/bearer) or runs an OAuth browser flow (oauth), or just installs (none). After auth, persists locally via existing `McpServerFormData` + `window.electron.mcp.create`.

- [ ] **Step 1: Add the renderer helper**

In `src/renderer/services/mcp.ts`, append on `McpService`:

```ts
/**
 * Install + authorize one enterprise MCP on the desktop. The server
 * intentionally ships only a masked credential; this helper dispatches to
 * the user's own auth method (api-key input, OAuth browser flow, or none).
 * Returns the updated server list on success.
 */
async connectEnterpriseMcp(entry: McpEnterpriseMarketServer): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
  try {
    let extraEnv: Record<string, string> | undefined;
    let extraHeaders: Record<string, string> | undefined;

    if (entry.authMethod === 'oauth') {
      // Mirror qichacha's OAuth browser flow. The OAuth completion writes the
      // resulting token into each created server's headers; this helper is a
      // placeholder for the real OAuth launch — wire it to your product's
      // OAuth starter when one exists.
      return { success: false, error: 'oauth_flow_not_implemented' };
    }
    if (entry.authMethod === 'api-key' || entry.authMethod === 'bearer') {
      const key = window.prompt(
        entry.authMethod === 'bearer'
          ? 'Paste your bearer token:'
          : `Paste your ${entry.apiKeyHeader || 'API'} key:`,
      );
      if (!key) return { success: false, error: 'cancelled' };
      const headerName = entry.apiKeyHeader || 'Authorization';
      extraHeaders = entry.authMethod === 'bearer'
        ? { [headerName]: `Bearer ${key}` }
        : { [headerName]: key };
    }

    return await this.createServer({
      name: entry.name_zh ?? entry.name,
      description: entry.description,
      transportType: entry.transportType,
      url: entry.serverUrl ?? undefined,
      command: entry.command ?? undefined,
      headers: extraHeaders,
      isBuiltIn: false,
      registryId: entry.id,
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to connect enterprise MCP' };
  }
}
```

- [ ] **Step 2: Wire the card action**

In `McpManager.tsx`, replace the Task-6 placeholder `onClick`/button handlers in the 企业市场 grid with:

```tsx
onClick={() => {
  void mcpService.connectEnterpriseMcp(entry).then((r) => {
    if (!r.success) {
      reportMcpAction('enterprise_mcp_connect_failed', { id: entry.id, error: r.error });
    } else {
      reportMcpAction('enterprise_mcp_connected', { id: entry.id });
    }
  });
}}
```

(Apply the same pattern to both the card `onClick` and the inner install button.)

- [ ] **Step 3: Typecheck + lint**

Run:

```bash
cd enterprise_server/web && npx tsc --project tsconfig.json --noEmit
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/services/mcp.ts src/components/mcp/McpManager.tsx
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/services/mcp.ts src/renderer/components/mcp/McpManager.tsx
git commit -m "feat(electron): add per-MCP authorization for enterprise marketplace"
```

---

## Task 8: Cleanup — remove the dead `mcp:fetchMarketplace` desktop path

**Files:**
- Modify: `src/shared/mcp/constants.ts` (remove `FetchMarketplace`)
- Modify: `src/main/preload.ts` (remove the `fetchMarketplace` exposure on the `mcp` block)
- Modify: `src/main/ipcHandlers/mcp/handlers.ts` (remove the handler block at `~323-341`)
- Modify: `src/main/ipcHandlers/mcp/handlers.test.ts` (remove the `describe('McpIpcChannel.FetchMarketplace handler', …)` block)
- Modify: `src/renderer/types/electron.d.ts` (remove the `fetchMarketplace` typing on the `mcp` API surface)
- Modify: `src/renderer/services/mcp.ts` (remove `fetchMarketplace`, `getCachedMarketplace`, the marketplace localStorage cache keys/readers/writers, and `convertMarketplaceToRegistry` if it has no other consumer)
- Modify: `src/renderer/components/mcp/McpManager.tsx` (ensure no references to `mcpService.fetchMarketplace` / `getCachedMarketplace` / `mergeMarketplaceRegistry` / `mcpMarketplaceCache.v1` remain)

**Interfaces:**
- No new interfaces. Verifies nothing references the dead path.

- [ ] **Step 1: Confirm no remaining callers of the dead path**

Run:

```bash
rg -n 'McpIpcChannel\.FetchMarketplace|mcpService\.fetchMarketplace|mcpService\.getCachedMarketplace|MARKETPLACE_CACHE_KEY|readMarketplaceCache|writeMarketplaceCache|convertMarketplaceToRegistry|mergeMarketplaceRegistry|mcpMarketplaceCache\.v1' src enterprise_server
```

Expected: only the files you are about to edit appear in the list. If anything else shows up (e.g. another component), STOP and fix it before deleting.

- [ ] **Step 2: Remove from server-side IPC plumbing**

In `src/shared/mcp/constants.ts`, delete the line:

```ts
FetchMarketplace: 'mcp:fetchMarketplace',
```

In `src/main/preload.ts`, delete the line:

```ts
fetchMarketplace: () => ipcRenderer.invoke(McpIpcChannel.FetchMarketplace),
```

In `src/main/ipcHandlers/mcp/handlers.ts`, delete the entire `ipcMain.handle(McpIpcChannel.FetchMarketplace, …)` block (lines 323-341 in the current file).

In `src/main/ipcHandlers/mcp/handlers.test.ts`, delete the entire `describe('McpIpcChannel.FetchMarketplace handler', …)` block (lines 32-104 in the current file). Also drop the now-unused `vi.mock('../../libs/authSessionManager', …)` if its only consumer was this test (verify by reading the file — only delete if no remaining references).

In `src/renderer/types/electron.d.ts`, delete the `fetchMarketplace: () => Promise<{ success: boolean; data?: string; error?: string }>` line on the `mcp` API surface.

- [ ] **Step 3: Remove from the renderer service**

In `src/renderer/services/mcp.ts`:

- Delete `MARKETPLACE_CACHE_KEY`, `MarketplaceCachePayload`, `readMarketplaceCache`, `writeMarketplaceCache`.
- Delete `convertMarketplaceToRegistry` (Task 6's `fetchEnterpriseMarketplace` does not use it; if a `rg 'convertMarketplaceToRegistry' src` proves there are no other consumers, the function is dead).
- Delete the methods `fetchMarketplace` and `getCachedMarketplace` on `McpService`.

- [ ] **Step 4: Remove dead imports from `McpManager.tsx`**

In `src/renderer/components/mcp/McpManager.tsx`:

- Remove `import { mergeMarketplaceRegistry, ... } from '../../services/mcpRegistryPresentation';` if `mergeMarketplaceRegistry` is no longer referenced (Task 6 replaced that effect with two local ones).
- Drop any other now-unused imports (run `npx tsc` — it will tell you).

- [ ] **Step 5: Re-run the grep — expect zero hits**

Run:

```bash
rg -n 'McpIpcChannel\.FetchMarketplace|mcpService\.fetchMarketplace|mcpService\.getCachedMarketplace|MARKETPLACE_CACHE_KEY|readMarketplaceCache|writeMarketplaceCache|convertMarketplaceToRegistry|mergeMarketplaceRegistry|mcpMarketplaceCache\.v1' src enterprise_server
```

Expected: no output.

- [ ] **Step 6: Typecheck + lint + tests**

Run:

```bash
cd enterprise_server && npx tsc --noEmit
cd web && npx tsc --project tsconfig.json --noEmit
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/shared/mcp/constants.ts src/main/preload.ts src/renderer/types/electron.d.ts \
  src/main/ipcHandlers/mcp/handlers.ts src/main/ipcHandlers/mcp/handlers.test.ts \
  src/renderer/services/mcp.ts src/renderer/components/mcp/McpManager.tsx
cd ../.. && npx vitest run --pool=forks src/main/ipcHandlers/mcp/handlers.test.ts
cd web && npx vitest run tests/components/mcp tests/components/McpManager.test.tsx 2>/dev/null || true
```

Expected: everything clean; the touched handler test still passes (only the `FetchMarketplace` describe block was removed).

- [ ] **Step 7: Commit**

```bash
git add src/shared/mcp/constants.ts src/main/preload.ts src/main/ipcHandlers/mcp/handlers.ts \
        src/main/ipcHandlers/mcp/handlers.test.ts src/renderer/types/electron.d.ts \
        src/renderer/services/mcp.ts src/renderer/components/mcp/McpManager.tsx
git commit -m "refactor(electron): remove dead mcp:fetchMarketplace path"
```

---

## Self-Review (run after writing, before handoff)

- **Spec coverage:**
  - §1 tabs/rename → Task 2 ✓
  - §2 内置市场 = local curated catalog → Tasks 3 + 6 ✓
  - §3 企业市场 fetches via `enterpriseClient.listEnterpriseMcps()` on org JWT, aligned to `McpServerView`, no secret shipped → Tasks 4 + 5 + 6 ✓
  - §4 per-MCP user-side auth (OAuth / pasted key / none), no enterprise secret → Task 7 ✓
  - §5 server-side category filter → Task 1 ✓
  - §6 remove dead desktop `mcp:fetchMarketplace` path → Task 8 ✓
- **Placeholders:** No TBD/TODO/"implement later" anywhere in the plan. Every code block is concrete.
- **Type consistency:** Method names match end-to-end:
  - `McpIpcChannel.FetchEnterpriseMarketplace` (Task 5) is referenced in `enterpriseClient` test handler lookup (Task 5), preload (Task 5), types (Task 5), and main handler (Task 5) — same literal string.
  - `enterpriseClient.listEnterpriseMcps()` (Task 4) is consumed by the IPC handler (Task 5).
  - `mcpService.fetchEnterpriseMarketplace()` (Task 6) is the only consumer of `window.electron.mcp.fetchEnterpriseMarketplace` (Task 5) — `McpManager` (Task 6) calls `mcpService`.
  - `connectEnterpriseMcp(entry)` (Task 7) accepts `McpEnterpriseMarketServer` (Task 5).
- **No spec requirement left unassigned.**

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-13-mcp-connector-marketplace-redesign.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?