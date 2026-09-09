# Organization & Permission Management — two-axis rebuild

- **Date:** 2026-09-23
- **Status:** Design — awaiting approval to implement
- **Owners (files):** `enterprise_server` (Hono + Postgres backend) + `enterprise_server/web` (admin SPA). The Electron desktop (`src/`) is **not touched**.
- **Source of truth for UI:** the delivered high-fidelity prototype `组织权限管理原型.html` (in `~/.claude` project scratch). Where this spec and the prototype conflict on visuals, the prototype wins (per PRD 附).

---

## 1. Problem

The GenWork 工作台 "组织管理" area today is three minimal pages inside the
admin SPA (`enterprise_server/web`): a 4-column user table, a flat
create-only department list, and a role list with a flat permission
checkbox. It cannot express a multi-level org tree, per-department
administration, or the "who can see *whose* data" question. The delivered PRD
(V1.0) + prototype define a much richer target: a department tree with
leadership/headcount, a **two-axis permission model** (fine-grained
functional points × a data-scope boundary), and a full user lifecycle with
batch operations — all enforced **server-side** (hidden buttons are not the
control).

This spec turns that target into a concrete, testable design.

## 2. Background — current state (verified against source)

- **Two unrelated "enterprise" stacks exist.** This task targets **Stack A
  (`enterpriseMt`)**: the local `enterprise_server` (Hono + Postgres, JWT
  Bearer) and its admin SPA. Stack B (`enterpriseAccount`, cloud/quota) is
  out of scope.
- **The org-management UI is NOT in the Electron desktop.** It lives in
  `enterprise_server/web` (Vite + React 19 + TanStack Query + Zustand). The
  desktop is a *member client*: it only calls `GET /me`, `/auth/*`,
  marketplace, usage, audit-ingest. It has no org/department/user/role CRUD.
- **Data model (Postgres, `src/db/migrations/`):**
  - `departments(id, org_id, name, parent_id, path)` — hierarchical; `path` is
    a materialized `/a/b/c` (prefix-matchable → cheap "and below").
  - `users(id, org_id, username UNIQUE(org,username), password_hash,
    display_name, department_id FK, timezone, extra_roles JSONB, status
    active|disabled, created_at)`. Roles are **free-form name strings** in
    `extra_roles`.
  - `roles(id, name UNIQUE, description, permissions JSONB)` — `permissions`
    is an array of the **10 coarse** `PermissionCode`s
    (`users.manage`, `roles.manage`, …). Seeded: `org_admin`, `model_admin`,
    `policy_admin`, `auditor` (019), `agent_admin` (025). `super_admin` is a
    code-level magic bypass, **not** a `roles` row.
  - `audit_events` with a JSONB `payload` (already flexible).
  - `003 skill_policies` + the desktop `policyResolver` `dept-path:` scope are
    **dead** (no data source); real enforcement is server-side role filtering
    on marketplace `allowed_roles`.
- **Enforcement (single axis today):** `requirePermission(code)` →
  `roleResolver.pointsFor(claims.roles)` → `Set<coarse PermissionCode>`;
  `super_admin` bypasses. No data-scope filtering exists anywhere.
- **SPA auth:** JWT in `localStorage`; `hasCapability(role)` is a
  role-*name* check from decoded claims; `AuthGuard requires="org_admin"`
  gates the org pages. The SPA keeps a **hand-maintained mirror** of the
  server's `PermissionCode` at `web/src/shared/permissions.ts`.
- **`GET /me`** returns `username, display_name, timezone, extra_roles,
  dept_path (via LEFT JOIN on primary dept_id), effective_roles`.

## 3. Goals & non-goals

**In scope (V1.0):**
- Department tree + detail (leader, headcount, sub-depts, members, tabs).
- Two-axis permission model: fine-grained `module:action` points **×** a
  data-scope enum, both **server-enforced** (越权 → `403` / filtered).
- 6 built-in roles + freely composed custom roles (copy/edit/delete).
- User lifecycle: rich profile, primary + concurrent department
  membership, role assignment, two-state status (在职 / 已停用), login
  records, bulk ops, CSV export/import.
