# Enterprise 套件管理 (Kit Management) — Design Spec

Date: 2026-10-07
Status: Draft — pending review

## 1. Purpose

Add a **套件管理** (expert-suite / kit management) subsystem to the GenWork
enterprise server, mirroring the existing **skill marketplace** subsystem, and
wire the desktop app's 专家套件 view to read permission-scoped kits from the
enterprise server instead of the (dead) local marketplace.

Six requirements, reconciled with the product owner:

1. New 套件管理 admin page in the enterprise-server web SPA (工作台), mirroring
   the provided prototype — categories, kit cards, enable toggle,
   detail/authorize drawer, custom-kit CRUD with zip upload. Backed by a new
   `kit_catalog` subsystem that mirrors the existing `skillMarketplace`
   subsystem.
2. Migrate the **12 LobsterAI expert kits** (excluding 外观定制, which is not
   one of the 12) into that catalog.
3. **Vendored-once, read-locally seeding:** the 12 kits' skill `.zip` bundles
   are downloaded *once now* and committed into the repo as system
   initialization data. Server init reads them from local files — **no
   network at startup**. Every fresh environment initializes from those
   bundled zips. (Explicitly *not* fetched from
   `ydhardwarebusiness.nosdn.127.net` at startup.)
4. Desktop 专家套件 **市场 → 企业** tab; lists only kits the logged-in user is
   authorized for, read from the enterprise server via the org JWT.
5. **Keep** the desktop "GenWork 外观定制" built-in kit and the AI 皮肤
   feature (requirement reversed by product decision). Instead, the desktop
   gains a **内置 (built-in)** tab that hosts the existing local built-in kits.
6. **Keep** the Settings → 外观 "AI 皮肤" section (same reversal). No skin
   surface is removed.

Out of scope: install-policy (可选/默认/强制) — explicitly excluded. No
member submission/review queue for kits (v1).

## 2. Scope & non-goals

**In scope**
- Enterprise server: `kit_catalog` DB table + migration, `kitCatalog` service,
  admin + public routes, RBAC points, per-org seed from vendored zips, admin
  SPA page.
- Desktop: 专家套件 tab restructure (市场→企业 + new 内置 tab), enterprise
  client methods, authed kit download, IPC + preload wiring.

**Non-goals**
- No install-policy enforcement or desktop auto-install.
- No kit review/submission queue (`kit_submissions`) — deferred.
- No multi-node/backup story for stored zips (matches existing skill pattern,
  local-disk only).
- No changes to the AI-skin feature or the skin display runtime.

## 3. Existing patterns to mirror (verified)

The enterprise server is Hono v4 over raw `pg` (Postgres). The **skill
marketplace** feature is nearly the kit feature and is the primary template:

