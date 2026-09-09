# RBAC: 职位 → 角色 (Roles + Permission Points) — Design

> **Status:** Design spec (pre-implementation). Approved direction from the
> brainstorming session (2026-09-14). This spec is the authority the
> implementation plan argues from.

**Goal:** Replace the single 职位 (Positions) module in `enterprise_server`
with a real **角色 (Roles)** module that manages a **permission-point
catalog**: admins define roles, assign granular permission points to each
role, and assign roles to users. Authorization is enforced at the route level
by permission point. Positions are removed entirely (table dropped, FK
cleaned up).

**Scope:** `enterprise_server` only — the Hono server (`src/`), the admin SPA
(`web/`), and their Vitest suites. **The desktop client is in scope only as a
compatibility constraint** (it consumes `GET /me`); no desktop behavior
changes. The desktop does **not** call any positions or roles endpoints.

## Global Constraints

- **Language / style:** TypeScript; 2-space indent, single quotes, semicolons;
  `PascalCase` types, `camelCase` fns. Match existing Hono/Zod/`pool.query`
  idioms in `src/routes` and `src/org`.
- **String-constants rule:** all permission-point IDs live in one `as const`
  object + derived type in `src/shared/enterpriseServerConstants.ts`. No bare
  literals for point IDs at call sites.
- **Migrations:** idempotent (`IF NOT EXISTS` / `IF EXISTS`), applied via the
  `_migrations` ledger, ordered by filename. New migrations only — never edit
  an already-applied file to change a live DB (001 is the *only* file we edit
  for the canonical fresh schema).
- **i18n:** every new user-visible SPA string goes through `t('key')` with both
  `en` and `zh` blocks in `web/src/i18n.ts`. Server error envelopes stay English
  (`{ error: ... }`) as today.
- **Secrets / audit:** role mutations (create/update/delete) write an
  `auditStore` row. Never echo role *names* into secrets.
- **Lint:** every file this change *touches* must be clean under the CI rule
  `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0
  <file>`. Several touched files carry **pre-existing** `no-explicit-any` debt
  (e.g. `me.ts:80`, `admin/users.ts:14/29/49`, `roleVocabulary.ts:14`,
  `invitationService.ts:43/98`); those `any` casts are removed as part of the
  rewrite of each file (replace with the concrete `MeRow`/request-params
  types), so no broad repo cleanup is required — only the files edited here.
- **Backward compatibility (fail-closed):** unknown role names resolve to zero
  permission points; only `super_admin` bypasses everything. Legacy `admin`
  role string ≡ the `org_admin` role's points.
- **Do not** touch bundled runtime / generated vendor files (n/a here — this is
  the standalone `enterprise_server`).

## Background: how authorization works today

Read this before the design; it explains why the changes are safe.

- **Roles are free-form strings.** `super_admin` is a system flag in
  `users.extra_roles` that short-circuits every check. The four org roles
  (`org_admin`, `model_admin`, `policy_admin`, `auditor`) are also free-form
  strings in `extra_roles`.
- **JWT carries role names.** `authService.login` reads `users.extra_roles`
  into `claims.roles` and signs a 1h JWT (`src/auth/jwt.ts`). `Claims = { sub,
  orgId, roles: string[] }`.
- **Route gates check role names.** `requireCapability(role)`
  (`src/auth/middleware.ts`) passes if `claims.roles` contains `role` OR
  `super_admin`. ~11 admin route files each pin one role (see §5).
- **The SPA gates on role names too.** `web/src/auth/store.ts`
  `hasCapability(role)` and `AuthGuard requires="org_admin"` read the JWT's
  `roles` claim. The **SPA** has **no concept of permission points** (it never
  fetches or renders point IDs).
- **Positions are effectively dead for authorization.** `login()` never reads
  `position_id`/`inherits_roles`; it only reads `extra_roles`. Position-derived
  roles land in `effective_roles_cache` (`computeEffectiveRoles`), which the
  auth path never uses. So removing positions cannot change who is authorized
  by role today.