- Audit on every org/role/dept/user mutation + data-scope change + login.
- Complete, idempotent migration of existing roles/users without breaking
  access.

**Out of scope (deferred):**
- 待离职 / 归档 states, offboarding date + timed auto-disable, 30-day archive.
  (Status is **two-state only**: 在职 `active` / 已停用 `disabled`.)
- External-advisor 30-day auto-expiry, resource handover on offboarding.
- Feishu/Lark/AD org sync, SSO, LDAP, self-service user portal.
- Email/SMS delivery. Initial/reset passwords are **shown in-app** to the
  admin (offline handoff); offboarding produces an in-app/system note, no
  external send.
- Mobile adaptation (desktop Chrome only, ≥1366×768).
- Electron desktop changes. `/me` contract stays backward-compatible.

## 4. Decision log (locked during brainstorming)

| # | Decision |
|---|---|
| 1 | **Full two-axis model, fully server-enforced.** Points are fine-grained AND data-scope is real row-level filtering (越权 → 403 / filtered). Not hidden-buttons-only. |
| 2 | **Complete migration + smooth remap.** Preserve existing role *codes*; add a human `display_name`; rewrite coarse→fine points; seed the 6 built-ins. Existing users keep working. |
| 3 | **No external email/SMS.** Passwords shown in-app. |
| 4 | **Two-state status** (在职/已停用). No 待离职/归档, no timer. |
| 5 | **Multi-department membership** (primary + concurrent). |
| 6 | **"本部门" = all of the user's departments** (primary + concurrent); "本部门及下级" = union of their subtrees. |
| 7 | **CSV export + bulk import** both in V1.0. |
| 8 | **No visual companion**; the prototype is the visual source of truth. |

## 5. The two-axis permission model

### 5.1 Axis 1 — functional points (fine-grained, `module:action`)

Replace the 10 coarse codes with a **single** `module:action` catalog as the
source of truth (per PRD §4.2.3). The coarse `PermissionCode` set is retired.

```ts
// enterprise_server/src/shared/permissionPoints.ts  (new)
export const PermissionPoint = {
  // 用户管理
  UserView: 'user:view', UserCreate: 'user:create', UserEdit: 'user:edit',
  UserDelete: 'user:delete', UserExport: 'user:export',
  // 角色管理
  RoleView: 'role:view', RoleCreate: 'role:create', RoleEdit: 'role:edit', RoleDelete: 'role:delete',
  // 部门管理
  DeptView: 'dept:view', DeptCreate: 'dept:create', DeptEdit: 'dept:edit',
  DeptDelete: 'dept:delete', DeptAdjustMember: 'dept:adjust_member',
  // 模型与密钥
  ModelView: 'model:view', ModelCreate: 'model:create', ModelEdit: 'model:edit', ModelDelete: 'model:delete',
  // 供应商密钥
  ProviderView: 'provider:view', ProviderEdit: 'provider:edit', ProviderRotate: 'provider:rotate',
  // 技能管理
  SkillView: 'skill:view', SkillCreate: 'skill:create', SkillEdit: 'skill:edit', SkillToggle: 'skill:toggle',
  // 审计日志
  AuditView: 'audit:view', AuditExport: 'audit:export',
  // 版本管理
  VersionView: 'version:view', VersionCreate: 'version:create', VersionEdit: 'version:edit',
  VersionPublish: 'version:publish', VersionRollback: 'version:rollback',
  // MCP 管理
  McpView: 'mcp:view', McpCreate: 'mcp:create', McpEdit: 'mcp:edit', McpDelete: 'mcp:delete',
  // 智能体管理
  AgentView: 'agent:view', AgentCreate: 'agent:create', AgentEdit: 'agent:edit',
  AgentDelete: 'agent:delete', AgentPublish: 'agent:publish',
} as const;
export type PermissionPoint = (typeof PermissionPoint)[keyof typeof PermissionPoint];

// Flat list (41 entries) — used for super_admin seeding + catalog-mirror test.
export const PERMISSION_POINTS: PermissionPoint[] = Object.values(PermissionPoint);

// Grouping structure for the SPA's grouped permission picker (10 modules):
export const PERMISSION_MODULES: ReadonlyArray<{
  key: string; name: string; desc: string; points: PermissionPoint[];
}> = [ /* user, role, dept, model, provider, skill, audit, version, mcp, agent */ ];
```