| Concern | Skill feature (copy this) |
|---|---|
| Migration | `src/db/migrations/038_org_skills.sql` — `scope JSONB DEFAULT '{"allCompany":false,"deptIds":[],"userIds":[]}'`, `zip_file_name/zip_file_size/zip_sha256` metadata, org-scoping, per-org reserved category bucket via `AFTER INSERT ON orgs` trigger |
| Service | `src/models/modelCatalog.ts` const object (`add/patch/remove/list/listForAdmin`), all queries carry `org_id`; app-level dup check throws a sentinel error → 409 |
| Admin routes | `src/routes/skillMarketplaceAdmin.ts` (`/api/admin/skill-marketplace/*`): `requireAuth` `.use()`, per-route `requirePermission(PP.Skill*)`, **two-stage zip create** (`parse-zip` stages bytes under a `tempToken`, then commit), re-upload, delete, list, scope edit, `auditStore.write` |
| Public/desktop | `src/routes/skillMarketplace.ts` (`/api/skill-marketplace/*`): `requireAuth`, `visibleSkill` scope check (`src/auth/scopeResolver.ts`), `GET /download/:id` → `c.body(buf, 200, {'content-type':'application/zip','content-disposition':attachment})` |
| Zip handling | `src/lib/skillZip.ts` — `parseSkillZip(buf)`, `MAX_ZIP_BYTES = 10MB`, sha256, path-traversal guard |
| Storage | `src/lib/stateDir.ts` — `skillStoreDir(id)` = `<stateDir>/skill-marketplace/<id>/`; DB stores only metadata, bytes on local disk (`ENTERPRISE_STATE_DIR` or `<tmpdir>/enterprise-server`) |
| Seed | `src/org/builtinProviders.ts` — `BUILTIN_PROVIDERS` const, idempotent `seedBuiltinProviders(orgId)` with deterministic ids `builtin:<org>:<slug>` + `ON CONFLICT DO NOTHING`, `seedBuiltinProvidersForAllOrgs()` called in `server.ts:146` after migrations |
| RBAC | `src/shared/permissionPoints.ts` — `PermissionPoint` object, `PERMISSION_MODULES` (Chinese group names), `BUILTIN_ROLE_POINTS`; gate = `requirePermission(code)` in `src/auth/middleware.ts` (super_admin short-circuit; 403 writes `admin_access_denied` audit). Points also hand-mirrored in `web/src/shared/permissions.ts`. Precedent for granting a new feature's points to existing deployments: `037_grant_sso_points_to_org_admin.sql` (`permissions = permissions || '["kit:view",...]' WHERE name IN ('org_admin','super_admin') AND NOT (permissions @> ...)`) |
| SPA page | `web/src/pages/skillManage/` (`SkillManagePage.tsx`, `CategorySidebar.tsx`, `SkillTable.tsx`, `SkillDrawer.tsx`, `SkillScopeSelector.tsx`, …) registered in `web/src/App.tsx` via a `Route` wrapped in `<Shell>` |
| Tests | `tests/routes/adminModels.test.ts`, `tests/auth/requirePermission.test.ts`, `tests/db/038_org_skills.test.ts` — vitest over **PGlite** in-process Postgres (`src/db/testDb.ts`); every DB test: `import '../helpers/setupEnv'` + `vi.mock('../../src/db/pool', …)` + `beforeEach(resetSchema(); runMigrations();)`; migrations re-run with no ledger check so every migration must be re-run-safe |
| Audit actions | `src/shared/enterpriseServerConstants.ts` `AuditAction` const |

Desktop side (verified):
- `getKitStoreUrl()` in `src/main/libs/endpoints.ts:66` **returns `''`** — the
  市场 tab today renders only the offline/built-in response. The enterprise
  rewrite replaces a dead path.
- Tabs in `src/renderer/components/kits/KitsManager.tsx` (`KitTab` enum lines
  33-36; tab buttons 741-768; "市场" label at 748 via i18n `kitMarketplace`).
- Data flow: `KitsManager.loadData` (178-189) → `kitService.fetchMarketplaceKits`
  (`src/renderer/services/kit.ts:7-43`) → preload `kits.fetchStore`
  (`src/main/preload.ts:200-213`) → `ipcMain.handle('kits:fetchStore')`
  (`src/main/ipcHandlers/kits/handlers.ts:218-251`).
- Enterprise auth: main-process `enterpriseClient`
  (`src/main/auth/enterpriseClient.ts`) — `call<T>` sets `Bearer <org JWT>`
  from `sessionStorage.load()?.jwt`, 401 → `loginGate.lock()`. Precedent:
  `listEnterpriseMcps()` (342-388). IPC precedent: `McpIpcChannel.FetchEnterpriseMarketplace`
  (`src/main/ipcHandlers/mcp/handlers.ts:395-404`) — `loginGate.requireEnterprise()`
  + `enterpriseClient.*`.
- Install: `kits:install` (`handlers.ts:264-432`) downloads `skills.bundle` via
  `downloadBuffer` (`handlers.ts:42-65`) which **sends no auth headers** — must
  gain an authed path for private kit zips.

## 4. Data model

### 4.1 Migration `040_kit_catalog.sql`

Re-run-safe (idempotent `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
EXISTS`, quoted reserved words, single-quoted plpgsql bodies). Mirrors 038.

