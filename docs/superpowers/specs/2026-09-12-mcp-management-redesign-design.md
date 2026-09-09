# MCP 管理（MCP Management）Redesign — Design Spec

**Date:** 2026-09-12
**Owner:** paul
**Status:** Approved in brainstorm (approach A — evolve the marketplace in place)

## Goal

Rebuild the enterprise_server **MCP 管理** feature to match the
`mcp-standalone.html` prototype, and wire **per-MCP role permissions** into
the enterprise_server user-role system so that a user's role determines which
MCP services they can see and use on the desktop client.

## Background (what exists today)

- **Two unrelated MCP concepts exist.**
  - `mcp_marketplace_categories` / `mcp_marketplace_servers` — a
    **command-based** catalog (each server is a `command` + env keys for
    stdio launch). Served to desktop via `GET /api/mcp-marketplace`
    (`src/routes/mcpMarketplace.ts`); admin CRUD at
    `src/routes/mcpMarketplaceAdmin.ts`. **No role gating** — every
    authenticated user sees every enabled server.
  - `mcp_policies` (`003_policies.sql`) — a **scope-string** based policy
    table (`scope JSONB`, e.g. `'org-wide'` / `'role:org_admin'`) managed by
    the `MCPPoliciesPage` at `/config/mcp`. Not linked to the marketplace.
- **Roles are free-form strings, not a catalog.** No `roles` table. Roles live
  in `users.extra_roles` (JSONB) and `positions.inherits_roles` (JSONB).
  Known capability strings: `super_admin`, `org_admin`, `policy_admin`,
  `model_admin`, `auditor`, `user`, `admin`. There is **no "list roles"
  endpoint** today.
- **JWT claims** (`src/auth/jwt.ts`): `{ sub, orgId, roles: string[] }`.
  `roles` is populated **from `extra_roles` only** at login
  (`src/auth/authService.ts:66`). All capability gating checks `claims.roles`
  via `requireCapability(role)` (`src/auth/middleware.ts:34`), and
  `super_admin` short-circuits every gate.
- **Credential crypto** already exists: `encrypt`/`decrypt` (AES‑256‑GCM,
  32‑byte base64 master key from `GENWORK_VAULT_MASTER_KEY`) in
  `src/vault/crypto.ts`. `providerKeyVault` is the reference for the
  encrypt-on-write / mask-on-read pattern.
- **Web SPA** (react-router, `web/src/App.tsx`): admin routes wrapped in
  `<AuthGuard requires="ROLE">` inside a `<Shell>` (Sidebar + main). Nav is a
  static `ITEMS` array in `web/src/components/Sidebar.tsx` with per-item
  `requires` role. i18n is two `Dict` objects (`en`, `zh`) + `t()` in
  `web/src/i18n.ts`. The SPA talks to the backend through `web/src/api/client.ts`
  (`apiClient.get/post/patch/delete`), and per-domain modules under
  `web/src/api/` (e.g. `policies.ts`, `users.ts`). There is **no MCP-marketplace
  API module** in the SPA yet — it currently only uses `policies.ts`.

## Decisions (locked)

| Decision | Choice |
| --- | --- |
| Role source for chips + access checks | **Distinct roles actually present in the org** (union of `users.extra_roles`, `positions.inherits_roles`, and the core capability constants), exposed by a new admin endpoint. |
| Relationship to existing marketplace | **Replace it** — migrate `mcp_marketplace_servers` to the prototype's shape; rewrite the public + admin routes; rebuild the SPA page. |
| Scope of this build | **Admin page + role-filtered public endpoint** (server-side enforcement). The desktop "连接器" page's own call to that endpoint is a noted follow-up integration. |
| Role set that grants MCP access | **JWT `roles` (i.e. `extra_roles`)** — consistent with every existing gate. `super_admin` sees/uses all. (Position-inherited roles do *not* count, matching how current authz already behaves.) |

## The prototype, in detail

The prototype (`/Users/paulwang/WorkBuddy/2026-09-12-22-06-19/mcp-standalone.html`)
is a **remote-MCP-server** model. Each MCP has:

