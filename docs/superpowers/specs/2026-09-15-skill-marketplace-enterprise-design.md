# Enterprise-Hosted Skills Catalog — Design

**Date:** 2026-09-15
**Status:** Approved (design + merge decisions confirmed with user)
**Scope:** Wire the desktop Skills "企业/Enterprise" tab to the enterprise_server,
mirroring the MCP-connector marketplace: a server-side skill catalog route, an
admin SPA management page (two-column, mirroring MCP 管理: left = skill
categories with CRUD, right = the skill list as cards, each with a `.zip`
upload), role-based access control (`allowed_roles`), and the desktop fetching
the catalog + `.zip` packages with a JWT. Rename the `policies.manage`
permission code to `skills.manage`. **Delete the old 技能策略 (skill-policies)
feature entirely** and merge its page slot into the new 技能管理 page.

## Goal

Today the desktop's Skills "企业" tab fetches from a removed static store URL
(`getSkillStoreUrl()` returns `''`), so the tab renders empty. This makes the
tab pull a role-scoped catalog from the enterprise_server (like the MCP "企业"
tab), lets org admins manage the catalog, its categories, and each skill's
`.zip` package + allowed roles in the admin SPA, and serves the `.zip` packages
from the server behind JWT auth. The old free-text skill-policies page is
removed.

## Confirmed decisions

1. **Permission gate:** reuse the existing `policies.manage` point, but **rename
   the code string** `policies.manage` → `skills.manage` (constant key
   `PoliciesManage` → `SkillsManage`). No *new* permission point — the catalog
   stays at 9 points. The label i18n already reads "技能管理 / Manage skills",
   so this makes the code match the label.
2. **Server hosts the `.zip` files** (not just metadata + external URL). Reuses
   the existing file-storage pattern from `uploads.ts` (raw body + 50 MB cap +
   `AdmZip` validation, requiring a `SKILL.md` entry) stored under `stateDir()`.