```sql
CREATE TABLE IF NOT EXISTS kit_categories (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_reserved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS kit_catalog (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,                     -- MCP-style identifier (e.g. 'engineering')
  category_id BIGINT REFERENCES kit_categories(id) ON DELETE SET NULL,
  name_en TEXT,
  name_zh TEXT,
  description_en TEXT,
  description_zh TEXT,
  icon_url TEXT,
  author TEXT,
  version TEXT,
  try_asking JSONB NOT NULL DEFAULT '[]',
  skill_list JSONB NOT NULL DEFAULT '[]',
  scope JSONB NOT NULL DEFAULT '{"allCompany":false,"deptIds":[],"userIds":[]}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_builtin BOOLEAN NOT NULL DEFAULT false,
  builtin_slug TEXT,                      -- stable built-in identity for idempotent reseed
  zip_file_name TEXT,
  zip_file_size BIGINT,
  zip_sha256 TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kit_catalog_org_slug
  ON kit_catalog (org_id, slug);
CREATE INDEX IF NOT EXISTS kit_catalog_org_id ON kit_catalog (org_id);
```

- `scope` uses the same shape as skills; `allCompany=true` ⇒ visible to every
  org member.
- `is_builtin` / `builtin_slug` mark the 12 vendored kits so reseed is
  idempotent and distinguishes them from admin-created custom kits (the 12
  are effectively immutable at runtime — the admin UI allows enable/disable
  and scope edits; deletion of a built-in is allowed but reseed does not
  restore deleted built-ins, matching the "seed inserts only if absent" rule).
- A **final statement in `040`** grants the new `kit:*` points to existing
  `org_admin`/`super_admin` rows (idempotent `||` merge, mirroring 037).

A per-org reserved `uncategorized` `kit_categories` row is seeded by an
`AFTER INSERT ON orgs` trigger, exactly like `038_org_skills.sql`.

### 4.2 RBAC points

`src/shared/permissionPoints.ts`:
- Add to `PermissionPoint`:
  `KitView:'kit:view', KitCreate:'kit:create', KitEdit:'kit:edit', KitDelete:'kit:delete', KitToggle:'kit:toggle'`.
- Add a `kit` module group array and a `PERMISSION_MODULES` entry
  `{ key:'kit', name:'套件管理', desc:'管理企业专家套件：增删改、启用/禁用及授权范围', points: kit }`.
- Add `...kit` to the `org_admin` set in `BUILTIN_ROLE_POINTS` (so org_admin
  can manage; `super_admin` gets all). Optionally add `KitView` to `member` so
  members at least have the view point (the desktop reads via `requireAuth`,
  not `requirePermission`, so this only affects the admin SPA nav visibility).
- **Mirror into `web/src/shared/permissions.ts`** (hand-kept SPA copy — no
  parity test exists; must be edited in lockstep).

Grant migration (idempotent, mirrors `037_grant_sso_points_to_org_admin.sql`):
```sql
UPDATE roles SET permissions = permissions || '["kit:view","kit:create","kit:edit","kit:delete","kit:toggle"]'::jsonb
 WHERE name IN ('org_admin','super_admin')
   AND NOT (permissions @> '["kit:view"]'::jsonb);
```

## 5. Server implementation

### 5.1 Vendored seed data

- **New directory:** `enterprise_server/seeds/kits/` — the 12 `.zip` bundles,
  committed to the repo. Filenames `<slug>.zip` (e.g. `engineering.zip`,
  `design.zip`, … `bio-research.zip`). Total ~1.4 MB.
- **Vendor step (one-time, done at implementation time, not in app code):**
  download the 12 bundles from
  `https://ydhardwarebusiness.nosdn.127.net/<32-hex>.zip` (URLs in
  `/tmp/kit-store.json`), verify each is a non-empty zip with the expected
  sha256, and write to `enterprise_server/seeds/kits/<slug>.zip`.