- `name`, `category`, `desc` (备注/note), `url` (Server URL)
- `transport` ∈ `{ http, sse, stdio }` (Streamable HTTP / SSE / Stdio 本地进程)
- `auth` ∈ `{ none, bearer, api-key, oauth }`
- `credential` (Token/Key, 脱敏存储 — masked at rest + in UI), `timeout` (seconds)
- `enabled` toggle (停用后所有用户 Desktop 端不可见)
- `status` ∈ `{ connected, failed, unknown, testing }`, `latency`, `lastTest`
- `roles: string[]` — the permission chips

Layout: **left = category sidebar** (search, category list with per-category
counts, hover-reveal category delete, "+ 新增分类"); **right = MCP card grid**
(breadcrumb + category title + count + "+ 添加 MCP"), where clicking a card
opens a **detail drawer** (enable switch, connection status + 测试连接, basic
info form, role chips, delete/cancel/save). "+ 添加 MCP" opens a **create
form** (view switch from the grid) with the same fields + role chips. Role
chips have a live "已授权 N / M" summary and a **≥1 role** guard (super admin
cannot be the last one removed — actually the guard is: at least one role must
remain).

Global console nav in the prototype maps to the SPA's existing `Sidebar` —
**not rebuilt**.

## Design

### 1. Data model — new migration `018_mcp_marketplace_v2.sql`

Migrate `mcp_marketplace_servers` in place (the existing
`012_mcp_marketplace.sql` created it; this adds columns + relaxes a constraint):

Add columns:
- `server_url TEXT` — Server URL (required for `http`/`sse`).
- `auth_method TEXT NOT NULL DEFAULT 'none' CHECK (auth_method IN ('none','bearer','api-key','oauth'))`
- `credential_cipher TEXT` — encrypted via `encrypt()` (see §2.4). Never returned
  in plaintext; responses carry a masked value.
- `api_key_header TEXT NOT NULL DEFAULT ''` — header name used when
  `auth_method = 'api-key'`. **Defaults to empty** (ruling). When empty the
  probe attaches the credential to no named header (see §2.5).
- `timeout_seconds INTEGER NOT NULL DEFAULT 30`
- `allowed_roles JSONB NOT NULL DEFAULT '[]'` — the permission chips (role
  identifiers, e.g. `["super_admin","org_admin"]`).
- `last_status TEXT` — `'unknown' | 'connected' | 'failed'` (last probe result).
- `last_latency_ms INTEGER`
- `last_tested_at TIMESTAMPTZ`

Relax:
- `command TEXT NOT NULL` → `command TEXT` (optional; only meaningful when
  `transport_type = 'stdio'`). Keep the existing `CHECK` on `transport_type`.

Backfill existing rows: `allowed_roles = '["super_admin"]'` so they stay
reachable to admins post-migration (they were previously un-gated).

Categories table: a **reserved "未分类" (Uncategorized) category** is
seeded/ensured by this migration — `INSERT ... ON CONFLICT (category_id) DO
NOTHING` with `category_id = 'uncategorized'`, `name_zh = '未分类'`,
`name_en = 'Uncategorized'`, `display_order` last. It is the delete-migration
target (§2.3) and is **not deletable** through `DELETE /categories/:id`
(that endpoint returns `409` for `category_id = 'uncategorized'`). All other
category CRUD is unchanged.

> Migrations in production run through `src/db/migrate.ts` (ledger-based,
> idempotent). The test harness re-runs every file with no ledger check, so the
> `ALTER TABLE ... ADD COLUMN` statements must be written to be safe to re-run
> (use `ADD COLUMN IF NOT EXISTS`; the CHECK/CHECK-relax uses
> `ALTER TABLE ... DROP CONSTRAINT` + guarded re-add, or `IF EXISTS`).

### 2. Backend

#### 2.1 Role-vocabulary endpoint — `GET /api/roles/vocabulary`
New route module `src/routes/roleVocabulary.ts`, gated
`requireAuth` + `requireCapability('org_admin')`. Returns the distinct role set:

```
union(
  distinct strings from users.extra_roles,
  distinct strings from positions.inherits_roles,
  core constants: super_admin, org_admin, policy_admin, model_admin, auditor, user
)
```