This satisfies the repo "String Constants" rule (centralized `as const` +
derived type). `PERMISSION_MODULES` also carries the per-module human
`name`/`desc` and the ordered `points[]` used to render the grouped
permission tree with group-toggle + 全选/清空.

**Route re-gating map** (every admin route is re-gated to the fine point it
needs; `super_admin` still bypasses):

| Route family | GET | POST (create) | PATCH (edit) | DELETE |
|---|---|---|---|---|
| `/admin/users` | `user:view` | `user:create` | `user:edit` | `user:delete` |
| `/admin/users/:id/enable\|disable\|reset-password` | — | `user:edit` | — | — |
| `/admin/users/batch` | — | `user:edit` / `dept:adjust_member` / `role:view` (by action) | — | — |
| `/admin/users/export`, `/admin/users/import` | `user:export` / `user:create` | — | — | — |
| `/admin/departments` | `dept:view` | `dept:create` | `dept:edit` | `dept:delete` |
| `/admin/roles` | `role:view` | `role:create` | `role:edit` | `role:delete` |
| `/admin/models` | `model:view` | `model:create` | `model:edit` | `model:delete` |
| `/admin/provider-keys` | `provider:view` | `provider:edit` | `provider:edit` | `provider:rotate` |
| `/admin/releases` (versions) | `version:view` | `version:create` | `version:edit` | `version:delete`/`publish`/`rollback` |
| mcp / skill / agent manage | `*:view` | `*:create` | `*:edit` | `*:delete`/`toggle`/`publish` |