- **Manifest:** `enterprise_server/src/org/builtinKits.ts` holds a
  `BUILTIN_KITS` const array. Each entry carries: `slug`, `name_en/zh`,
  `description_en/zh`, `icon_url`, `author:'GenWork'`, `version`,
  `try_asking` (6×`{en,zh}`), `skill_list` (from `skills.list`),
  `defaultCategory` (a display category, e.g. 工程研发 / 设计 / 产品 / 运营增长 /
  销售客服 / 职能支持 — see §7), and `seedZipFile` (e.g. `'engineering.zip'`).
  The kit `.zip` **bytes are NOT in this const** — they are read from
  `seeds/kits/` at seed time.

  Category mapping for the 12 (from the prototype's 按岗位分类):
  - 工程研发: engineering, data
  - 设计: design
  - 产品: product-management
  - 运营增长: operations, marketing
  - 销售客服: sales, customer-support
  - 职能支持: human-resources, finance, legal, bio-research

### 5.2 Seed logic — `src/org/builtinKits.ts`

Mirrors `builtinProviders.ts`:

```ts
export async function seedBuiltinKits(orgId: string): Promise<void> {
  // ensure 6 built-in category rows (idempotent), then per kit:
  //   read seeds/kits/<slug>.zip (local file, NO network)
  //   mkdir kitStoreDir(`<builtin>` + slug), copy bytes, compute sha256/size
  //   INSERT kit_catalog(... is_builtin=true, builtin_slug, scope=allCompany,
  //        enabled=true) ON CONFLICT (org_id, slug) DO NOTHING
}
export async function seedBuiltinKitsForAllOrgs(): Promise<void> { /* loop orgs */ }
```

- Deterministic identity via `UNIQUE (org_id, slug)` + `DO NOTHING` ⇒ idempotent.
- **Local-only:** `readFileSync(resolveKitsSeedDir() + '/' + seedZipFile)`.
  No fetch. If a seed file is missing/corrupt, log `console.error('[KitSeed]')`
  and skip that kit (non-fatal), so a partial vendoring set still boots.
- `resolveKitsSeedDir()` resolves relative to the server source (e.g.
  `path.resolve(__dirname, '../../seeds/kits')` — confirm the correct relative
  depth against how `server.ts` resolves `web-dist` via
  `join(process.cwd(), 'web-dist')`; prefer the same `process.cwd()`-relative
  convention so dev + packaged both resolve, with a `KITS_SEED_DIR` env
  override for tests).

Wired in `src/server.ts` right after `seedBuiltinProvidersForAllOrgs()`
(line 146), before serving.

### 5.3 `kitStoreDir` — `src/lib/stateDir.ts`

Add:
```ts
export function kitStoreDir(kitId: string): string {
  return join(_stateDir, 'kit-marketplace', kitId);
}
```

### 5.4 Service — `src/models/kitCatalog.ts`

Exported const object `kitCatalog` mirroring `modelCatalog`:
- `add(orgId, input)` — app-level dup check on `slug` (throws sentinel
  `'kit_duplicate'` → 409), inserts with `scope` sanitized.
- `patch(orgId, id, fields)` — dynamic SET build.
- `setEnabled(orgId, id, enabled)`.
- `remove(orgId, id)` — deletes row + `rmSync(kitStoreDir(id), {recursive})`.
- `list(orgId, scopeContext)` — **user-facing**, returns enabled kits visible
  to the caller's scope (applies `visibleKit`, §5.6). Excludes zip bytes.
- `listForAdmin(orgId)` — includes disabled, stable sort.
- `getById`, `getBySlug`.
- Every query carries `org_id = claims.orgId`.

### 5.5 Admin routes — `src/routes/kitCatalogAdmin.ts`

`/api/admin/kits/*`, `requireAuth` `.use()` + per-route
`requirePermission(PP.Kit*)`. Copy `skillMarketplaceAdmin.ts`:
- `GET /api/admin/kits` (`KitView`) — list incl. disabled.
- `GET /api/admin/kits/categories` + `POST/DELETE` category CRUD (`KitEdit`)
  (mirror skill category CRUD incl. reserved-bucket 409 guard).
- `POST /api/admin/kits/parse-zip` (`KitCreate`) — `parseKitZip` (copy
  `parseSkillZip`, 10MB cap, sha256, path-traversal guard), stage bytes under a
  `tempToken`.
- `POST /api/admin/kits` (`KitCreate`) — commit staged zip into
  `kitStoreDir`, insert row, `auditStore.write`.
- `PATCH /api/admin/kits/:id` (`KitEdit`) — metadata + scope.
- `PATCH /api/admin/kits/:id/zip` (`KitEdit`) — re-upload (name-mismatch → 409).
- `PATCH /api/admin/kits/:id/enable|disable` (`KitToggle`).
- `DELETE /api/admin/kits/:id` (`KitDelete`).

Use `claims.orgId` (not an `orgId` query param) — the newer-feature convention.
Add `AuditAction` entries (`KitCreate`/`KitEdit`/`KitDelete`/`KitToggle`) in
`src/shared/enterpriseServerConstants.ts`.

### 5.6 Public/desktop routes — `src/routes/kitCatalog.ts`

`/api/kits/*`, `requireAuth` only (any member). Copy `skillMarketplace.ts`:
- `GET /api/kits` — visibility-filtered list via `visibleKit(orgId, kit, scope)`.
  `visibleKit` reuses the skill logic: `scope.allCompany ||
  scope.deptIds ∩ callerDeptIds || scope.userIds ∋ callerUserId` (caller depts
  via `scopeApi.deptIdsFor`, as `routes/skillMarketplace.ts:36` does). The list
  is reshaped into the desktop `MarketplaceKit` contract: `skills.bundle` is the
  absolute `<enterpriseBaseUrl>/api/kits/download/<id>` URL (see §5.7), and
  `skills.list` / `name` / `description` / `tryAsking` are passed through.
- `GET /api/kits/download/:id` — `visibleKit` re-check, then
  `readFile(kitStoreDir(id))` → `c.body(buf, 200,
  {'content-type':'application/zip','content-disposition':
  'attachment; filename="<slug>.zip"'})`.

Register both sub-apps in `buildApp()` (`src/server.ts`), mounted at `/` before
the SPA fallback; check `:id` pattern overlap with static routes (none expected).

### 5.7 Desktop client + install

- `enterpriseClient.ts`: add
  `listEnterpriseKits()` → `GET ${baseUrl}/api/kits` (returns the scoped
  catalog, same envelope shape as `listEnterpriseMcps`).
  `downloadEnterpriseKit(id): Promise<Buffer>` → `GET /api/kits/download/:id`
  with `Bearer` (reuse `call`/fetch plumbing; binary response).
- `src/main/ipcHandlers/kits/handlers.ts`:
  - New `kits:fetchEnterpriseStore` handler: `loginGate.requireEnterprise()` +
    `enterpriseClient.listEnterpriseKits()` → `{success, data}`, matching the
    MCP precedent. (Consumer mode / not-logged-in returns a flag so the renderer
    can show an empty/connect state.)
  - `kits:install` authed download: the server's `GET /api/kits` returns each
    kit with `skills.bundle` set to the **absolute** enterprise URL
    (`<enterpriseBaseUrl>/api/kits/download/<id>`). `kits:install` detects that
    `skills.bundle`'s host is the enterprise server (compare against
    `getEnterpriseServerUrl()`) and, in that case, downloads via
    `enterpriseClient.downloadEnterpriseKit(id)` (Bearer) instead of the
    unauthenticated `downloadBuffer`. Built-in kits (GenWork 外观定制
    `builtin://…`, computer-use CDN URL) take the existing unauthenticated path
    unchanged. No renderer change to the install payload is required — the
    existing `{ kitId, bundleUrl, … }` carries the absolute enterprise URL.