- **`effective_roles` is read by the desktop.** `GET /me` returns
  `effective_roles`; the desktop renders it in
  `EnterpriseMtAccountMenu.tsx` (`profile.effective_roles.map(...)`). This
  field **must remain** in the `/me` response (see §7).

## 1. Permission-point catalog (static)

`PermissionCode` is a static `as const` object in
`src/shared/enterpriseServerConstants.ts` — the **vocabulary** of points. New
*points* ship in code (authoritative + typed); the point catalog is **not**
admin-editable at runtime. What *is* dynamic (DB) is which points a given
**role** grants (§2).

```ts
export const PermissionCode = {
  UsersManage: 'users.manage',
  RolesManage: 'roles.manage',
  DepartmentsManage: 'departments.manage',
  ModelsManage: 'models.manage',
  ProviderKeysManage: 'provider_keys.manage',
  PoliciesManage: 'policies.manage',
  AuditView: 'audit.view',
  ReleasesManage: 'releases.manage',
  McpManage: 'mcp.manage',
} as const;
export type PermissionCode = typeof PermissionCode[keyof typeof PermissionCode];
```

The point set is derived one-to-one from today's ~11 `requireCapability`
gates, grouped where two routes share a responsibility (models + provider-keys
→ `models.manage`; users + archives → `users.manage`).

## 2. Role entity (new table)