`roleResolver.pointsFor` now returns `Set<PermissionPoint>` (union across the
caller's roles). `requirePermission(code: PermissionPoint)` signature keeps
shape; only the type and the catalog change. The legacy `admin`→`org_admin`
alias and `requireCapability`/`requireAdmin` remain for compat but new code
uses the point gate.

### 5.2 Axis 2 — data scope

```ts
export const DataScope = {
  OrgWide: 'org_wide',            // 全部数据
  DeptAndBelow: 'dept_and_below', // 本部门及下级
  Dept: 'dept',                    // 本部门
  Self: 'self',                    // 仅本人
  CustomDeptTree: 'custom_dept_tree', // 自定义部门树 (roles.custom_dept_ids)
} as const;
export type DataScope = (typeof DataScope)[keyof typeof DataScope];
```

**Merge rule (PRD §5.1):** across a user's roles —
- **Functional points = union** (any role granting a point suffices).
- **Data scope = intersection (narrowest wins).**

Formalization (implemented in the scope engine, §7). Map each role's scope to
a *set of visible department ids*, with two sentinels:
- `self` → sentinel `SELF` (strictly narrower than any dept set).
- `org_wide` → `ALL` (identity for intersection).
- `dept` → the caller's own department ids (primary + concurrent).
- `dept_and_below` → caller's own dept ids **∪ their descendants** (via `path` prefix).
- `custom_dept_tree` → the role's `custom_dept_ids` **∪ their descendants**.

Effective scope:
1. If **any** role resolves to `self` → effective = `SELF`.
2. Else effective = **intersection** of the contributing dept-sets
   (`ALL` contributes nothing / is the universe). Expand the result to
   include descendants.
3. If the caller has **no roles** (fail-closed) → `SELF`.
4. `super_admin` → `ALL` unconditionally.

### 5.3 Multi-department (decision #6)

"本部门" for a user = **the set of all their department ids** (primary from
`users.department_id` + concurrent from `user_departments`). "本部门及下级"
= that set ∪ each member's descendants. A **user row is visible** under a
dept scope if its *primary or any concurrent* department (including
descendant expansion) falls in the effective visible set.

## 6. Data model & migrations

New migrations (numbers continue after `027`). All idempotent, run by
`src/db/migrate.ts`.

**`028_org_permission_v2.sql` — schema:**
- `roles`: add `display_name TEXT`, `data_scope TEXT NOT NULL DEFAULT
  'self'`, `custom_dept_ids JSONB NOT NULL DEFAULT '[]'`, `is_builtin
  BOOLEAN NOT NULL DEFAULT false`. (`name` stays the **stable machine code**;
  `display_name` is the human name.)
- `departments`: add `code TEXT`, `leader_id TEXT NULL`, `sort INT NOT NULL
  DEFAULT 100`, `description TEXT`. Add `UNIQUE (org_id, code)`.
- `users`: add `email TEXT`, `phone TEXT`, `position TEXT`, `level TEXT`,
  `joined_at TIMESTAMPTZ NULL`, `last_login_at TIMESTAMPTZ NULL`,
  `last_login_ip TEXT NULL`, `last_login_device TEXT NULL`.
  Add `UNIQUE (org_id, email)` (NULLs distinct → multiple NULLs allowed).
- `user_departments` (new junction): `(user_id TEXT REFERENCES users(id),
  dept_id TEXT REFERENCES departments(id), is_primary BOOLEAN NOT NULL
  DEFAULT false, PRIMARY KEY (user_id, dept_id))`. `users.department_id`
  remains the denormalized **primary** (keeps `me.ts` join); the junction is
  the source of truth for all memberships. Index on `(dept_id)`.
- `login_events` (new): `(id, org_id, user_id, ts, ip, device, result
  ('success'|'failed'))`. Index `(user_id, ts DESC)`. Populated on
  `/auth/login` success + `login_failed`.

**`029_seed_roles_v2.sql` — seed built-ins + backfill (idempotent,
`ON CONFLICT (name) DO NOTHING` / guarded updates):**
- Create the missing built-ins: `super_admin`, `dept_admin`, `dev`, `member`
  with `is_builtin=true`, fine-grained points, and `data_scope` per §8.
- Update existing built-ins `org_admin`, `auditor`: set `is_builtin=true`,
  `display_name`, rewrite `permissions` coarse→fine, set `data_scope`.
- Demote legacy `model_admin`, `policy_admin`, `agent_admin` to **custom**
  roles: `is_builtin=false`, set `display_name`, rewrite points coarse→fine
  (they keep their machine codes so `extra_roles`, marketplace
  `allowed_roles`, and JWT role names all keep working — **no cross-module
  breakage**).
- Backfill `roles.display_name` for any role still null.

**`030_org_v2_remap.sql` — data migration (idempotent, transactional):**
- Per org: create a single root department `code='ROOT'`, `name=<org name>`,
  `parent_id=NULL`, `path='/<org name>'` if none exists; **re-parent**
  existing top-level departments (parent_id NULL) under it and rewrite their
  `path` (prefix `/<rootName>`). Guard: skip orgs that already have a single
  top-level ROOT. This is the one step that visibly changes existing users'
  `dept_path` (worth manual verification in the plan).
- Seed `user_departments` from `users.department_id` (is_primary=true) for
  all existing users.
- Remap `users.extra_roles` by name: names that no longer exist → `member`
  (unknown→fail-closed). Existing codes are preserved, so most users are
  unchanged; users with no valid role get `member`.
- No changes to `departments.code` for existing rows are forced (code is
  optional-to-backfill; leave NULL for pre-existing depts, required only for
  newly created ones).

## 7. Scope engine (the core new module)

New `enterprise_server/src/auth/scopeResolver.ts`, mirroring `roleResolver`'s
TTL-cache + `invalidate()` pattern (30s; invalidated on dept
create/move/delete and on role `data_scope`/`custom_dept_ids` change).

```ts
export type VisibleScope =
  | { kind: 'all' }                  // no row filter
  | { kind: 'self' }                 // only the caller's own rows
  | { kind: 'dept'; deptIds: string[] }; // rows whose primary/concurrent dept ∈ deptIds (descendants included)

export const scopeResolver = {
  // Pure, unit-testable: resolve effective scope from caller role names,
  // the caller's dept ids, and the loaded (roles→scope) + (dept→path) maps.
  effectiveScope(args: {
    roles: string[];                // caller role names (from JWT)
    callerDeptIds: string[];        // primary + concurrent
    roleScope: Map<string, { dataScope: DataScope; customDeptIds: string[] }>;
    deptPath: Map<string, string>;  // dept id → materialized path
    isSuperAdmin: boolean;
  }): VisibleScope;

  // Load the caller's department ids (primary + concurrent) for a user.
  deptIdsFor(orgId: string, userId: string): Promise<string[]>;
};
```

**Algorithm** (in `effectiveScope`):
1. Build, per role name, that role's visible-dept set:
   - `self` → set a `hasSelf` flag.
   - `org_wide` → mark `hasAll` (contributes nothing).
   - `dept` → `callerDeptIds`.
   - `dept_and_below` → `callerDeptIds` ∪ `descendants(callerDeptIds)`.
   - `custom_dept_tree` → `customDeptIds` ∪ `descendants(customDeptIds)`.
   `descendants(D)`: all dept ids whose `deptPath` equals or is
   `path(D) + '/'` prefixed (uses the `deptPath` map).
2. `isSuperAdmin || no roles` handled: `isSuperAdmin` → `{kind:'all'}`;
   no roles → `{kind:'self'}`.
3. `hasSelf` → `{kind:'self'}`.
4. Else intersect the non-`ALL` sets (start with the first, `Set`-intersect
   the rest); expand the intersection with `descendants`; result empty →
   `{kind:'self'}` (nothing visible beyond self); else
   `{kind:'dept'; deptIds: result}`. If every role was `org_wide` →
   `{kind:'all'}`.

**Query-layer predicate** (`scopePredicate(scope, callerId, params)` → SQL
fragment + appended params):
- `all` → `1=1`.
- `self` → `u.id = $callerId`.
- `dept` → `(u.department_id = ANY($deptIds) OR EXISTS (SELECT 1 FROM
  user_departments ud WHERE ud.user_id=u.id AND ud.dept_id = ANY($deptIds)))`.

**Enforcement surfaces:**
- **List queries** (`/admin/users`, department tree/counts, dept members) →
  apply `scopePredicate` → rows **filtered** to scope.
- **Specific-target access** (`GET /admin/users/:id`, batch targets, dept
  detail for an out-of-scope dept) → if target outside scope → `403`
  `{error:'forbidden'}` + `audit admin_access_denied`.
- This split satisfies the acceptance criterion: "dept_admin 越权访问其他部门
  数据被拒绝" (direct access → 403; lists → filtered).

**Performance:** descendant expansion uses the indexed `departments.path`
column (a `LIKE '/prefix/%'` query per root, or an in-memory expand from the
cached `deptPath` map — fine for ≤500 nodes). Avoid in-memory expansion of a
full tree per row; resolve `deptIds` once per request.

## 8. Built-in & legacy roles (after migration)

Machine `name` = stable code. `display_name` = human name. Points are the
fine-grained §5.1 set. Built-ins are non-deletable and version-maintained.

| code | display_name | is_builtin | data_scope | points |
|---|---|---|---|---|
| `super_admin` | 超级管理员 | ✓ | org_wide | **all points** (every entry in `PERMISSION_POINTS` — 41 across the 10 modules) + code bypass |
| `org_admin` | 组织管理员 | ✓ | org_wide | user.*, role.*, dept.*, skill.*, version.*, mcp.*, agent.* (no provider.*, no audit.*) |
| `dept_admin` | 部门管理员 | ✓ | dept_and_below | dept.*, user.view, user.edit, role.view |
| `auditor` | 安全审计员 | ✓ | org_wide (read-only) | audit.view, audit.export |
| `dev` | 应用开发者 | ✓ | dept_and_below | skill.view/create/edit, mcp.view/create, agent.view/create/edit |
| `member` | 普通成员 | ✓ | self | agent.view, skill.view |
| `model_admin` | 模型管理员 | ✗ (custom) | org_wide | model.*, provider.* |
| `policy_admin` | 技能管理员 | ✗ (custom) | org_wide | skill.*, role.view |
| `agent_admin` | 智能体管理员 | ✗ (custom) | org_wide | agent.* |

Notes:
- `org_admin` deliberately lacks `provider:*` (PRD: 不可见供应商密钥明文) and
  `audit:*` (separation of duties).
- `dept_admin` can manage its dept subtree + members, and *assign* roles
  (role.view) but not edit role definitions.
- Custom-role **delete guard:** if the role has assigned members, deletion is
  blocked (reassign first) — protects seeded `model_admin`/etc. in practice.
- Built-in **edit guard:** built-in roles' points/data_scope are
  version-maintained; the UI hides edit for built-ins (copy-to-custom to
  customize). Server allows PATCH but re-applies on upgrade (idempotent seed
  re-asserts built-in definitions).

## 9. Backend API surface

All routes keep the `/admin/…` + `/me` prefixes and JWT auth. Responses are
camelCase to the SPA (existing convention). `422 {error:'invalid_input',
issues}` for validation (existing idiom). All mutations write audit
(operator, target, before/after snapshot in `payload`).

### Departments
- `GET /admin/departments?orgId=` → tree; each node: `id,name,code,parent_id,
  path,leader_id,sort,description,directMembers,subtreeMembers,children[]`.
  **Scope-filtered** (a dept_admin sees only their subtree).
- `GET /admin/departments/:id` → detail: stats (direct/subtree/children/
  leader), base info, member rows, children. 403 if outside scope.
- `POST /admin/departments` → `{orgId, name, code, parentId, leaderId, sort,
  description}`. `code` required, unique per org, **immutable** after create.
- `PATCH /admin/departments/:id` → rename / leader / sort / parent-move /
  description. `code` immutable (reject changes). Parent-move rewrites
  `path` for the subtree (transactional).
- `DELETE /admin/departments/:id` → **blocked** (409) if it has direct
  members or children; response guides the admin to move members / delete
  children first.
- `POST /admin/departments/reorder` → reorder siblings `{orgId,parentId,
  orderedIds[]}` (updates `sort`).

### Users
- `GET /admin/users?orgId=&q=&deptId=&roleId=&status=` → filtered +
  **scope-filtered** list; each row: `id, username, displayName, email,
  phone, position, level, primaryDept{name,code,path}, concurrentDepts[],
  roles[{code,displayName,dataScope}], status, lastLogin{at,ip,device},
  joinedAt`.
- `GET /admin/users/:id` → full profile + last 10 `login_events`. 403
  out-of-scope.
- `POST /admin/users` → create (onboarding). Body: `username, displayName,
  email, phone, position, level, primaryDeptId, concurrentDeptIds[], roles[],
  joinedAt, timezone`. **Generates a strong initial password server-side and
  returns it** in the response `{id, tempPassword}` for the admin to share
  in-app; user is created `active` with default `member` role if `roles`
  omitted. Scope-checked: creator must be able to see the target dept.
- `PATCH /admin/users/:id` → profile / primary+concurrent depts / roles /
  position/level / joinedAt. (No delete route in V1.0 — offboarding =
  disable.)
- `POST /admin/users/:id/enable` / `/disable` / `/reset-password` (reset
  returns a new `{tempPassword}` shown in-app).
- `GET /admin/users/export?…` → CSV (same columns, **scope-filtered**).
  Gated `user:export`.
- `POST /admin/users/import` → CSV body; **create-only** with per-row
  validation (username/email unique, dept code + role codes must exist).
  Returns `{created, skipped, errors:[{row, reason}]}`. Gated `user:create`.
- `POST /admin/users/batch` → `{action: 'assign_role'|'adjust_dept'|
  'enable'|'disable'|'reset_password', userIds[], roleCodes?, deptId?, …}`.
  **All targets must be in scope or the request is 403** (fail-closed,
  audited). Each action maps to its fine point (§5.1).

### Roles
- `GET /admin/roles?type=builtin|custom|all` → list with `memberCount`,
  `dataScope`, `is_builtin`, `display_name`.
- `POST /admin/roles` → `{name(code), displayName, description, dataScope,
  customDeptIds?, permissions[]}`. `name` unique, `[a-z0-9_]`.
- `PATCH /admin/roles/:id` → update (built-in guarded per §8).
- `DELETE /admin/roles/:id` → custom only; blocked if it has members.
- `POST /admin/roles/:id/copy` → create a custom copy (new code) for
  customization.
- `GET /api/roles/vocabulary` — keep; now returns role codes (+ display names).

### `GET /me` (backward-compatible extension)
Keep existing fields; **add** `permissions: PermissionPoint[]` (the caller's
resolved union), `effectiveDataScope: 'all'|'self'|'dept'`, and
`concurrentDeptPaths[]`. The SPA uses `permissions` for button visibility and
`effectiveDataScope` for the "数据范围" readout. Enforcement remains
server-side; these are display-only. Desktop ignores the new fields.

### Audit
- `GET /admin/audit` extended to include org/role/dept/user changes,
  data-scope changes, and login records (from `login_events`).
- New admin mutations write before/after snapshots into `payload`.
- Login (`/auth/login`) writes a `login_events` row (ip from
  `x-forwarded-for`/remote, device from User-Agent) on success + failure, and
  updates `users.last_login_*`.

## 10. Frontend (rebuild 3 pages to match the prototype)

Tech: existing `enterprise_server/web` (React 19, TanStack Query, Zustand,
Tailwind, lucide icons). Reuse primitives: `FormDrawer`, `DataTable`,
`ConfirmDialog`, `Badge`, `StatusPill`, `PageHeader`, `toastStore`, i18n
`t()`. New bespoke components (match prototype tokens):

- **`DeptTree`** — left tree: search (name/code), expand/collapse, per-node
  subtree count badge, select; sticky card.
- **`DeptDetail`** — code tag, breadcrumb path, 编辑/新增子部门 buttons, 4
  stat cards (直属/含下级/下级部门数/负责人), base info, tabs
  (部门成员 / 下级部门 / 操作日志), member table → user detail.
- **`DeptFormDrawer`** — name*, code* (immutable flag), parent (tree-select),
  leader (user picker), sort, description; delete-guard notice.
- **Role card grid** — 内置/自定义 segmented toggle; cards (name, code, type
  tag, desc, member count, data scope; built-in hides delete; hover copy/
  edit).
- **`RoleFormDrawer` (3-step)** — ① 基本信息 (name/code/desc) ② 数据范围
  (5 radio-cards; 自定义部门树 expands a multi-select dept tree) ③ 功能权限点
  (`PERMISSION_MODULES` grouped tree, group-toggle + per-action checkboxes,
  全选/清空).
- **Users page** — filter bar (search + dept/role/status dropdowns +
  新建/批量导入/导出), table (checkbox, avatar+name+email, dept path,
  position/level, role tags, status, last login, actions), dark floating
  **batch bar** (分配角色/调整部门/启用停用/重置密码).
- **`UserFormDrawer`** — 基本信息 / 组织归属 (主部门树选, 入职日期, 兼职部门
  chips) / 角色与权限 (chips with per-role data-scope label + the "并集+交集"
  explainer) / 最近登录 (detail only). New-password readout on create/reset.
- **`UserImportDialog`** — template download, upload, per-row result report.

**i18n:** move all hardcoded English (current `UsersPage`/`DepartmentsPage`)
into `web/src/i18n.ts` with zh + en; the SPA's `permissions.ts` mirror is
**regenerated** to the fine-grained `PERMISSION_MODULES` (add `name`/`desc`
per module + per-point label). A **test asserts the SPA catalog == server
catalog** (codes and module grouping), so the hand-mirror can't drift.

**SPA auth:** `useAuth`/`GET /me` exposes `permissions` + `effectiveDataScope`;
`hasPermission(point)` drives per-button/action visibility. Page-level
`AuthGuard` updated to the built-in role set. Button-hiding is UX only — the
server is the control.

## 11. Security & audit

- Every org/role/dept/user mutation, data-scope change, and enable/disable
  writes audit: operator, time, IP, **before/after** (in `payload`).
- Provider-key plaintext is **never returned** when the caller lacks
  `provider:view` — gate `GET /admin/provider-keys` on `provider:view` and
  strip plaintext otherwise (P4 hardening).
- Login records capture IP + User-Agent (`login_events`).
- Frontend button-hiding is explicitly **not** a control; every gate and
  scope filter is server-side, and out-of-scope direct access returns `403` +
  audit.

## 12. Testing & verification

**Server (Vitest; run per-file — the full suite hits the sandbox fd limit):**
- `scopeResolver` unit tests — the highest-risk logic: intersection/
  narrowest-wins, `self` short-circuit, `org_wide` identity, multi-dept union,
  `custom_dept_tree`, descendant expansion via path prefix, no-roles→self,
  super_admin→all.
- Data-scope integration tests on `testDb`: a `dept_admin` cannot `GET`
  another dept's user → 403; user list is filtered to their subtree; batch
  targeting an out-of-scope user → 403.
- Migration tests: seed 6 built-ins; remap idempotency (run twice = same);
  root creation + re-parent path rewrite; `user_departments` backfill;
  `extra_roles` unknown→member.
- Point re-gating tests: each re-gated route returns 403 without the point,
  200/422 with it; `super_admin` bypass.
- CSV import/export round-trip; import validation (dup username, bad dept
  code, bad role code → error report, no partial bad rows).
- Batch ops: in-scope succeeds, mixed in/out-of-scope → 403.
- Built-in delete guard; custom delete with members → blocked; copy.

**SPA (Vitest + Playwright visual):**
- Catalog-mirror test (SPA `permissions.ts` == server `PERMISSION_MODULES`).
- Data-scope label on role chips; 3-step drawer state; batch bar appears on
  selection; i18n keys present (zh + en).
- Visual snapshots for the 3 pages + drawers (update with `web:test:visual`).

**Manual:** `npm run web:dev` against a seeded Postgres. Walk the
`dept_admin` 越权 scenario (403 + filtered lists), a batch assign-role, a CSV
import with a bad row, and the root-re-parent path change on an existing org.

## 13. Phasing & effort

Substantial, multi-phase; each phase independently committable and green.

- **P1 — Foundation.** Migrations `028–030`; `PermissionPoint` /
  `DataScope` catalogs; `scopeResolver` (+ tests); role seeding + remap;
  re-gate **all** admin routes to fine points; `roleResolver` type swap.
  Heavily tested (scope engine + migration).
- **P2 — APIs.** Dept (tree/detail/CRUD/move/delete-guard/reorder), User
  (profile/CRUD/batch/CSV/status/login events), Role (list/copy/delete-guard),
  `/me` extension, audit before/after. Per-file integration tests.
- **P3 — Frontend.** Rebuild the 3 pages + drawers + batch bar + import
  dialog; `DeptTree`; `permissions.ts` mirror regen + mirror test; i18n (zh +
  en).
- **P4 — Hardening.** Provider-key field gating; security field-stripping;
  visual snapshots; acceptance walkthrough (越权→403, batch, import,
  root-re-parent verification).

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Data-scope correctness (multi-dept intersection, descendant expansion) | Isolated, pure, heavily-unit-tested `scopeResolver`; integration 403 tests. |
| Point-vocabulary swap breaks out-of-scope admin routes | Re-gate **all** of them in P1; per-file route tests stay green; `super_admin` bypass preserved. |
| Migration data change (root re-parent, path rewrite, points rewrite, `extra_roles`) | Idempotent + transactional; migration tests assert before/after; manual verification of an existing org's `dept_path`. |
| Stale JWT roles vs. live data-scope | Scope derived from **live DB** at query time (JWT carries role names only, sufficient for the action gate). |
| Desktop `/me` backward-compat | `/me` only **adds** fields; desktop ignores them. |
| SPA/server permission-catalog drift | Hand-mirror regenerated + a **test asserting equality**. |
| i18n gaps (current pages are hardcoded English) | All new/ported strings into `i18n.ts` zh + en; checklist in P3. |
| Perf at 500 depts / 1000 users | Resolve `deptIds` once per request; use the `path` index for descendants; no per-row tree expansion. |

## 15. Deferred / open items (per PRD 未决事项, out of V1.0)

- Feishu org auto-sync (V1.1).
- Role-change approval flow (e.g. dev → org_admin).
- External-advisor 30-day auto-expiry + admin-adjustable expiry.
- 待离职/归档 states + timed auto-disable + resource handover (would need a
  background scheduler; intentionally out of V1.0).
- Email/SMS delivery (passwords shown in-app for now).