- Preload `src/main/preload.ts`: add `kits.fetchEnterpriseStore` (and ensure
  `kits.install` receives enough to route the authed download — the enterprise
  kit id). Type decl in `src/renderer/types/electron.d.ts`.

## 6. Desktop renderer — 专家套件 restructure

`KitsManager.tsx` + `i18n.ts` only; **no deletions.**

- `i18n.ts`:
  - `kitMarketplace`: 市场 → 企业 (zh), "Enterprise" (en). (This now labels the
    enterprise tab.)
  - Add `kitBuiltInTab`: 内置 (zh) / "Built-in" (en).
  - Reword `kitInstalledEmpty` (line 2273) to drop the 市场 reference.
- `KitsManager.tsx`:
  - `KitTab` enum gains `BuiltIn: 'built_in'`. Tabs render **企业 | 内置 | 已安装**.
  - **企业 tab** data source: new `kitService.fetchEnterpriseKits()` →
    `window.electron.kits.fetchEnterpriseStore()`. When not in enterprise mode /
    not logged in → show empty state "连接企业后可用" (new i18n key
    `kitEnterpriseEmpty`).
  - **内置 tab** data source: the *existing* built-in path — reuse
    `kitService.fetchMarketplaceKits()` (which returns the offline/built-in
    response: GenWork 外观定制 + computer-use). This preserves 外观定制 and
    computer-use exactly as today.
  - **已安装** tab: unchanged.
  - Install on the 企业 tab passes the enterprise kit id so the authed download
    path is used.