```sql
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,          -- stable role key, e.g. 'model_admin'
  description TEXT,
  permissions JSONB NOT NULL DEFAULT '[]',  -- array of PermissionCode strings
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Ruling — global, not org-scoped.** Roles are a catalog you define once;
*users* (already org-scoped) are assigned role *names* via the existing
`users.extra_roles`. This matches how roles already behave (global free-form
strings) and avoids seeding a role row per org. `super_admin` is **not** a
row — it stays the system flag that bypasses every check.

Seed rows (only if the table is empty), mapping from §1 + §5:

| name | permissions |
|------|-------------|
| `org_admin` | `users.manage`, `roles.manage`, `departments.manage`, `releases.manage`, `mcp.manage` |
| `model_admin` | `models.manage` |
| `policy_admin` | `policies.manage` |
| `auditor` | `audit.view` |

**Compatibility alias:** the legacy `admin` role (used by the
`requireAdmin` shim and any pre-existing `extra_roles` containing `admin`)
resolves to the **same points as `org_admin`**. This is applied in the
`RoleResolver` (§3), not as a seed row.

## 3. RoleResolver (DB-backed, live)

New module `src/auth/roleResolver.ts`. Purpose: given a user's **role names**
(from the JWT), return the **union of their permission points**.

```ts
export interface RoleResolver {
  /** Union of PermissionCode across the given role names (alias admin→org_admin). */
  pointsFor(roles: string[]): Set<PermissionCode>;
  /** Invalidate the cache (called after any role create/update/delete). */
  invalidate(): void;
}
export const roleResolver: RoleResolver;
```

- **Source of truth is the DB** (`SELECT name, permissions FROM roles WHERE
  name = ANY($1)`), per the approved "DB-backed, live" decision. Editing a
  role's points takes effect without re-login.
- **Cache:** short in-memory TTL (~30s) + invalidation on role mutation. The
  resolver memoizes the name→points map so a request that resolves several of
  the user's roles issues one query, not N.
- **Fail-closed:** role names not present in `roles` contribute no points.
  `admin` is mapped to `org_admin`'s row. (Unknown names are ignored, never
  an error — a stale JWT naming a deleted role simply grants nothing.)
- **No per-org scoping** in the query (roles are global, §2).

## 4. requirePermission middleware

New `src/auth/middleware.ts` export, alongside the existing
`requireCapability` / `requireSuperAdmin`:

```ts
export function requirePermission(code: PermissionCode): MiddlewareHandler
```

Decision order (mirrors today's `requireCapability`):
1. No/invalid Bearer → `401 { error:'unauthorized' }`.
2. `super_admin ∈ claims.roles` → allow (unchanged short-circuit).
3. `roleResolver.pointsFor(claims.roles).has(code)` → allow.
4. Else → audit `admin_access_denied` (reuse the existing audit path) and
   `403 { error:'forbidden' }`.

`requirePermission` is the new point-based gate. The existing
`requireCapability(role)` and `requireAdmin` are **kept unchanged** (still
role-name membership or `super_admin`) so the existing
`tests/auth/middleware.test.ts` and any legacy caller keep working without
edit. After §5 no production route calls `requireCapability` — only the
middleware unit test does — but keeping them is cheap and preserves the
`requireAdmin` compat contract documented in `middleware.ts`.

## 5. Route migration (requireCapability → requirePermission)

The ~11 `requireCapability(...)` call sites (found, all in `src/routes`)
become `requirePermission(point)`:

| Route file | today | → |
|-----------|-------|---|
| `admin/users.ts` | `org_admin` | `users.manage` |
| `admin/positions.ts` | *(deleted — see §6)* | — |
| `admin/departments.ts` | `org_admin` | `departments.manage` |
| `admin/models.ts` | `model_admin` | `models.manage` |
| `admin/providerKeys.ts` | `model_admin` | `models.manage` |
| `admin/policies.ts` | `policy_admin` | `policies.manage` |
| `admin/audit.ts` | `auditor` | `audit.view` |
| `admin/releases.ts` | `org_admin` | `releases.manage` |
| `admin/archives.ts` | `org_admin` | `users.manage` |
| `mcpMarketplaceAdmin.ts` | `org_admin` | `mcp.manage` |
| `roleVocabulary.ts` | `org_admin` | `roles.manage` |
| *(new)* `admin/roles.ts` | — | `roles.manage` |

`super_admin` gating (`requireSuperAdmin`) is untouched.

## 6. Positions drop + FK cleanup (approved hard decision)

**Schema — two new migrations plus a 001 edit (canonical fresh schema only):**

- `019_rbac.sql` — create `roles` (§2) and seed the 4 core roles with
  `ON CONFLICT (name) DO NOTHING`. Runs on both fresh and live DBs (ledger
  gates it; live DBs haven't applied 019 yet).
- `020_drop_positions.sql`:
  ```sql
  ALTER TABLE users DROP COLUMN IF EXISTS position_id;
  DROP TABLE IF EXISTS positions;
  ```
  The column is dropped **before** the table so the referencing FK
  (`users.position_id → positions(id)`) is removed first. `IF EXISTS` makes it
  a no-op on a fresh DB built from the edited 001.
- `001_init.sql` (edited) — remove the `positions` CREATE TABLE and the
  `position_id TEXT REFERENCES positions(id),` line from `users`. Keeps the
  *canonical* fresh schema honest. **Also remove** the
  `effective_roles_cache JSONB,` line (see §7) — on a fresh DB it never existed
  after this edit; the live-DB drop is handled by `021` below.

**`021_drop_effective_roles_cache.sql`** (live DBs):
```sql
ALTER TABLE users DROP COLUMN IF EXISTS effective_roles_cache;
```
Needed because live DBs applied 001 (which still has the column) and the
ledger skips 001 edits. `IF EXISTS` keeps fresh DBs safe.

**Code scrubbed of `position_id` / `positions` / `positionId`:**

- `src/org/orgService.ts` — drop `createPosition`, `listPositions`; drop
  `position_id` from `createUser`/`patchUser`/`getUser`/`listUsers` SQL and
  the `positionId` input fields; delete `computeEffectiveRoles` (§7); drop the
  `effective_roles_cache` column from `createUser`/`getUser`/`listUsers` SQL
  and the `UPDATE ... effective_roles_cache` write (it is `computeEffective
  Roles`'s only write site, so it disappears with the function).
- `src/routes/admin/positions.ts` — **deleted**.
- `src/routes/admin/users.ts` — remove `positionId` from the create/patch Zod
  schemas.
- `src/routes/roleVocabulary.ts` — the `... FROM positions` query is replaced
  by a `roles` query (vocabulary now unions core roles + `users.extra_roles` +
  `roles.name`), gated by `requirePermission(roles.manage)`. The file currently
  imports `requireAuth` (line 5) unused alongside `requireCapability`; the
  rewrite drops the `requireAuth` import (and adds `requirePermission`) so the
  touched file stays lint-clean under the CI `--max-warnings 0` rule.
- `src/server.ts` — drop the `posRoutes` import + `app.route` registration.
- `src/routes/admin/users.ts` create/patch — no `positionId` (above).

**`users` INSERT/SELECT paths that still write or read `effective_roles_cache`
(must scrub together with the column drop — a lingering reference breaks the
schema):**

- `src/org/orgService.ts` — `createUser` INSERT and `computeEffectiveRoles`
  UPDATE (above).
- `src/auth/authService.ts` — the first-admin `createUser` INSERT
  (`... extra_roles, effective_roles_cache ... VALUES ... roles, roles`)
  lists `effective_roles_cache`; remove the column and its value.
- `src/setup/invitationService.ts` — the invitation-redemption `INSERT INTO
  users (..., extra_roles, effective_roles_cache)`; remove the column.
- `src/routes/me.ts` — `MeRow` interface and the `SELECT ... u.effective_roles_cache`
  read; see §7 (the column read is removed; the response field is kept).

**Web SPA scrub:**

- Delete `web/src/api/positions.ts` and `web/src/pages/PositionsPage.tsx`.
- `web/src/App.tsx` — remove the `PositionsPage` import and the
  `/orgs/positions` route.
- `web/src/components/Sidebar.tsx` — remove the `Briefcase`/职位 nav item.
- `web/src/i18n.ts` — remove `nav.positions` + `page.positions.title` (en +
  zh). (New role-page keys added in §8.)

**Tests scrubbed:** `tests/db/migrate.test.ts` (flip: `positions` absent,
`roles` present; also drop `effective_roles_cache` expectation if any),
`tests/org/orgService.test.ts` (delete `createPosition` + position-based
`computeEffectiveRoles` tests), `tests/routes/admin.test.ts` (drop
`posRoutes`), `tests/routes/roleVocabulary.test.ts` (seed from `roles`, not
`positions`), `web/tests/pages/UsersPage.test.tsx` (drop `position_id`,
`effective_roles_cache` from the user fixture).

**`users.effective_roles_cache` + `computeEffectiveRoles` — removed.**
That column existed only to cache the position∪extra union. With positions
gone it is a dead copy of `extra_roles`, and login already reads `extra_roles`
directly. (This refines the earlier ruling: the **DB column and the function**
are dropped, but the **`/me` response field `effective_roles` is kept** — see
§7, because the desktop reads it.)

## 7. `/me` compatibility (desktop constraint)

`GET /me` (`src/routes/me.ts`) is consumed by the desktop
(`enterpriseClient.getMe` → `MeView.effective_roles`), which **displays**
`profile.effective_roles` in the account menu.

- **Keep the `effective_roles` field** in the `/me` JSON (both GET and PATCH
  responses). Its derivation changes: with `computeEffectiveRoles` gone and no
  positions, `effective_roles = the user's own role names` = `extra_roles`
  (the same names already in the JWT). Drop the `effective_roles_cache`
  column read and the `computeEffectiveRoles` call; select `extra_roles`
  directly.