3. **Real categories** (not free-form tags), one per skill, mirroring MCP:
   admin can add / rename / delete skill categories. **Deleting a category
   re-homes its skills into the reserved "未分类 / Uncategorized" bucket**
   (same mechanism as MCP's `UNCATEGORIZED = 'uncategorized'` reserved row).
4. **Desktop enterprise tab filters by category** — replaces the current
   tag-chip row with a category chip row (default "All", plus the
   "未分类 / Uncategorized" entry, which is a real seeded category the server
   returns). **No synthetic-chip logic.**
5. **Role-based access control.** Each catalog skill carries `allowed_roles`
   (a JSONB array of role names) — the **same model as MCP servers**. The
   public catalog returns only skills whose `allowed_roles` intersect the
   caller's roles (`super_admin` sees all). This replaces the old free-form
   `scope` (`org-wide` / `role:` / `user:` / `dept-path:`). The desktop "根据
   用户的角色展示该角色下 skill" requirement is satisfied by this **server-side
   filter** — the desktop renders what the server sends.
6. **One merged "技能管理" page** (two-column, mirroring the existing MCP 管理
   page). The new catalog page **takes over the existing `/config/skill` route
   and the existing `nav.skill` = "技能管理" label** (currently used by the
   技能策略 page) — gated on the `policy_admin` role (which carries
   `skills.manage` after the rename). There is no separate new nav item.
7. **Delete the old skill-policies feature.** Server routes
   `GET /policies/skill` + `POST /admin/policies/skill*`, `policyStore`,
   `scope` module, and the `skill_policies` table (dropped in migration 023).
   Admin SPA `SkillPoliciesPage` + `api/policies.ts` + its route/nav/i18n.

## Verified facts that shape the design

- **The old skill-policy runtime path is inert on the desktop.**
  `openClawMtStartup.fetchAndResolveEnterpriseMtPolicies` has **no callers**,
  and no renderer code calls `getPolicies('skill')`. So the old scope feature
  had no live desktop effect; deleting it changes no running behavior. (The
  generic `getPolicies(type)` IPC + `policyResolver` are **shared with the
  MCP/model policy paths and stay** — only the skill-only server/SPA surface is
  deleted.)
- The public `/policies` route and `policyStore` are **skill-only** (no
  `/policies/mcp` or `/policies/model`), so deleting them is clean.
- `scope.ts` (server) is imported only by `routes/policies.ts`.

## Out of scope (deliberate trims)

- **No `downloadCount`** (dropped; optional on the type).
- **No file streaming / range requests** — whole-`.zip` reads are fine at the
  50 MB cap.
- **No skill "test/probe" route** (MCP has `POST …/servers/:id/test`; skills
  are packages, not endpoints).
- **No data migration from `skill_policies`** — old `skill_id`s were free-text
  with no link to catalog ids, and the user chose to delete rather than merge.
  The `skill_policies` table is dropped.
- **Desktop skill-policy runtime code left in place** (`getPolicies('skill')`,
  `resolvePolicies.skill`) — it is shared with MCP/model, currently inert, and
  touching it is not worth the regression risk. The desktop change for this
  feature is confined to the 企业 tab.

---

## Global constraints

- **Two apps, one repo.** `enterprise_server/` (Hono + pglite/Postgres + React
  SPA in `enterprise_server/web/`) and the desktop Electron app at repo root
  (`src/main`, `src/renderer`, `src/shared`). They are coupled only by HTTP
  (the desktop is enterprise-only; `ENTERPRISE_SERVER_URL` is required and
  thrown-on-unset by `src/main/libs/endpoints.ts`).
- **Migrations are idempotent** (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`,
  `?`-guarded `UPDATE`s). The test harness replays every migration file on a
  fresh schema with **no** `_migrations` ledger, so re-runs must not trip
  constraints. `testPool.query` uses the extended protocol → **one statement
  per call**. Live DBs get new numbered files (next free number: **023**).
- **i18n:** every new user-visible string needs an `en` and a `zh` key.
  `t(key)` takes only a key (no interpolation); use `fill(msg, vars)` for
  templates.
- **Fail-closed auth.** Unknown role → zero access; only `super_admin` bypasses
  the `allowed_roles` filter. Public catalog + download are `requireAuth`-gated;
  download additionally enforces `allowed_roles`.
- **Quality gates (per CLAUDE.md):** touched files lint-clean
  (`npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0
  <files>`), `npx tsc --noEmit`, Conventional Commits in English, no
  `Co-Authored-By` trailers. enterprise_server vitest runs with
  `--no-file-parallelism` (default parallel run has a pre-existing pglite fd
  crash).
- **SPA is a hand-maintained mirror** of the server's `PermissionCode` catalog
  (`web/src/shared/permissions.ts`); it does **not** import from server `src/`.

---

## Data model (new migration `023_skill_marketplace.sql`)

One idempotent file: catalog tables, seed, permission-code backfill, and the
old-table drop.

### Tables

```sql
CREATE TABLE IF NOT EXISTS skill_marketplace_categories (
  category_id   TEXT PRIMARY KEY,
  name_zh       TEXT NOT NULL,
  name_en       TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skill_marketplace_skills (
  skill_id         TEXT PRIMARY KEY,
  name_en          TEXT NOT NULL,
  name_zh          TEXT,
  description_en   TEXT NOT NULL,
  description_zh   TEXT,
  icon             TEXT,
  version          TEXT,
  category_id      TEXT NOT NULL
                   REFERENCES skill_marketplace_categories(category_id),
  source_json      JSONB,
  allowed_roles    JSONB NOT NULL DEFAULT '["org_admin"]'::jsonb,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS skill_marketplace_skills_category_idx
  ON skill_marketplace_skills (category_id, enabled);
```

- `category_id` is **NOT NULL**, always referencing a category; the reserved
  `'uncategorized'` row is always present (seeded below), so there is always a
  valid category to assign.
- `allowed_roles` is a non-empty JSONB array of role names (MCP model). The
  route validates `min(1)`; the column default is a placeholder only.
- The `.zip` lives on disk, not in Postgres: `skillStoreDir(skill_id)/skill.zip`.
  `source_json` stores optional source metadata `{ from?, url?, author? }`.

### Seed (idempotent)

```sql
INSERT INTO skill_marketplace_categories (category_id, name_zh, name_en, display_order)
VALUES ('uncategorized', '未分类', 'Uncategorized', 0)
ON CONFLICT (category_id) DO NOTHING;
```

Seed **no** sample skills — the org admin adds real ones. An empty catalog is
valid; the desktop tab shows an empty state (as today).

### Permission-code backfill (`policies.manage` → `skills.manage`)

```sql
UPDATE roles
   SET permissions = (
       SELECT jsonb_agg(
                CASE WHEN el = 'policies.manage' THEN 'skills.manage'::jsonb ELSE el END
              )
       FROM jsonb_array_elements(permissions) el
     )
 WHERE permissions ? 'policies.manage';
```

The `permissions ? 'policies.manage'` guard makes it a no-op once migrated.
`019_rbac.sql` (fresh-schema source) is **edited directly** so a brand-new DB
seeds `skills.manage` (the `policy_admin` role keeps it); 023's backfill covers
already-deployed DBs. **The role NAME stays `policy_admin`** — it is a
load-bearing literal in `App.tsx` (`AuthGuard requires="policy_admin"`),
`Sidebar.tsx`, and `roleVocabulary.ts` `CORE_ROLES`; only its permission array
(and, optionally, its description) change.

### Old-table drop

```sql
DROP TABLE IF EXISTS skill_policies;
```

Removes the old skill-policies data (per the "delete, not merge" decision).

---

## Server changes

### 1. Rename permission code — `src/shared/enterpriseServerConstants.ts`

- `PermissionCode.PoliciesManage: 'policies.manage'` → `SkillsManage: 'skills.manage'`.
- Blast radius (verified): the code string is referenced in
  `src/routes/admin/policies.ts` (deleted, §6) and seeded in `019_rbac.sql`.
  Tests: `tests/auth/roleResolver.test.ts`, `tests/shared/permissionCodes.test.ts`.

### 2. File storage helper — `src/lib/stateDir.ts`

Add (mirror `htmlShareDir`):

```ts
export function skillStoreDir(skillId: string): string {
  return join(_stateDir, 'skill-marketplace', skillId);
}
```

The `.zip` is written to `join(skillStoreDir(id), 'skill.zip')`.

### 3. View/model — `src/models/skillMarketplaceView.ts` (new)

Mirror `mcpMarketplaceView.ts`:

- `export const UNCATEGORIZED = 'uncategorized' as const;`
- `SKILL_COLUMNS` — single source of the SELECT list.
- `SkillRow` (DB shape: `skill_id, name_en, name_zh, description_en,
  description_zh, icon, version, category_id, source_json, allowed_roles,
  enabled`).
- `CategoryRow` (`category_id, name_zh, name_en, display_order`) — same as MCP.
- Wire view `SkillMarketplaceView` (shared by public catalog and admin list):
  ```ts
  {
    id: string;            // skill_id
    name: string;          // name_en
    name_zh: string | null;
    description: string;   // description_zh ?? description_en
    category: string;      // category_id slug
    version: string | null;
    icon: string | null;
    source: { from?: string; url?: string; author?: string } | null;
    allowed_roles: string[];
    enabled: boolean;
  }
  ```
  The download **URL is not in this view** — the desktop main process assembles
  it from the base URL + `id`.
- `mapSkill(row): SkillMarketplaceView`.

### 4. Public catalog + download — `src/routes/skillMarketplace.ts` (new)

```
GET /api/skill-marketplace             requireAuth
GET /api/skill-marketplace/download/:id  requireAuth
```

- `GET /api/skill-marketplace` returns `{ categories, skills }` for
  `enabled = TRUE` skills the caller may access, mirroring `mcpMarketplace.ts`:
  - **Role filter:** `visibleSkills` = enabled skills where `super_admin` (in
    `claims.roles`) OR `row.allowed_roles.some(r => userRoleSet.has(r))`.
    (Copy the MCP `mcpMarketplace.ts` filter verbatim.)
  - **categories** derived from the visible (enabled) skill set, `ORDER BY
    display_order, category_id` — so a user never sees a category with no
    visible skill. The reserved `uncategorized` appears whenever a visible
    skill is uncategorized.
  - skills mapped via `mapSkill`.
- `GET …/download/:id` streams the stored `.zip`:
  - 404 if the skill row is missing **or** `enabled = FALSE`.
  - **403** if the caller's roles don't intersect `allowed_roles` (super_admin
    bypasses) — fail-closed so a user can't download a skill filtered out of
    their catalog.
  - 404 if the file is absent (metadata without an upload).
  - otherwise `c.body(buffer, 200, { 'content-type': 'application/zip',
    'content-disposition': \`attachment; filename="${id}.zip"\` })`. Read via
    `node:fs` (`readFile`) from `skillStoreDir(id)/skill.zip`.

### 5. Admin routes — `src/routes/skillMarketplaceAdmin.ts` (new)

All under `requireAuth` + `requirePermission(PermissionCode.SkillsManage)`
(mirror `mcpMarketplaceAdmin.ts`):

- **Categories** (mirror MCP exactly, table `skill_marketplace_categories`):
  - `GET  /api/admin/skill-marketplace/categories`
  - `POST /api/admin/skill-marketplace/categories`
    (body `{ category_id, name_zh, name_en, display_order? }`; `ON CONFLICT DO
    NOTHING`)
  - `PUT  …/categories/:id` (partial: `name_zh?`, `name_en?`, `display_order?`)
  - `DELETE …/categories/:id` — **migrate-on-delete**: `id === UNCATEGORIZED` →
    409 `reserved_category`; else
    `UPDATE skill_marketplace_skills SET category_id='uncategorized'
    WHERE category_id=$1`, then delete the category row (404 if absent).
- **Skills**:
  - `GET  /api/admin/skill-marketplace/skills` — all rows (incl. disabled),
    mapped via `mapSkill`.
  - `POST …/skills` — create. Zod body:
    `{ skill_id, name_en, name_zh?, description_en, description_zh?, icon?,
    version?, category_id, source?, allowed_roles: string[] }`. `category_id`
    must exist (400 `unknown_category`); `allowed_roles.length === 0` → 400
    `no_roles`.
  - `PUT  …/skills/:id` — partial update (metadata + `enabled` +
    `allowed_roles`); same category-existence + `no_roles` checks.
  - `DELETE …/skills/:id` — remove row **and** `rmSync(skillStoreDir(id),
    { recursive: true, force: true })`.
  - `POST …/skills/:id/zip` — **upload/replace the `.zip`** (mirror
    `uploads.ts`): read raw body, reject 0 bytes (400 `empty`) and >50 MB
    (413 `too_large`); parse with `AdmZip` and require a `SKILL.md` entry
    (400 `bad_zip` if unreadable or missing `SKILL.md`); write to
    `skillStoreDir(id)/skill.zip` (wipe prior dir first). Skill row must exist
    (404 if not).

### 6. Delete the old skill-policies feature

- `src/routes/policies.ts` — **delete** (public `GET /policies/skill`, skill-only).
- `src/routes/admin/policies.ts` — **delete** (admin `POST /admin/policies/skill*`,
  skill-only).
- `src/policies/policyStore.ts` — **delete** (only the two routes above use it).
- `src/policies/scope.ts` — **delete** if no remaining importers (only
  `routes/policies.ts` imported it; verify with a grep before removing).
- `src/server.ts` — remove the `policiesRoutes` + `adminPolicyRoutes` imports
  and `app.route(...)` lines.

### 7. Wire new routes — `src/server.ts`

Import + `app.route('/', skillMarketplaceRoutes)` and
`app.route('/', skillMarketplaceAdminRoutes)` (alongside the MCP ones), and
remove the old policies routes (§6).

---

## Admin SPA changes (`enterprise_server/web/`)

### 1. Permission mirror — `web/src/shared/permissions.ts`

`PoliciesManage: 'policies.manage'` → `SkillsManage: 'skills.manage'`.

### 2. i18n — `web/src/i18n.ts`

- `roles.perm.policies.manage` → `roles.perm.skills.manage`
  (en "Manage skills", zh "技能管理" — values unchanged).
- `roles.permDesc.policies.manage` → `roles.permDesc.skills.manage`.
- **Add** the page's UI strings under a `skillmgmt.*` prefix (mirror the
  existing `mcp.*` block): nav/title (reuse `nav.skill`), search, categories,
  add/rename/delete-category strings (incl. the reserved "未分类"), the skill
  form labels (name/description zh+en, icon, version, category, source,
  **allowed roles**, enabled, upload/replace-package), toasts, confirm-dialog
  strings. **Both en and zh.**
- Remove any i18n keys used **only** by `SkillPoliciesPage` (e.g. its
  "Add skill policy" strings) after that page is deleted.

### 3. API client — `web/src/api/skillMarketplace.ts` (new)

Mirror `api/mcpMarketplace.ts` (`apiClient`): `listSkills`, `listCategories`,
`createSkill`, `updateSkill`, `deleteSkill`, `createCategory`,
`updateCategory`, `deleteCategory`, and `uploadZip(id, file)` (the zip upload
posts raw bytes — add a small binary-POST helper to `apiClient`, e.g.
`postRaw(path, body, headers)`, if none exists).

### 4. Delete the old policy page + api

- `web/src/pages/SkillPoliciesPage.tsx` — **delete**.
- `web/src/api/policies.ts` — **delete** (only that page used it).

### 5. New page — `web/src/pages/SkillManagePage.tsx` + `web/src/pages/skillManage/`

Replace the `SkillPoliciesPage` import/usage. Mirror `MCPManagePage.tsx` +
`pages/mcpManage/`:

- `CategorySidebar.tsx` — category list + counts + add/delete + search (copy
  the MCP sidebar; the reserved "未分类" entry is non-deletable, mirroring MCP).
- `AddCategoryModal.tsx`, `CreateSkillForm.tsx`, `DetailDrawer.tsx`
  (metadata + allowed-roles + enabled toggle + **upload/replace `.zip`**),
  `SkillCardGrid.tsx`, `types.ts` (`UNCATEGORIZED`, reuse `fill`).
- `DetailDrawer` mirrors the MCP `DetailDrawer` minus the credential /
  test sections, with an **allowed-roles** multi-select (reuse the role
  vocabulary endpoint the MCP page uses) and a **package upload** section.

### 6. Route + nav — `web/src/App.tsx`, `web/src/components/Sidebar.tsx`

- `App.tsx`: change the `path="/config/skill"` route to render
  `<Shell><SkillManagePage /></Shell>` instead of `SkillPoliciesPage` (keep
  `AuthGuard requires="policy_admin"`).
- `Sidebar.tsx`: the existing `{ to: '/config/skill', label: t('nav.skill'),
  ... }` item stays (same route, same label) — only the page behind it changes.

---

## Desktop changes (Electron app)

The desktop is enterprise-only, so the 企业 tab's data source switches from the
dead static-URL path to the role-scoped enterprise catalog.

### 1. Types — `src/renderer/types/skill.ts`

- `MarketplaceSkill`: replace `tags?: string[]` with **`category: string`**
  (the slug; `'uncategorized'` when none). Keep `id, name, description, url,
  version, displayName?, icon?`; make **`source` nullable** (`{ from?: string;
  url?: string; author?: string } | null`) to match the server view; drop
  `downloadCount?`.
- `MarketTag` → **`MarketCategory { id: string; en: string; zh: string }`**.

### 2. Renderer service — `src/renderer/services/skill.ts`

- `fetchMarketplaceSkills()` / `loadMarketplaceSkills()` return
  `{ skills: MarketplaceSkill[]; categories: MarketCategory[] }` (was
  `{ skills, tags }`).
- `loadMarketplaceSkills` reads the **structured** IPC result
  (`{ success, skills, categories }`) instead of parsing the old
  `json.data.value.marketplace` blob.
- **Critical coupling (must preserve):** the fetch currently populates
  `this.marketplaceSkillNames` / `this.marketplaceSkillDescriptions` /
  `this.skillIcons` (from `ms.displayName` / `ms.description` / `ms.icon`).
  Keep populating these from the catalog, because
  `getLocalizedSkillName` / `getLocalizedSkillDescription` / `getSkillIcon`
  fall back to them for the **Mine and BuiltIn** tabs too — dropping this
  would regress names/icons there.

### 3. Preload — `src/main/preload.ts`

Keep the existing `skills.fetchMarketplace` channel (no new channel); only its
**main-side behavior** changes (below).

### 4. Main IPC handler — `src/main/ipcHandlers/skills/handlers.ts`

`skills:fetchMarketplace` stops calling `getSkillStoreUrl()` and instead:

1. `const data = await enterpriseClient.listEnterpriseSkills();` (see §5). The
   server already filters by the caller's roles, so no further filtering here.
2. Resolve each skill's download URL: `skill.url =
   \`${getEnterpriseServerUrl()}/api/skill-marketplace/download/${skill.id}\``
   (main owns `getEnterpriseServerUrl`; the renderer doesn't).
3. **Map categories to the renderer shape.** The server sends categories as
   `{ id, name_zh, name_en }`; the renderer's `MarketCategory` is
   `{ id, en, zh }`. Map them here: `categories.map(c => ({ id: c.id,
   en: c.name_en, zh: c.name_zh }))`. (Skills are already in the
   `MarketplaceSkill` wire shape; only `url` is filled here.)
4. Return `{ success: true, skills, categories }`; on error
   `{ success: false, error }` (the service `catch` yields an empty catalog →
   empty tab, matching today's graceful degradation).

### 5. Enterprise client — `src/main/auth/enterpriseClient.ts`

Add `listEnterpriseSkills()` mirroring `listEnterpriseMcps()`:
`GET ${baseUrl}/api/skill-marketplace` with the Bearer token; return
`{ categories, skills }` (server wire shape; `url` left for the handler to fill).

### 6. Authed `.zip` download — `src/main/skills/skillManager.ts`

`downloadZipUrl(zipUrl, tempRoot)` (currently a module-private `const` at
~line 1256) currently fetches with only a `User-Agent` header. Add: attach
`authorization: Bearer <token>` (token = `await enterpriseClient.getToken()`)
**iff** `new URL(zipUrl).origin === getEnterpriseServerUrl()` (the base URL has
no trailing slash, so the string comparison is exact). Guard the `new
URL(zipUrl)` parse in a try/catch so a malformed string just means "no auth
header". Install **and** upgrade (both call `downloadZipUrl`) then work against
the enterprise host; non-enterprise URLs (GitHub/ClawHub) are untouched. Import
`getEnterpriseServerUrl` and `enterpriseClient` (both exist in main). Add
`downloadZipUrl` to the existing `__skillManagerTestUtils` export (~line 3241)
so it is unit-testable.

### 7. UI — `src/renderer/components/skills/SkillsManager.tsx`

Replace the tag-chip machinery with a category filter (mirror the MCP page's
`activeCategory` model):

- `marketTags: MarketTag[]` → `categories: MarketCategory[]`;
  `setMarketTags` → `setCategories`.
- `activeMarketTag` → `activeCategory` (still defaults to `'all'`).
- Filter: `skill.tags?.includes(activeMarketTag)` →
  `skill.category === activeCategory`.
- The chip row (~line 1335) renders from the returned `categories` (which
  include `uncategorized` when it has a visible skill) — no special-casing.
  Keep the `categories.length > 0` guard.
- The card's category badge (~line 958, `categoryTag`) reads from
  `skill.category` → look up the `MarketCategory` name.
- **`src/renderer/components/skills/analytics.ts`:** the two helpers serialize
  `marketplaceSkill?.tags ?? []` / `skill.tags ?? []` into a `tags` param.
  `tags` no longer exists on `MarketplaceSkill`, so this is a **compile error**
  that must be resolved — set the `tags` param from the single `category`
  (e.g. `serializeSkillAnalyticsList([skill.category])`). Keep the analytics
  event **key names** stable; only the value source changes.
- Analytics `activeMarketTag` fields in `SkillsManager.tsx` → `activeCategory`.

---

## Error handling

- **Desktop fetch failure** (server down, 401): the service `catch` returns an
  empty catalog → the 企业 tab shows the existing empty state (no crash) — the
  current behavior, preserved.
- **Download 401:** Bearer token from the stored session; a 401 surfaces as a
  failed install (existing `skillInstallFailed` message). Acceptable.
- **Download 403:** caller's roles don't allow the skill (fail-closed).
- **Upload:** 0 bytes → 400 `empty`; >50 MB → 413 `too_large`; unreadable zip
  or missing `SKILL.md` → 400 `bad_zip`; unknown skill id → 404.
- **Delete category** of the reserved `uncategorized` → 409.

---

## Testing

**Server (enterprise_server vitest, `--no-file-parallelism`):**
- Route tests (`tests/routes/skillMarketplace.test.ts`): catalog returns only
  enabled **and role-visible** skills + their categories; a skill whose
  `allowed_roles` exclude the caller is hidden and its download 403s; a
  disabled skill is hidden and its download 404s; download 200 streams the
  uploaded zip; unknown id 404; super_admin sees all.
- Admin tests: category CRUD; **delete category re-homes skills to
  `uncategorized`** and the reserved category 409s; skill CRUD; unknown
  category 400; `allowed_roles` empty 400; zip upload (empty/too-large/bad-zip
  rejected; good zip accepted) round-trips to a downloadable file.
- **Deletion:** `GET /policies/skill` and `POST /admin/policies/skill` no
  longer resolve (404) after the routes are removed.
- **Migration 023** test: fresh-schema replay creates the tables + seeds
  `uncategorized`; the `policies.manage`→`skills.manage` backfill updates a
  pre-seeded role and is idempotent on a second run; `skill_policies` is gone.
- **Rename** tests: `permissionCodes` asserts `SkillsManage ===
  'skills.manage'`; `roleResolver` resolves a role granted `skills.manage`.

**SPA (web vitest):**
- `permissions` mirror: `SkillsManage === 'skills.manage'`.
- `SkillManagePage`: lists categories + skills; add/rename/delete category;
  delete re-homes; create/edit skill (incl. allowed-roles + enabled toggle);
  the reserved category is not deletable; `/config/skill` renders
  `SkillManagePage` (not the old policy page).
- `i18n`: the renamed `roles.perm.skills.manage` keys resolve in both langs.

**Desktop (renderer + main vitest):**
- `skill.ts`: `fetchMarketplaceSkills` maps the structured IPC result to
  `{ skills, categories }` and still populates the name/desc/icon maps.
- `skillManager.downloadZipUrl` (via `__skillManagerTestUtils`): mock
  `session.defaultSession.fetch` to capture its `headers`; set
  `ENTERPRISE_SERVER_URL`; assert an `authorization: Bearer …` header is sent
  **only** when the URL origin equals the enterprise server (omitted for a
  non-enterprise origin). (The function fetches, writes, and extracts the zip;
  the mock returns a valid small zip so the extract step completes.)
- `SkillsManager`: category chip filtering narrows the list by
  `skill.category` (incl. `uncategorized` when present); a skill's badge
  resolves its category name.

---

## Files touched (summary)

**enterprise_server/**
- `src/shared/enterpriseServerConstants.ts` — rename the code.
- `src/lib/stateDir.ts` — add `skillStoreDir`.
- `src/models/skillMarketplaceView.ts` — **new**.
- `src/routes/skillMarketplace.ts` — **new** (public catalog + download).
- `src/routes/skillMarketplaceAdmin.ts` — **new** (categories + skills + zip
  upload).
- `src/server.ts` — wire new routes; remove old policies routes.
- `src/routes/policies.ts` — **delete**.
- `src/routes/admin/policies.ts` — **delete**.
- `src/policies/policyStore.ts` — **delete**.
- `src/policies/scope.ts` — **delete** (if unused after the above).
- `src/db/migrations/023_skill_marketplace.sql` — **new** (tables + seed +
  permission backfill + `DROP TABLE skill_policies`).
- `src/db/migrations/019_rbac.sql` — seed `skills.manage` for `policy_admin`
  (fresh DB); update its description.
- `tests/auth/roleResolver.test.ts`, `tests/shared/permissionCodes.test.ts` —
  rename.
- `tests/routes/skillMarketplace.test.ts` — **new**.
- `tests/db/migrate.test.ts` — 023 + backfill + drop.

**enterprise_server/web/**
- `src/shared/permissions.ts` — rename the code.
- `src/i18n.ts` — rename perm keys + add `skillmgmt.*` strings (en+zh); drop
  page-only policy strings.
- `src/api/skillMarketplace.ts` — **new**.
- `src/api/client.ts` — add a binary/raw POST helper (for zip upload) if
  absent.
- `src/pages/SkillManagePage.tsx` + `src/pages/skillManage/*` — **new**.
- `src/pages/SkillPoliciesPage.tsx` — **delete**.
- `src/api/policies.ts` — **delete**.
- `src/App.tsx`, `src/components/Sidebar.tsx` — point `/config/skill` at the
  new page.
- tests under `web/tests/`.

**desktop (repo root)**
- `src/renderer/types/skill.ts` — `category` + `MarketCategory`.
- `src/renderer/services/skill.ts` — structured fetch + map.
- `src/renderer/components/skills/SkillsManager.tsx` — category filter.
- `src/renderer/components/skills/analytics.ts` — `category` in the `tags`
  param.
- `src/main/preload.ts` — (no channel change).
- `src/main/ipcHandlers/skills/handlers.ts` — enterprise fetch handler +
  URL resolution.
- `src/main/auth/enterpriseClient.ts` — `listEnterpriseSkills()`.
- `src/main/skills/skillManager.ts` — authed `downloadZipUrl`.
- tests for service, skillManager, SkillsManager.