- `kitSlice.ts`: add enterprise/built-in state if needed (or keep two slices of
  the existing marketplace list). Keep it minimal.

## 7. Admin SPA — `web/src/pages/kitManage/`

Mirror `web/src/pages/skillManage/` (drop the review-queue pieces — kits have
no submission queue in v1):
- `KitManagePage.tsx` — layout (category sidebar + kit grid/cards).
- `CategorySidebar.tsx`, `KitCard.tsx`/`KitTable.tsx` (card with icon, name,
  version, tag, description, scope summary, enable switch, actions).
- `KitDrawer.tsx` — detail/authorize (basic info + scope editor + zip re-upload).
- `KitScopeSelector.tsx` — dept-tree + member-exception picker (copy
  `SkillScopeSelector.tsx`).
- `AddCategoryModal.tsx`, `DeleteKitModal.tsx`.
- Registered in `web/src/App.tsx` as a `Route` wrapped in `<Shell>`, nav entry
  added where the SPA nav lists 能力配置 (next to 技能管理 / 连接器).
- Uses `web/src/shared/permissions.ts` (updated in §4.2) to gate the nav item
  and actions.

## 8. Behavior / error handling

- **Seed failure tolerance:** a missing/corrupt vendored zip logs and skips
  (non-fatal). A seed run never throws and never blocks startup.
- **Authz:** desktop list/download are `requireAuth` + per-row `visibleKit`
  (fail-closed to `self`). Admin mutations are `requirePermission(PP.Kit*)`.
- **Download 404/403:** if a kit row exists but its scope excludes the caller,
  `download/:id` returns 403; the renderer surfaces a toast.
- **Cross-org guard:** all service queries carry `org_id = claims.orgId`.
- **i18n:** all new user-facing strings get zh + en (renderer `t()` keys; SPA
  follows its existing i18n convention).

## 9. Testing

Enterprise server (vitest + PGlite, per-file; `resetSchema + runMigrations`):
- `tests/db/040_kit_catalog.test.ts` — `information_schema` assertions for
  `kit_catalog`/`kit_categories` columns + unique index (mirror
  `038_org_skills.test.ts`).
- `tests/org/builtinKits.test.ts` — `seedBuiltinKits(orgId)` inserts 12
  built-in rows (scope allCompany, enabled, `is_builtin`), is idempotent on a
  second run, and reads from a **temp seed dir** (point `KITS_SEED_DIR` at a
  fixture dir with 12 tiny zips — no CDN, no real bytes needed). Asserts
  missing-file tolerance (delete one fixture → 11 rows + no throw).
- `tests/routes/kitCatalogAdmin.test.ts` — RBAC (401/403/200) + CRUD +
  duplicate-slug 409 + category CRUD (mirror `adminModels.test.ts`).
- `tests/routes/kitCatalogPublic.test.ts` — `GET /api/kits` respects scope
  (allCompany / dept / userId / excluded → 403 or filtered), `GET
  /api/kits/download/:id` returns the stored bytes for an authorized caller
  and 403 for an unauthorized one (mirror `skillMarketplace` tests).