- **Do not** add permission points to `/me` — the desktop and SPA both gate on
  role *names*, so `/me` stays role-name-based. (See §9 UI gating.)

## 8. Roles admin API + UI (replaces 职位)

### API — new `src/routes/admin/roles.ts`

Gated by `requirePermission(PermissionCode.RolesManage)`. CRUD over the
global `roles` catalog:

- `GET  /admin/roles` → `Role[]` `{ id, name, description, permissions }`.
- `POST /admin/roles` body `{ name, description?, permissions: PermissionCode[] }`
  — Zod-validated: `name` non-empty unique, `permissions` is an array of known
  `PermissionCode` values (reject unknown points). On success: insert, then
  `roleResolver.invalidate()`, then audit `role_create`.
- `PATCH /admin/roles/:id` body `{ name?, description?, permissions? }` —
  update; invalidate resolver; audit `role_update`.
- `DELETE /admin/roles/:id` — delete; invalidate resolver; audit `role_delete`.
  **Ruling (v1): allow deleting any role, including the seeded core ones.**
  Deleting a role a user still holds is safe: that user's already-minted JWT
  names a now-unknown role, which `RoleResolver` treats as zero points
  (fail-closed, §3), so access narrows rather than widens. The seeded core
  rows can be re-created via `POST` if needed.