Response: `{ roles: string[] }` (sorted, deduped). This is the single source
the SPA chips read. (Computed in one query: collect both JSONB columns, flatten,
`SELECT DISTINCT` via SQL or in TS; union in TS with the core constants.)

#### 2.2 Rewrite public catalog — `GET /api/mcp-marketplace`
Rewrite `src/routes/mcpMarketplace.ts` to be **role-filtered** (this is the
server-side enforcement for requirement #3):

- A server is returned only if `enabled = TRUE` **AND**
  (`claims.roles` includes `super_admin` **OR** `allowed_roles ∩ claims.roles ≠ ∅`).
- Response keeps the existing `{ categories, servers }` envelope but each server
  now carries the new fields:
  `{ id, name, name_zh?, description (from desc/note), category, transportType,
    serverUrl, authMethod, credentialMasked?, timeoutSeconds, allowedRoles,
    icon?, lastStatus, lastLatencyMs, lastTestedAt, enabled }`.
  - `credentialMasked` = `mask(ciphertext)` — a short masked token (e.g.
    `••••` + last 4 of the **decrypted** plaintext), or `null` if none.
  - For `stdio`, `serverUrl` may be absent; `command` is included.
- Categories returned as today (`{ id, name_zh, name_en }`).

> The desktop "连接器" page will call this endpoint and render only the MCPs
> the user may use. **This build delivers the endpoint; the desktop-side
> renderer is a follow-up integration** (out of scope, noted in §7).

#### 2.3 Rewrite admin CRUD — `src/routes/mcpMarketplaceAdmin.ts`
Keep the route prefix `/api/admin/mcp-marketplace/*` and the
`requireCapability('org_admin')` gate. Rework the Zod schemas + handlers for
the new fields:

- `POST /servers` — create. Validates: `name` required; `serverUrl` required and
  `^https?://` when `transport_type ∈ {http,sse}`; `allowed_roles` non-empty
  (≥1); `auth_method` in enum; credential encrypted on write.
- `PUT /servers/:serverId` — partial patch; same guards. If `credential` omitted
  or empty → keep existing ciphertext. If a new `credential` provided → re-encrypt.
- `DELETE /servers/:serverId` — unchanged.
- `POST /servers/:serverId/test` — **new**: health probe (§2.5). Returns
  `{ status, latencyMs, error? }` and persists `last_status`,
  `last_latency_ms`, `last_tested_at`.
- Category CRUD (POST/PUT/DELETE `/categories`) — **unchanged** behavior, plus
  two new admin **read** endpoints for the SPA:
  - `GET /categories` → all categories (for the sidebar list).
  - `GET /servers` → all servers (enabled + disabled) with masked credential
    and last-test fields (for the grid + drawer).
  - **`DELETE /categories/:id` — migrate-on-delete (ruling).** The existing
    `409 category_in_use` behavior is replaced. On delete, **all of the
    category's servers are moved into the reserved "未分类" (Uncategorized)
    category**, then the deleted category is removed. The "未分类" category is a
    reserved fallback row (see §1 / §6) that is always present and not
    deletable via this endpoint. The UI confirm names the target ("移入
    未分类"), and after delete the sidebar re-selects "全部".

#### 2.4 Credential storage
Reuse `encrypt`/`decrypt` from `src/vault/crypto.ts`. On write: `encrypt(plaintext)`.
On read (both admin and public): never expose plaintext; expose
`credentialMasked`. A small shared helper (e.g. `maskCredential(cipher: string): string | null`)
decrypts and returns `••••<last4>` (or `null` when empty). The **test-connection
probe** decrypts to dial the upstream (see §2.5) but never logs or returns it.

#### 2.5 Test-connection probe
`POST /api/admin/mcp-marketplace/servers/:serverId/test`:
- `http` / `sse`: dial `server_url` with the decrypted credential in the
  appropriate header:
  - `bearer` → `Authorization: Bearer <cred>`
  - `api-key` → use `api_key_header` (the per-MCP header name). **Defaults to
    empty** (ruling). When empty, the probe sends the request **without a
    credential header** (the upstream is presumed to key by IP/other means);
    the credential is still stored. (No `X-API-Key` default.)
  - `oauth` / `none` → no credential header.
  Measure round-trip; success (HTTP 2xx/3xx, or SSE open) → `connected`;
  otherwise `failed` (capture a short `error`).
- `stdio`: report `unknown` with a note that stdio can't be probed remotely
  (do not attempt to spawn arbitrary commands from the server).
- Persist `last_status`, `last_latency_ms`, `last_tested_at = NOW()`.
- Guard: the probe must not hang — apply `timeout_seconds` (capped, e.g. ≤10s
  for the probe) and a `fetch` `AbortSignal` timeout.

Mounts in `src/server.ts`: the two existing MCP route modules stay mounted
(they're being rewritten in place); add a mount for the new
`roleVocabularyRoutes` (`app.route('/', roleVocabularyRoutes)`).

### 3. Web SPA — new `MCPManagePage`

Route `/config/mcp-manage`, `<AuthGuard requires="org_admin">`, wrapped in
`<Shell>`, added to `web/src/App.tsx`. Replaces the role of the old MCP page;
the old `/config/mcp` (MCPPoliciesPage) is **kept** as-is (it manages the
separate `mcp_policies` system — out of scope). A new sidebar item is added
(see §4).

New API module `web/src/api/mcpMarketplace.ts` using `apiClient`:
- `listCategories()` → `GET /api/admin/mcp-marketplace/categories` — a small
  new admin read endpoint (auth + `org_admin`) returning
  `[{ category_id, name_zh, name_en, display_order }]`. (Ruling: the admin page
  needs the *unfiltered* category list independent of servers, so a dedicated
  list endpoint is cleaner than piggybacking on the public catalog.)
- `listServers()` (admin) → a new admin list endpoint `GET
  /api/admin/mcp-marketplace/servers` returning all servers (enabled +
  disabled, with masked credential + last-test fields).
- `createServer(input)`, `updateServer(id, input)`, `deleteServer(id)`,
  `testServer(id)`, category `createCategory`/`updateCategory`/`deleteCategory`.

New page component `web/src/pages/MCPManagePage.tsx` and components:
- **CategorySidebar** — search input; category list ("全部" first, then each
  category) each showing an **auto-generated icon** (deterministic hash of the
  name → emoji pool), name, and **count badge** (count reflects the current
  category + search filter); hover-reveal **delete** (✕, hidden for 未分类) with
  a confirm that says the MCPs move to 未分类; **"+ 新增分类"** button
  (prompt-based name entry in the prototype; use a small inline form/modal).
- **McpCardGrid** — breadcrumb (`大模型配置 / MCP 管理 / <cat>`), `<h1>`
  category title, "共 N 个 MCP 服务" count, **"+ 添加 MCP"** button. Cards in a
  responsive grid: **auto-generated icon**, name, status dot, enabled tag,
  2-line-clamped
  description, meta tags (transport short / auth short / `👥 N` roles).
  Clicking a card opens the drawer.
- **CreateForm** (view-switched over the grid) — fields: 名称*, 分类 (select,
  preselected to current), 备注, Server URL*, 传输协议 (select), 鉴权方式
  (select), 凭证 (password input), 超时时间 (number, default 30); + a
  **RoleChips** block with the perm-hint copy and live summary. Footer:
  取消 / 保存并启用.
- **DetailDrawer** (right-slide) — enable **Switch** row (title 已启用/已停用,
  hint 停用后所有用户 Desktop 端不可见); connection status line (status dot +
  text + `延迟 X | 最近测试 <ts>` or 尚未进行连接测试) + **测试连接** button;
  **基本信息** form (name, category, note, url, transport, auth, credential);
  **角色权限** RoleChips + summary; footer 删除 / 取消 / 保存.
- **RoleChips** — reads the role vocabulary (TanStack query), renders toggle
  chips, maintains the selected set, live "已授权 N / M 个角色：…" summary,
  and the **≥1 role** guard (refuse to deselect the last one). Shared between
  CreateForm and DetailDrawer.
- Reuse the existing **`Switch`** component (`web/src/components/Switch.tsx`)
  for the enable toggle; `Badge`, design tokens (`var(--*)`), `t()` i18n.

Behaviors to preserve from the prototype:
- Search filters the grid **and** the per-category count badges (client-side).
- Category delete **migrates** the category's MCPs to 未分类 (backend does the
  migration; UI confirms and re-selects 全部).
- After create → return to grid, jump to the new category, and open the drawer
  for the new MCP.
- ESC closes the drawer; if the create form is showing, ESC returns to the grid.
- Drawer save: if the category changed and the current filter no longer covers
  it, switch the current category to the new one.
- Delete from drawer: confirm (names how many roles lose access) then delete +
  close.

### 4. SPA routing, nav, i18n

- `web/src/App.tsx`: add `<Route path="/config/mcp-manage" ...>`.
- `web/src/components/Sidebar.tsx`: add
  `{ to: '/config/mcp-manage', label: t('nav.mcpManage'), icon: <Plug2/>, section: 'config', requires: 'org_admin' }`.
- `web/src/i18n.ts`: add **both** `en` and `zh` keys for the nav label and all
  new page strings (create form labels, drawer labels, role hints, status
  texts, transport/auth display names, confirm messages). No hardcoded
  user-visible strings.

### 5. Role enforcement (per-user)

Server-side only, in the public catalog route (§2.2). The JWT `roles`
(`extra_roles`) is the check; `super_admin` bypasses. No client-side trust —
the desktop must call the filtered endpoint.

## Testing

Backend (Vitest + pglite, colocated `.test.ts`; run with
`--no-file-parallelism` for full-suite):
- **Migration** — applies cleanly; existing rows backfilled
  `allowed_roles = ['super_admin']`.
- **role vocabulary** — returns the union of `extra_roles` + `inherits_roles` +
  core constants; 403 for a non-`org_admin` token.
- **public catalog role filter** — a user with role `org_admin` sees only
  servers whose `allowed_roles` include `org_admin`; `super_admin` sees all;
  disabled servers never appear; a user with no matching role sees an empty
  list.
- **admin CRUD** — create (validation failures: empty name, bad URL, empty
  roles → 400), patch (credential preserved when omitted), delete.
- **test probe** — http 200 → `connected` + latency persisted; http 500 →
  `failed`; stdio → `unknown`. (Mock `fetch`.)
- **category delete migration** — deleting a category with servers moves them
  into 未分类 and deletes the category; deleting 未分类 itself → 409.

Web (Vitest + Testing Library, `.test.tsx`):
- `RoleChips` — toggles selection, updates summary, refuses to deselect the
  last role.
- `MCPManagePage` — renders category sidebar + grid from mocked API; search
  filters; clicking a card opens the drawer; create form submits and opens the
  drawer; ESC closes drawer.

## Out of scope / follow-ups

- **Desktop "连接器" integration** — the GenWork desktop client calling
  `GET /api/mcp-marketplace` and rendering only the user's MCPs. Separate codebase
  surface; this build ships the endpoint + admin UI.
- **`mcp_policies` (the old scope-based "MCP 策略")** — left untouched; the new
  MCP 管理 is a distinct, richer system.
- Position-inherited roles for MCP access — deliberately out (see Decision:
  JWT `extra_roles` only).

## Locked rulings (confirmed with user)

1. **Category delete → 未分类.** Deleting a category moves *all* of its MCPs
   into the reserved **未分类 (Uncategorized)** category, then deletes the
   category. 未分类 is seeded by the migration and is not deletable.
2. **`api-key` probe header defaults to empty.** The `api_key_header` column
   defaults to `''`. When empty, the test-connection probe attaches no named
   credential header (no `X-API-Key` default).
3. **Icons auto-generated.** Category and MCP icons are **auto-generated on the
   client** from the name (a deterministic hash → index into a small emoji
   pool), matching the prototype's fallback-pool behavior. No per-category or
   per-MCP icon column is added for this; the existing optional `icon` column is
   used only when a value is explicitly supplied.