- `tests/shared/permissionPoints.test.ts` — assert `kit:*` present + module
  entry (mirror existing).

Desktop:
- `npx eslint --max-warnings 0` on all touched TS/TSX.
- Existing kit/skin vitest still green (esp. `endpoints.test.ts` for
  `getKitStoreUrl()===''` — unchanged; `skinPackKitLifecycle.test.ts` —
  unchanged since built-in path is preserved).
- New: a focused unit for the new `kitService.fetchEnterpriseKits` empty
  state, if the code is extractable without Electron.
- Manual: `npm run electron:dev` (or `:openclaw`) — 专家套件 shows 企业/内置/已
  安装; 企业 tab lists authorized kits from the server; installing one
  downloads (authed) and appears in 已安装; 内置 still shows GenWork 外观定制.

Lint gate (CI-equivalent) on every touched file:
`npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`.

## 10. File change list

**Enterprise server**
- NEW `enterprise_server/seeds/kits/*.zip` (12 files, vendored).
- NEW `enterprise_server/src/org/builtinKits.ts`.
- NEW `enterprise_server/src/models/kitCatalog.ts`.
- NEW `enterprise_server/src/routes/kitCatalogAdmin.ts`.
- NEW `enterprise_server/src/routes/kitCatalog.ts`.
- NEW `enterprise_server/src/db/migrations/040_kit_catalog.sql`.
- EDIT `enterprise_server/src/shared/permissionPoints.ts` (points, module, roles).
- EDIT `enterprise_server/src/lib/stateDir.ts` (`kitStoreDir`).
- EDIT `enterprise_server/src/server.ts` (wire seed + register routes).
- EDIT `enterprise_server/src/shared/enterpriseServerConstants.ts` (`AuditAction`).
- EDIT `enterprise_server/src/lib/skillZip.ts` or NEW `src/lib/kitZip.ts`
  (`parseKitZip`).
- NEW `web/src/pages/kitManage/*`.
- EDIT `web/src/App.tsx` (route + nav).
- EDIT `web/src/shared/permissions.ts` (mirror points).
- NEW tests (see §9).

**Desktop**
- EDIT `src/renderer/services/i18n.ts` (tab labels + empty state).
- EDIT `src/renderer/components/kits/KitsManager.tsx` (3rd tab + data sources).
- EDIT `src/renderer/services/kit.ts` (`fetchEnterpriseKits`).
- EDIT `src/renderer/store/slices/kitSlice.ts` (if needed).
- EDIT `src/main/auth/enterpriseClient.ts` (`listEnterpriseKits`,
  `downloadEnterpriseKit`).
- EDIT `src/main/ipcHandlers/kits/handlers.ts` (new fetch handler + authed
  install download).
- EDIT `src/main/preload.ts` + `src/renderer/types/electron.d.ts` (bridge).

## 11. Risks / open decisions

1. **Vendored zip size in git:** ~1.4 MB total across 12 files committed to the
   repo. Accepted per requirement #3 (hardcoded system init data). (LFS not
   currently used in the repo; plain commit.)
2. **`resolveKitsSeedDir()` path convention:** dev vs packaged. Will follow the
   `process.cwd()`-relative convention used by `server.ts` for `web-dist`, with
   a `KITS_SEED_DIR` env override (tests). Confirm the packaged server's cwd
   includes `seeds/kits/` — if the packaged server runs from a different cwd,
   the seed dir must ship with it.
3. **`author` value:** set to `"GenWork"` for all 12 built-in kits (product
   decision, overriding the LobsterAI provenance in the source store).
4. **Custom-kit zip upload vs. seed:** custom kits are admin-uploaded (zip
   parsed server-side); the 12 built-ins are vendored. Both flow through the
   same `kitStoreDir`/download path.
5. **Existing desktop installs of GenWork 外观定制 / skin-creator:** untouched
   (requirement reversal), so no cleanup/migration needed.