New service `src/org/roleService.ts` holds the SQL (mirror `orgService` style);
routes stay thin. Wire the router in `server.ts`.

Audit: add `RoleCreate: 'role_create'`, `RoleUpdate: 'role_update'`,
`RoleDelete: 'role_delete'` to `AuditAction` in
`src/shared/enterpriseServerConstants.ts`.

### UI — `web/src/pages/RolesPage.tsx` (new, replaces `PositionsPage`)

- Route `/orgs/roles`, guarded `AuthGuard requires="org_admin"` (role-name
  gate; see §9). Sidebar item replaces 职位, icon `Briefcase` or `ShieldCheck`,
  label `t('nav.roles')`.
- **List:** DataTable of roles — name, description, granted points as
  `Badge`s.
- **Create / Edit:** a **purpose-built** drawer (a new component, e.g.
  `web/src/components/RoleFormDrawer.tsx`). It reuses the *visual pattern* of
  `FormDrawer` (fixed inset overlay + right-hand sliding panel + title bar +
  cancel/save footer) but takes explicit `name`/`description` text inputs and
  a **permission-point checkbox list** (one checkbox per `PermissionCode`, each
  with its `roles.perm.*` label). `FormDrawer` cannot be used directly because
  it renders a single `checkbox` field, not a list — so this is a thin sibling
  component, not a `fields`-driven `FormDrawer`. On submit it sends the checked
  `PermissionCode` strings to `rolesApi.create`/`patch`.
- **New API client** `web/src/api/roles.ts` (`rolesApi.list/create/patch/
  delete`) using the shared `apiClient`; type `Role { id, name, description?,
  permissions: string[] }`.
- **`web/src/api/types.ts`** — expose the `PermissionCode` catalog to the SPA
  (import from a shared location or a small `web/src/shared/permissions.ts`
  mirror) so the checkbox list is generated from the same vocabulary the
  server validates against.
- **Users page unchanged** — it already assigns roles via `extra_roles`
  (comma-separated `extraRoles`), which now assigns real catalog roles. No
  `positionId` field exists in the SPA user form, so no user-form change.

**PermissionCode mirror (SPA).** `web/` is self-contained and never imports
  from `enterprise_server/src` (no Vite alias; the existing
  `web/src/data/providerCatalog.ts` documents the "mirror a server/desktop
  constant" convention). Add `web/src/shared/permissions.ts` exporting the
  same `as const` `PermissionCode` object + derived type the server uses
  (§1), so the checkbox list and `rolesApi` payloads are generated from the
  one vocabulary. This mirror must stay in lockstep with
  `src/shared/enterpriseServerConstants.ts` — note the dependency in a file
  header comment, as `providerCatalog.ts` does.

**i18n additions (en + zh):** `nav.roles` (角色), `page.roles.title` (角色),
`roles.description` (描述), `roles.permissions` (权限点), `roles.add`
(新增角色), `roles.deleteConfirm` (删除该角色？), `roles.name` (角色名), and one
`roles.perm.*` label per point (e.g. `roles.perm.users.manage` = 用户管理).
Remove `nav.positions` / `page.positions.title`.

## 9. UI permission gating (unchanged model)

The SPA gates on **role names in the JWT** (`hasCapability(role)`,
`AuthGuard requires="org_admin"`), not on permission points. The Roles page
therefore gates on `requires="org_admin"` exactly as the Positions page did,
and the *server* is the authority for point-level enforcement (§4/§5). We do
**not** push permission points into the SPA — that would require re-deriving
points client-side and re-login for changes, contradicting the live-resolution
decision. Keep the SPA simple: role-name visibility gates, server point
enforcement.

## 10. Testing plan

Server (`enterprise_server/tests`, pglite):
- **`roleResolver`** — returns the union of a user's roles' points; `admin`
  alias resolves to `org_admin`'s points; unknown role names contribute
  nothing (fail-closed); `invalidate()` forces a re-read (seed a role, cache,
  edit, invalidate, observe change without waiting TTL).
- **`requirePermission` middleware** — `super_admin` bypass; allow when a role
  grants the point; `403` when no role grants it; `401` no token.
- **Route gates** — each migrated route: `403` for a token whose role lacks the
  point, `200` for one that has it (reuse the existing `signToken` + `Hono`
  `app.request` pattern from `roleVocabulary.test.ts`).
- **Roles CRUD** — create/update/delete via the new routes; unknown
  `permission` rejected (422); resolver invalidated (a follow-up resolve sees
  the edit); audit rows written.
- **Migration** — `019` seeds 4 roles idempotently (run twice, no error, no
  dupes); `020` drops `positions` + `position_id`; `021` drops
  `effective_roles_cache`; `migrate.test.ts` asserts `positions`/
  `effective_roles_cache` absent and `roles` present.
- **`/me`** — still returns `effective_roles` (= the user's role names);
  `me.test.ts` updated to the new derivation.

SPA (`web/tests`): RolesPage renders the seeded roles and the permission
checkbox list; submit posts the checked points; the user-form still assigns
roles (existing `UsersPage.test.tsx`, updated for the dropped fields).

**Commands:**
```bash
cd enterprise_server
npm test                 # server suite (pglite)
npm run web:test         # SPA suite (== npm run test --prefix web)
# touched-file lint (CI rule), e.g.:
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/auth/middleware.ts src/auth/roleResolver.ts src/org/roleService.ts \
  src/routes/admin/roles.ts src/routes/me.ts src/routes/roleVocabulary.ts
cd web && npm test && npx tsc --noEmit   # SPA typecheck
```

## 11. Non-goals / follow-ups (out of scope for this change)

- **Data-level / object-row authorization** — still handled by the existing
  `policies/scope.ts` (`role:`/`user:`/`dept-path:`/`org-wide`). No per-object
  permission points.
- **Runtime creation of new permission *points*** — the point catalog is a
  code constant (§1). If admins must invent new points at runtime, that is a
  separate, larger effort (dynamic points) and is explicitly not this change.
- **Per-permission grant auditing** beyond the role-mutation audit rows added
  here.
- **Multi-org / org-scoped roles** — roles are a global catalog (§2).
- **Pushing permission points into the SPA** — SPA keeps role-name gating
  (§9).

## 12. Rulings log

- **R1 — Full RBAC.** Add a real permission-point catalog (chosen over a
  rename-only), per the user.
- **R2 — DB-backed, live resolution** (chosen over static map / points-in-JWT):
  role→points resolved from the DB with a short-TTL + invalidation cache, so
  editing a role's points takes effect without re-login.
- **R3 — Roles are global** (not org-scoped); assignment via existing
  `users.extra_roles` role names.
- **R4 — Drop positions + FK** (hard user decision): `020` drops the column
  then the table; `001` edited for the canonical fresh schema.
- **R5 — Drop `effective_roles_cache` column + `computeEffectiveRoles`**, BUT
  **keep the `/me` `effective_roles` response field** (desktop displays it).
  R5 was forced by discovering the desktop consumer during exploration; the
  field is retained, the derivation simplified.
- **R6 — Legacy `admin` role ≡ `org_admin` points** (compat, fail-closed for
  unknown names).
- **R7 — Point catalog is a code constant; role→points is DB/dynamic.**
  The point *vocabulary* ships in code; which points a role grants is admin-
  editable at runtime.
- **R8 — SPA gates on role names, not points** (no points-in-SPA).
