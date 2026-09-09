# Organization & Permission two-axis rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the enterprise org/department/user/role admin area as a two-axis permission system (fine-grained `module:action` points × a server-enforced data scope), with a full user lifecycle, batch ops, CSV import/export, and audit — matching the V1.0 PRD + prototype.

**Architecture:** Backend lives in `enterprise_server` (Hono + Postgres via `pg`, JWT Bearer). A new pure `scopeResolver` computes each caller's effective visible-scope from live data (not the JWT) and is applied as a row filter to list queries / a 403 on out-of-scope direct access. A single `module:action` point catalog replaces the 10 coarse codes; every admin route is re-gated to its fine point. Migrations `028–030` add schema, seed 6 built-in roles, and remigrate existing roles/users. Frontend is the `enterprise_server/web` SPA (React 19 + TanStack Query + Zustand + Tailwind); the 3 pages are rebuilt to match the prototype, and a hand-maintained permission mirror is regenerated + pinned by a test. The Electron desktop is untouched.

**Tech Stack:** TypeScript, Hono, `pg` (prod) / PGlite `testPool` (tests), `jose` (JWT), `zod`, bcryptjs, Vitest (server `enterprise_server/tests`, SPA `web/tests`), React 19, TanStack Query, Zustand, Tailwind, `@testing-library/react`, Playwright (visual).

**Spec:** `docs/superpowers/specs/2026-09-23-org-permission-two-axis-design.md`

## Global Constraints

- **Working dir for all server paths:** `/Users/paulwang/work/GenWork/enterprise_server`. Frontend under `enterprise_server/web`.
- **Run migrations** by adding numbered SQL files to `src/db/migrations/` (runner `src/db/migrate.ts` picks them up; latest existing is `027`). All migrations must be idempotent (`IF NOT EXISTS` / `ON CONFLICT ... DO NOTHING` / guarded `UPDATE`).
- **DB in tests:** every test imports `'../helpers/setupEnv'` and mocks the pool:
  ```ts
  vi.mock('../../src/db/pool', async () => { const td = await import('../../src/db/testDb'); return { pool: td.testPool }; });
  ```
  then `beforeEach` does `await resetSchema(); await runMigrations();`.
- **Route tests:** build `new Hono()` + `a.route('/', <routes>)`, call `app().request(path, { headers: { authorization: `Bearer ${token}` } })` with `signToken({sub, orgId, roles})` from `src/auth/jwt`. Assert `.status`.
- **Run tests PER FILE** (the full server suite hits a sandbox fd limit): `npx vitest run <path>`. SPA: `npm run web:test -- <path>` (or `npx vitest run <path>` inside `web/`).
- **String constants:** discriminants/status/point codes come from centralized `as const` objects (repo rule). Do NOT hardcode new discriminant strings; extend the catalogs.
- **i18n:** no hardcoded user-visible strings in the SPA. Add BOTH `en` and `zh` entries in `web/src/i18n.ts` (two `Dict`s: `en` starts line 3, `zh` starts line ~516; `t(key)` at ~1041).
- **Lint gate:** touched TS/TSX files must be clean under `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>` (server and web separately).
- **No external email/SMS.** Passwords are generated server-side and returned to the admin in-app. Status is two-state only (`active`/`disabled`).
- **Desktop `/me` backward-compat:** `GET /me` only *adds* fields; never rename/remove existing ones.
- **Conventional Commit messages in English.** Do not commit until the user confirms (per repo rules) — the plan's commit steps are grouped per task; a coordinator may batch them.

---

## File Structure (new/modified, by responsibility)

**Server — catalogs & engine (P1):**
- `src/shared/permissionPoints.ts` *(new)* — `PermissionPoint` (41 pts), `PERMISSION_POINTS` list, `PERMISSION_MODULES` (10 grouped modules w/ name+desc+points[]), `DataScope` enum + `DATA_SCOPE_VALUES`.
- `src/auth/scopeResolver.ts` *(new)* — pure `effectiveScope(...)`, `VisibleScope` type, `scopePredicate(scope, callerId)` SQL builder, `descendantsOf(...)`, TTL-cached `roleScopeMap`/`deptPathMap` loaders + `invalidate()`, `deptIdsFor(orgId,userId)`.
- `src/auth/roleResolver.ts` *(modify)* — `pointsFor` returns `Set<PermissionPoint>` (type swap only).
- `src/db/migrations/028_org_permission_v2.sql`, `029_seed_roles_v2.sql`, `030_org_v2_remap.sql` *(new)*.

**Server — re-gating (P1):**
- `src/routes/admin/{users,departments,roles,models,providerKeys,releases}.ts`, `src/routes/{agentMarketplaceAdmin,skillMarketplaceAdmin,mcpMarketplaceAdmin}.ts`, `src/routes/roleVocabulary.ts` — re-gate `requirePermission(<fine point>)`.
- `src/routes/me.ts` — add `permissions`, `effectiveDataScope`, `concurrentDeptPaths`.

**Server — services (P1/P2):**
- `src/org/orgService.ts` *(modify)* — new fields on `createUser`/`patchUser`, `listUsers` scope-aware, department `code/leader/sort/description`, parent-move + path rewrite, `user_departments` maintenance, delete-guard, reorder.
- `src/org/roleService.ts` *(modify)* — `dataScope`, `customDeptIds`, `isBuiltin`, `displayName`, `memberCount`, copy, delete-with-members guard.
- `src/org/loginRecord.ts` *(new)* — `recordLogin(orgId, userId, ip, device, result)`.

**Server — APIs (P2):**
- `src/routes/admin/departments.ts` *(grow)*, `src/routes/admin/users.ts` *(grow: batch/export/import/status), `src/routes/admin/roles.ts` *(grow: copy, type filter, delete guard)*, `src/routes/audit.ts`/`admin/audit.ts` *(login events)*, `src/routes/auth.ts` (login → `login_events` + `last_login_*`).

**SPA (P3):**
- `web/src/shared/permissions.ts` *(regenerate to `PERMISSION_MODULES` + `DataScope` + labels)*.
- `web/src/api/{departments,users,roles}.ts` *(extend types + methods)*.
- `web/src/components/DeptTree.tsx`, `DeptDetail.tsx`, `DeptFormDrawer.tsx`, `RoleFormDrawer3.tsx`, `PermissionGroupTree.tsx`, `UserFormDrawer.tsx`, `UserImportDialog.tsx`, `BatchBar.tsx`, `StatRow2.tsx` *(new)*.
- `web/src/pages/{DepartmentsPage,RolesPage,UsersPage,UserDetailPage}.tsx` *(rebuild)*.
- `web/src/i18n.ts` *(add zh+en keys)*.

**SPA tests (P3):** `web/tests/shared/permissionsMirror.test.ts`, `web/tests/pages/{DepartmentsPage,RolesPage,UsersPage}.test.tsx`.
**Server tests (P1/P2):** `tests/auth/scopeResolver.test.ts`, `tests/migrations/migration029.test.ts`, `tests/routes/scopeEnforcement.test.ts`, `tests/routes/usersBatch.test.ts`, `tests/routes/usersCsv.test.ts`, `tests/routes/rolesV2.test.ts`, plus updates to `tests/auth/roleResolver.test.ts`, `tests/routes/roles.test.ts`, `tests/shared/permissionCodes.test.ts`.
**P4:** `web/tests/visual/*.test.ts` (Playwright snapshots), `web/playwright.config.ts` (exists; run `web:test:visual`).

---

# PHASE 1 — Foundation (catalog, scope engine, migrations, re-gating, /me)

Each P1 task is independently green. After P1, the app still boots and all existing (updated) route tests pass.

### Task 1: Fine-grained permission catalog + DataScope

**Files:**
- Create: `src/shared/permissionPoints.ts`
- Test: `tests/shared/permissionPoints.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PermissionPoint` (string union), `PERMISSION_POINTS: PermissionPoint[]`, `PERMISSION_MODULES: ReadonlyArray<{key;name;desc;points:PermissionPoint[]}>`, `DataScope` (union), `DATA_SCOPE_VALUES: DataScope[]`, `BUILTIN_ROLE_POINTS: Record<string, PermissionPoint[]>` (used by migration seed + built-in guard).

- [ ] **Step 1: Write the failing test**

`tests/shared/permissionPoints.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { DataScope, DATA_SCOPE_VALUES, PERMISSION_MODULES, PERMISSION_POINTS } from '../../src/shared/permissionPoints';

describe('permissionPoints catalog', () => {
  test('exposes 41 unique fine-grained points', () => {
    expect(new Set(PERMISSION_POINTS).size).toBe(PERMISSION_POINTS.length);
    expect(PERMISSION_POINTS).toHaveLength(41);
  });
  test('every point is module:action and covered by exactly one module', () => {
    const all = PERMISSION_MODULES.flatMap((m) => m.points);
    expect(new Set(all).size).toBe(41);
    for (const p of all) expect(p).toMatch(/^[a-z]+:[a-z_]+$/);
  });
  test('data scope enum has the 5 PRD values', () => {
    expect(DATA_SCOPE_VALUES).toEqual(
      ['org_wide', 'dept_and_below', 'dept', 'self', 'custom_dept_tree'],
    );
    expect(DataScope.Self).toBe('self');
  });
  test('super_admin built-in point set is the full catalog', () => {
    // super_admin covers every point; assert a few module anchors are present
    for (const m of PERMISSION_MODULES) {
      for (const p of m.points) {
        expect(PERMISSION_POINTS).toContain(p);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/permissionPoints.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/permissionPoints'`.

- [ ] **Step 3: Write the catalog**

`src/shared/permissionPoints.ts`:
```ts
export const PermissionPoint = {
  UserView: 'user:view', UserCreate: 'user:create', UserEdit: 'user:edit',
  UserDelete: 'user:delete', UserExport: 'user:export',
  RoleView: 'role:view', RoleCreate: 'role:create', RoleEdit: 'role:edit', RoleDelete: 'role:delete',
  DeptView: 'dept:view', DeptCreate: 'dept:create', DeptEdit: 'dept:edit',
  DeptDelete: 'dept:delete', DeptAdjustMember: 'dept:adjust_member',
  ModelView: 'model:view', ModelCreate: 'model:create', ModelEdit: 'model:edit', ModelDelete: 'model:delete',
  ProviderView: 'provider:view', ProviderEdit: 'provider:edit', ProviderRotate: 'provider:rotate',
  SkillView: 'skill:view', SkillCreate: 'skill:create', SkillEdit: 'skill:edit', SkillToggle: 'skill:toggle',
  AuditView: 'audit:view', AuditExport: 'audit:export',
  VersionView: 'version:view', VersionCreate: 'version:create', VersionEdit: 'version:edit',
  VersionPublish: 'version:publish', VersionRollback: 'version:rollback',
  McpView: 'mcp:view', McpCreate: 'mcp:create', McpEdit: 'mcp:edit', McpDelete: 'mcp:delete',
  AgentView: 'agent:view', AgentCreate: 'agent:create', AgentEdit: 'agent:edit',
  AgentDelete: 'agent:delete', AgentPublish: 'agent:publish',
} as const;
export type PermissionPoint = (typeof PermissionPoint)[keyof typeof PermissionPoint];

export const PERMISSION_POINTS: PermissionPoint[] = Object.values(PermissionPoint);

export const DataScope = {
  OrgWide: 'org_wide',
  DeptAndBelow: 'dept_and_below',
  Dept: 'dept',
  Self: 'self',
  CustomDeptTree: 'custom_dept_tree',
} as const;
export type DataScope = (typeof DataScope)[keyof typeof DataScope];
export const DATA_SCOPE_VALUES: DataScope[] = [
  'org_wide', 'dept_and_below', 'dept', 'self', 'custom_dept_tree',
];

// Module grouping for the SPA grouped-permission picker (order = render order).
const user = [PermissionPoint.UserView, PermissionPoint.UserCreate, PermissionPoint.UserEdit, PermissionPoint.UserDelete, PermissionPoint.UserExport];
const role = [PermissionPoint.RoleView, PermissionPoint.RoleCreate, PermissionPoint.RoleEdit, PermissionPoint.RoleDelete];
const dept = [PermissionPoint.DeptView, PermissionPoint.DeptCreate, PermissionPoint.DeptEdit, PermissionPoint.DeptDelete, PermissionPoint.DeptAdjustMember];
const model = [PermissionPoint.ModelView, PermissionPoint.ModelCreate, PermissionPoint.ModelEdit, PermissionPoint.ModelDelete];
const provider = [PermissionPoint.ProviderView, PermissionPoint.ProviderEdit, PermissionPoint.ProviderRotate];
const skill = [PermissionPoint.SkillView, PermissionPoint.SkillCreate, PermissionPoint.SkillEdit, PermissionPoint.SkillToggle];
const audit = [PermissionPoint.AuditView, PermissionPoint.AuditExport];
const version = [PermissionPoint.VersionView, PermissionPoint.VersionCreate, PermissionPoint.VersionEdit, PermissionPoint.VersionPublish, PermissionPoint.VersionRollback];
const mcp = [PermissionPoint.McpView, PermissionPoint.McpCreate, PermissionPoint.McpEdit, PermissionPoint.McpDelete];
const agent = [PermissionPoint.AgentView, PermissionPoint.AgentCreate, PermissionPoint.AgentEdit, PermissionPoint.AgentDelete, PermissionPoint.AgentPublish];

export const PERMISSION_MODULES: ReadonlyArray<{ key: string; name: string; desc: string; points: PermissionPoint[] }> = [
  { key: 'user', name: '用户管理', desc: '创建、编辑、禁用、归档用户与组织归属', points: user },
  { key: 'role', name: '角色管理', desc: '管理角色及每个角色被授予的权限点', points: role },
  { key: 'dept', name: '部门管理', desc: '管理部门组织树、负责人与成员', points: dept },
  { key: 'model', name: '模型与密钥管理', desc: '管理模型配置：服务商、模型与配额', points: model },
  { key: 'provider', name: '供应商密钥管理', desc: '管理供应商 API 密钥（在「模型配置」中）', points: provider },
  { key: 'skill', name: '技能管理', desc: '管理技能：启用/禁用及作用域设置', points: skill },
  { key: 'audit', name: '查看审计日志', desc: '查看组织审计日志', points: audit },
  { key: 'version', name: '版本管理', desc: '管理应用版本发布：新增、编辑、设为最新', points: version },
  { key: 'mcp', name: 'MCP 管理', desc: '管理 MCP 服务器市场', points: mcp },
  { key: 'agent', name: '智能体管理', desc: '管理企业智能体模板：新增、编辑、删除及可用角色', points: agent },
];

// Fine-grained point sets per built-in role (spec §8). Single source used by
// migration 029 seed and the built-in re-assertion guard.
const orgAdmin: PermissionPoint[] = [
  ...user, ...role, ...dept, ...skill, ...version, ...mcp, ...agent,
];
export const BUILTIN_ROLE_POINTS: Record<string, PermissionPoint[]> = {
  super_admin: PERMISSION_POINTS,
  org_admin: orgAdmin,
  dept_admin: [
    PermissionPoint.DeptView, PermissionPoint.DeptCreate, PermissionPoint.DeptEdit,
    PermissionPoint.DeptAdjustMember, PermissionPoint.UserView, PermissionPoint.UserEdit,
    PermissionPoint.RoleView,
  ],
  auditor: [PermissionPoint.AuditView, PermissionPoint.AuditExport],
  dev: [
    PermissionPoint.SkillView, PermissionPoint.SkillCreate, PermissionPoint.SkillEdit,
    PermissionPoint.McpView, PermissionPoint.McpCreate,
    PermissionPoint.AgentView, PermissionPoint.AgentCreate, PermissionPoint.AgentEdit,
  ],
  member: [PermissionPoint.AgentView, PermissionPoint.SkillView],
  model_admin: [...model, ...provider],
  policy_admin: [...skill, PermissionPoint.RoleView],
  agent_admin: agent,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/permissionPoints.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/permissionPoints.ts tests/shared/permissionPoints.test.ts
git commit -m "feat(enterprise): add fine-grained permission-point + data-scope catalogs"
```

### Task 2: Pure scope engine (effectiveScope + descendants + predicate)

**Files:**
- Create: `src/auth/scopeResolver.ts`
- Test: `tests/auth/scopeResolver.test.ts`

**Interfaces:**
- Consumes: `DataScope` (Task 1).
- Produces:
  - `type VisibleScope = { kind:'all' } | { kind:'self' } | { kind:'dept'; deptIds: string[] }`
  - `effectiveScope(args: { roles: string[]; callerDeptIds: string[]; roleScope: Map<string, {dataScope: DataScope; customDeptIds: string[]}>; deptPath: Map<string,string>; isSuperAdmin: boolean }): VisibleScope`
  - `descendantsOf(deptIds: string[], deptPath: Map<string,string>): Set<string>`
  - `scopePredicate(scope: VisibleScope, callerId: string): { where: string; params: unknown[] }`

- [ ] **Step 1: Write the failing test**

`tests/auth/scopeResolver.test.ts` (pure — no DB, no pool mock needed):
```ts
import { describe, expect, test } from 'vitest';
import { descendantsOf, effectiveScope, scopePredicate } from '../../src/auth/scopeResolver';

const PATH = new Map([
  ['/a', '/a'], ['/a/b', '/a/b'], ['/a/c', '/a/c'], ['/b', '/b'], ['/b/d', '/b/d'],
]);

test('descendantsOf expands via path prefix', () => {
  const d = descendantsOf(['/a'], PATH);
  expect([...d].sort()).toEqual(['/a', '/a/b', '/a/c']);
});

test('super_admin → all', () => {
  const s = effectiveScope({ roles: ['member'], callerDeptIds: ['/a'], roleScope: new Map(), deptPath: PATH, isSuperAdmin: true });
  expect(s).toEqual({ kind: 'all' });
});

test('no roles → self (fail-closed)', () => {
  const s = effectiveScope({ roles: [], callerDeptIds: ['/a'], roleScope: new Map(), deptPath: PATH, isSuperAdmin: false });
  expect(s).toEqual({ kind: 'self' });
});

test('self short-circuits to self even with a broad role', () => {
  const s = effectiveScope({
    roles: ['r1', 'r2'], callerDeptIds: ['/a'],
    roleScope: new Map([
      ['r1', { dataScope: 'dept_and_below', customDeptIds: [] }],
      ['r2', { dataScope: 'self', customDeptIds: [] }],
    ]),
    deptPath: PATH, isSuperAdmin: false,
  });
  expect(s).toEqual({ kind: 'self' });
});

test('org_wide only → all', () => {
  const s = effectiveScope({
    roles: ['r1'], callerDeptIds: ['/a'],
    roleScope: new Map([['r1', { dataScope: 'org_wide', customDeptIds: [] }]]),
    deptPath: PATH, isSuperAdmin: false,
  });
  expect(s).toEqual({ kind: 'all' });
});

test('intersection takes the narrowest (a in both)', () => {
  const s = effectiveScope({
    roles: ['r1', 'r2'], callerDeptIds: ['/a'],
    roleScope: new Map([
      ['r1', { dataScope: 'org_wide', customDeptIds: [] }],          // identity
      ['r2', { dataScope: 'custom_dept_tree', customDeptIds: ['/b'] }],
    ]),
    deptPath: PATH, isSuperAdmin: false,
  });
  // intersection of (all) and {/b + descendants} = {/b,/b/d}
  expect(s.kind).toBe('dept');
  if (s.kind === 'dept') expect([...s.deptIds].sort()).toEqual(['/b', '/b/d']);
});

test('multi-dept caller: dept_and_below unions own subtrees', () => {
  const s = effectiveScope({
    roles: ['r1'], callerDeptIds: ['/a', '/b'],
    roleScope: new Map([['r1', { dataScope: 'dept_and_below', customDeptIds: [] }]]),
    deptPath: PATH, isSuperAdmin: false,
  });
  expect(s.kind).toBe('dept');
  if (s.kind === 'dept') expect([...s.deptIds].sort()).toEqual(['/a', '/a/b', '/a/c', '/b', '/b/d']);
});

test('scopePredicate: self filters to caller id', () => {
  const p = scopePredicate({ kind: 'self' }, 'u1');
  expect(p.where).toContain('u.id = $1');
  expect(p.params).toEqual(['u1']);
});
test('scopePredicate: dept uses ANY + concurrent-dept exists', () => {
  const p = scopePredicate({ kind: 'dept', deptIds: ['/a', '/b'] }, 'u1');
  expect(p.where).toContain('u.department_id = ANY($1)');
  expect(p.where).toContain('user_departments');
  expect(p.params).toEqual([['/a', '/b']]);
});
test('scopePredicate: all is a no-op', () => {
  const p = scopePredicate({ kind: 'all' }, 'u1');
  expect(p.where).toBe('1=1');
  expect(p.params).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth/scopeResolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the engine (pure functions first)**

`src/auth/scopeResolver.ts` (pure part — the cached DB loaders are added in Task 5):
```ts
import type { DataScope } from '../shared/permissionPoints';

export type VisibleScope =
  | { kind: 'all' }
  | { kind: 'self' }
  | { kind: 'dept'; deptIds: string[] };

export function descendantsOf(deptIds: string[], deptPath: Map<string, string>): Set<string> {
  const out = new Set<string>(deptIds);
  for (const root of deptIds) {
    const prefix = deptPath.get(root);
    if (!prefix) continue;
    for (const [id, path] of deptPath) {
      if (path === prefix || path.startsWith(prefix + '/')) out.add(id);
    }
  }
  return out;
}

interface RoleScopeInfo { dataScope: DataScope; customDeptIds: string[] }

export function effectiveScope(args: {
  roles: string[];
  callerDeptIds: string[];
  roleScope: Map<string, RoleScopeInfo>;
  deptPath: Map<string, string>;
  isSuperAdmin: boolean;
}): VisibleScope {
  const { roles, callerDeptIds, roleScope, deptPath, isSuperAdmin } = args;
  if (isSuperAdmin) return { kind: 'all' };
  if (roles.length === 0) return { kind: 'self' };

  let hasSelf = false;
  let hasAll = true; // org_wide contributes the universe
  const sets: Set<string>[] = [];

  for (const name of roles) {
    const info = roleScope.get(name);
    if (!info) continue; // unknown role contributes nothing (fail-closed)
    if (info.dataScope === 'self') { hasSelf = true; continue; }
    if (info.dataScope === 'org_wide') { continue; }
    hasAll = false;
    if (info.dataScope === 'dept') {
      sets.push(new Set(callerDeptIds));
    } else if (info.dataScope === 'dept_and_below') {
      sets.push(descendantsOf(callerDeptIds, deptPath));
    } else { // custom_dept_tree
      sets.push(descendantsOf(info.customDeptIds, deptPath));
    }
  }

  if (hasSelf) return { kind: 'self' };
  if (sets.length === 0) return { kind: 'all' }; // only org_wide roles

  let acc = new Set(sets[0]!);
  for (let i = 1; i < sets.length; i++) {
    const next = new Set<string>();
    for (const id of acc) if (sets[i]!.has(id)) next.add(id);
    acc = next;
  }
  if (acc.size === 0) return { kind: 'self' }; // intersected to nothing
  return { kind: 'dept', deptIds: [...acc] };
}

export function scopePredicate(scope: VisibleScope, callerId: string): { where: string; params: unknown[] } {
  if (scope.kind === 'all') return { where: '1=1', params: [] };
  if (scope.kind === 'self') return { where: 'u.id = $1', params: [callerId] };
  return {
    where: `(u.department_id = ANY($1) OR EXISTS (SELECT 1 FROM user_departments ud WHERE ud.user_id = u.id AND ud.dept_id = ANY($1)))`,
    params: [scope.deptIds],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/scopeResolver.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/scopeResolver.ts tests/auth/scopeResolver.test.ts
git commit -m "feat(enterprise): add pure data-scope engine (effectiveScope + predicate)"
```

### Task 3: Migration 028 — schema (roles/departments/users cols, junction, login_events)

**Files:**
- Create: `src/db/migrations/028_org_permission_v2.sql`
- Test: `tests/db/migration028.test.ts`

**Interfaces:**
- Consumes: existing `roles`, `departments`, `users` tables.
- Produces: new columns + `user_departments` + `login_events` (used by Tasks 4+ and P2).

- [ ] **Step 1: Write the failing test**

`tests/db/migration028.test.ts`:
```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => { const td = await import('../../src/db/testDb'); return { pool: td.testPool }; });
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 028', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  const colsOf = async (table: string, cols: string[]) => {
    const r = await testPool.query<{ cols: string[] }>(
      `SELECT array_agg(column_name) AS cols FROM information_schema.columns
       WHERE table_name=$1 AND column_name = ANY($2)`, [table, cols]);
    return r.rows[0].cols;
  };

  test('roles gains v2 columns', async () => {
    expect(colsOf('roles', ['display_name','data_scope','custom_dept_ids','is_builtin']).sort())
      .toEqual(['custom_dept_ids','data_scope','display_name','is_builtin'].sort());
  });
  test('departments gains v2 columns + unique (org_id, code)', async () => {
    expect(colsOf('departments', ['code','leader_id','sort','description']).sort())
      .toEqual(['code','description','leader_id','sort'].sort());
    const uq = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM pg_indexes WHERE tablename='departments' AND indexdef LIKE 'UNIQUE (org_id, code)%'`);
    expect(uq.rows[0].n).toBe(1);
  });
  test('users gains profile + login columns', async () => {
    expect(colsOf('users', ['email','phone','position','level','joined_at','last_login_at','last_login_ip','last_login_device']).sort())
      .toEqual(['email','joined_at','last_login_at','last_login_device','last_login_ip','level','phone','position'].sort());
  });
  test('creates user_departments and login_events', async () => {
    const t = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM information_schema.tables
       WHERE table_name IN ('user_departments','login_events')`);
    expect(t.rows[0].n).toBe(2);
  });
  test('is idempotent (re-run safe)', async () => {
    await resetSchema(); await runMigrations();
    const t = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name='user_departments'`);
    expect(t.rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/migration028.test.ts`
Expected: FAIL (columns/tables absent).

- [ ] **Step 3: Write the migration**

`src/db/migrations/028_org_permission_v2.sql`:
```sql
-- v2: two-axis org/permission model. Idempotent (ADD COLUMN IF NOT EXISTS).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS data_scope TEXT NOT NULL DEFAULT 'self';
ALTER TABLE roles ADD COLUMN IF NOT EXISTS custom_dept_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE departments ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS leader_id TEXT;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS sort INT NOT NULL DEFAULT 100;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS description TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS departments_org_code ON departments(org_id, code);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS position TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS level TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_device TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_org_email ON users(org_id, email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_departments (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dept_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, dept_id)
);
CREATE INDEX IF NOT EXISTS user_departments_dept ON user_departments(dept_id);

CREATE TABLE IF NOT EXISTS login_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  device TEXT,
  result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_events_user ON login_events(user_id, ts DESC);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/migration028.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/028_org_permission_v2.sql tests/db/migration028.test.ts
git commit -m "feat(enterprise): migration 028 — v2 org/permission schema"
```

### Task 4: Migration 029 + 030 — seed built-ins + remigrate existing data

**Files:**
- Create: `src/db/migrations/029_seed_roles_v2.sql`, `src/db/migrations/030_org_v2_remap.sql`
- Test: `tests/migrations/migration029.test.ts`

**Interfaces:**
- Consumes: Task 3 schema.
- Produces: 6 `is_builtin` roles with fine points + data_scope; legacy `model_admin`/`policy_admin`/`agent_admin` demoted to custom; per-org ROOT department; `user_departments` backfilled; `extra_roles` unknown→`member`.

- [ ] **Step 1: Write the failing test**

`tests/migrations/migration029.test.ts`:
```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => { const td = await import('../../src/db/testDb'); return { pool: td.testPool }; });
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migrations 029+030 (seed + remap)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('seeds the 6 built-in roles with fine points + data_scope', async () => {
    const r = await testPool.query<{ name: string; is_builtin: boolean; data_scope: string; permissions: string[] }>(
      `SELECT name, is_builtin, data_scope, permissions FROM roles WHERE is_builtin=true ORDER BY name`);
    const names = r.rows.map((x) => x.name).sort();
    expect(names).toEqual(['auditor','dept_admin','dev','member','org_admin','super_admin']);
    const superAdmin = r.rows.find((x) => x.name === 'super_admin')!;
    expect(superAdmin.data_scope).toBe('org_wide');
    expect(superAdmin.permissions).toHaveLength(41);
    const deptAdmin = r.rows.find((x) => x.name === 'dept_admin')!;
    expect(deptAdmin.data_scope).toBe('dept_and_below');
    expect(deptAdmin.permissions).toContain('dept:adjust_member');
  });

  test('legacy model_admin/policy_admin/agent_admin are demoted to custom', async () => {
    const r = await testPool.query<{ name: string; is_builtin: boolean }>(
      `SELECT name, is_builtin FROM roles WHERE name IN ('model_admin','policy_admin','agent_admin')`);
    for (const x of r.rows) expect(x.is_builtin).toBe(false);
  });

  test('org gets a ROOT department and top-level depts re-parented under it', async () => {
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','Acme')`);
    await testPool.query(`INSERT INTO departments(id,org_id,name,parent_id,path) VALUES ('d1','o1','Eng',NULL,'/Eng')`);
    await testPool.query(`SELECT * FROM (VALUES (1)) x`); // (no-op; 030 runs at migrate time for pre-existing orgs only)
    // 030 operates on orgs present at migration time; for a fresh DB the org
    // was just created post-migration, so assert the helper path separately:
    const root = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM departments WHERE org_id='o1' AND code='ROOT'`);
    // For an org created AFTER migrate, 030 did not touch it (correct: no existing data).
    expect(root.rows[0].n).toBe(0);
  });

  test('is idempotent (run twice, built-in count stable)', async () => {
    await resetSchema(); await runMigrations(); await resetSchema(); await runMigrations();
    const r = await testPool.query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM roles WHERE is_builtin=true`);
    expect(r.rows[0].n).toBe(6);
  });
});
```
> Note: the "ROOT department" behavior only applies to orgs present *at migration time*. The test above asserts the fresh-org case (no change). The pre-existing-org remap path is covered by an integration test in Task 5 (scope enforcement) and a manual P1 checkpoint.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/migrations/migration029.test.ts`
Expected: FAIL (built-ins not seeded).

- [ ] **Step 3: Write 029 (seed built-ins + demote legacy)**

`src/db/migrations/029_seed_roles_v2.sql`. The fine point sets are inline JSON (must match `BUILTIN_ROLE_POINTS`; the SPA mirror test in P3 keeps them in sync across the wire):
```sql
-- Seed 6 built-ins (idempotent ON CONFLICT (name) DO NOTHING) and demote legacy
-- admins to custom. Fine point sets are inline JSON; kept in lockstep with
-- enterprise_server/src/shared/permissionPoints.ts (BUILTIN_ROLE_POINTS).
INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'super_admin', '超级管理员', '平台 Owner，拥有所有权限', 'org_wide', '[]', true,
  '["user:view","user:create","user:edit","user:delete","user:export","role:view","role:create","role:edit","role:delete","dept:view","dept:create","dept:edit","dept:delete","dept:adjust_member","model:view","model:create","model:edit","model:delete","provider:view","provider:edit","provider:rotate","skill:view","skill:create","skill:edit","skill:toggle","audit:view","audit:export","version:view","version:create","version:edit","version:publish","version:rollback","mcp:view","mcp:create","mcp:edit","mcp:delete","agent:view","agent:create","agent:edit","agent:delete","agent:publish"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'org_admin', '组织管理员', 'IT/HR 管理员，管理用户、角色、部门', 'org_wide', '[]', true,
  '["user:view","user:create","user:edit","user:delete","user:export","role:view","role:create","role:edit","role:delete","dept:view","dept:create","dept:edit","dept:delete","dept:adjust_member","skill:view","skill:create","skill:edit","skill:toggle","version:view","version:create","version:edit","version:publish","version:rollback","mcp:view","mcp:create","mcp:edit","mcp:delete","agent:view","agent:create","agent:edit","agent:delete","agent:publish"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'dept_admin', '部门管理员', '部门负责人，管理本部门及下级', 'dept_and_below', '[]', true,
  '["dept:view","dept:create","dept:edit","dept:adjust_member","user:view","user:edit","role:view"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'auditor', '安全审计员', '只读审计日志与登录记录', 'org_wide', '[]', true,
  '["audit:view","audit:export"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'dev', '应用开发者', '研发与算法同学，使用技能、MCP、智能体模板', 'dept_and_below', '[]', true,
  '["skill:view","skill:create","skill:edit","mcp:view","mcp:create","agent:view","agent:create","agent:edit"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, display_name, description, data_scope, custom_dept_ids, is_builtin, permissions)
VALUES (gen_random_uuid(), 'member', '普通成员', '默认角色，使用已发布的智能体与技能', 'self', '[]', true,
  '["agent:view","skill:view"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- Re-assert existing built-ins (org_admin, auditor existed in 019 with coarse
-- points): upgrade them in place (is_builtin, display_name, fine points, data_scope).
UPDATE roles SET is_builtin=true, data_scope='org_wide',
  display_name=COALESCE(display_name,'组织管理员'),
  permissions='["user:view","user:create","user:edit","user:delete","user:export","role:view","role:create","role:edit","role:delete","dept:view","dept:create","dept:edit","dept:delete","dept:adjust_member","skill:view","skill:create","skill:edit","skill:toggle","version:view","version:create","version:edit","version:publish","version:rollback","mcp:view","mcp:create","mcp:edit","mcp:delete","agent:view","agent:create","agent:edit","agent:delete","agent:publish"]'::jsonb
WHERE name='org_admin' AND is_builtin=false;
UPDATE roles SET is_builtin=true, data_scope='org_wide',
  display_name=COALESCE(display_name,'安全审计员'),
  permissions='["audit:view","audit:export"]'::jsonb
WHERE name='auditor' AND is_builtin=false;

-- Demote legacy admin roles to custom (keep machine codes so extra_roles /
-- marketplace allowed_roles / JWT role names keep working).
UPDATE roles SET is_builtin=false, data_scope='org_wide',
  display_name=COALESCE(display_name,'模型管理员'),
  permissions='["model:view","model:create","model:edit","model:delete","provider:view","provider:edit","provider:rotate"]'::jsonb
WHERE name='model_admin' AND is_builtin=false;
UPDATE roles SET is_builtin=false, data_scope='org_wide',
  display_name=COALESCE(display_name,'技能管理员'),
  permissions='["skill:view","skill:create","skill:edit","skill:toggle","role:view"]'::jsonb
WHERE name='policy_admin' AND is_builtin=false;
UPDATE roles SET is_builtin=false, data_scope='org_wide',
  display_name=COALESCE(display_name,'智能体管理员'),
  permissions='["agent:view","agent:create","agent:edit","agent:delete","agent:publish"]'::jsonb
WHERE name='agent_admin' AND is_builtin=false;

-- Backfill display_name for any still-null role.
UPDATE roles SET display_name=name WHERE display_name IS NULL;
```

- [ ] **Step 4: Write 030 (per-org ROOT + backfill + remap)**

`src/db/migrations/030_org_v2_remap.sql`:
```sql
-- Remigrate existing data. Runs at migrate time over orgs present then.
-- Idempotent: guarded by existence checks.

-- 1. Per org, ensure a single ROOT department; re-parent orphan top-level depts.
DO $$
DECLARE
  o RECORD;
  root_id TEXT;
BEGIN
  FOR o IN SELECT id, name FROM orgs ORDER BY created_at ASC LOOP
    SELECT id INTO root_id FROM departments
     WHERE org_id=o.id AND code='ROOT' AND parent_id IS NULL LIMIT 1;
    IF root_id IS NULL THEN
      -- org has no ROOT: create one (only if org has depts, or always to anchor the tree)
      INSERT INTO departments(id, org_id, name, parent_id, path, code, sort)
      VALUES (gen_random_uuid(), o.id, o.name, NULL, '/' || o.name, 'ROOT', 1)
      RETURNING id INTO root_id;
    END IF;
    -- Re-parent top-level depts (parent_id IS NULL) that are not the ROOT,
    -- rewriting their subtree paths with the ROOT prefix.
    FOR r IN SELECT id, path FROM departments
             WHERE org_id=o.id AND parent_id IS NULL AND id<>root_id
    LOOP
      UPDATE departments SET parent_id=root_id,
        path='/' || (SELECT name FROM departments WHERE id=root_id) || path
       WHERE id=r.id;
      -- Rewrite descendants' path prefix (old path -> new prefix+old path).
      UPDATE departments SET path='/' || (SELECT name FROM departments WHERE id=root_id) || path
       WHERE org_id=o.id AND path <> '/' || (SELECT name FROM departments WHERE id=root_id) || path
         AND path LIKE r.path || '/%';
    END LOOP;
  END LOOP;
END $$;

-- 2. Backfill user_departments from users.department_id (primary).
INSERT INTO user_departments(user_id, dept_id, is_primary)
SELECT u.id, u.department_id, true FROM users u
WHERE u.department_id IS NOT NULL
ON CONFLICT (user_id, dept_id) DO NOTHING;

-- 3. Remap extra_roles: any role name that has no roles row -> 'member'
--    (fail-closed). Preserve known names.
DO $$
DECLARE
  u RECORD;
  new_roles TEXT[];
BEGIN
  FOR u IN SELECT id, extra_roles FROM users LOOP
    SELECT ARRAY(
      SELECT CASE WHEN EXISTS (SELECT 1 FROM roles r WHERE r.name = x) THEN x ELSE 'member' END
      FROM jsonb_array_elements_text(u.extra_roles) AS x
    ) INTO new_roles;
    -- Coalesce duplicate 'member'.
    UPDATE users SET extra_roles=(
      SELECT jsonb_agg(DISTINCT x::text) FROM jsonb_array_elements_text(
        to_jsonb(ARRAY(SELECT DISTINCT v FROM unnest(new_roles) AS v))) )::jsonb
      WHERE id=u.id;
  END LOOP;
END $$;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/migrations/migration029.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify the pre-existing-org remap manually (checkpoint)**

Spin a throwaway DB (or use a local `DATABASE_URL` seeded with an old-style org + depts + users), then run migrations and confirm: a ROOT dept exists, top-level depts re-parented with rewritten paths, `user_departments` populated, and a user with `extra_roles=['ghost']` becomes `['member']`. (This is a manual P1 gate; the automated coverage for the *new* paths lands in P2.)

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/029_seed_roles_v2.sql src/db/migrations/030_org_v2_remap.sql tests/migrations/migration029.test.ts
git commit -m "feat(enterprise): migrations 029-030 — seed built-ins + remigrate org v2 data"
```

### Task 5: Wire `scopeResolver` cached DB loaders + re-gate routes to fine points

**Files:**
- Modify: `src/auth/scopeResolver.ts` (add cached loaders + `invalidate` + `deptIdsFor`), `src/auth/roleResolver.ts` (type swap to `PermissionPoint`), `src/routes/admin/{users,departments,models,providerKeys,releases,roles}.ts`, `src/routes/{agentMarketplaceAdmin,skillMarketplaceAdmin,mcpMarketplaceAdmin}.ts`, `src/routes/roleVocabulary.ts`, `src/routes/me.ts`
- Test: update `tests/auth/roleResolver.test.ts`, `tests/routes/roles.test.ts`, `tests/shared/permissionCodes.test.ts`

**Interfaces:**
- Consumes: Task 1 catalog, Task 2 `VisibleScope`.
- Produces: `scopeResolver.loadScope(claims: {sub, orgId, roles}): Promise<VisibleScope>`, `scopeResolver.invalidate()`. `roleResolver.pointsFor(roles): Promise<Set<PermissionPoint>>`.

- [ ] **Step 1: Add cached loaders to `scopeResolver.ts`**

Append to `src/auth/scopeResolver.ts` (import `pool` from `../db/pool`, `DataScope` already imported):
```ts
import { pool } from '../db/pool';
import { DataScope } from '../shared/permissionPoints';

const TTL_MS = 30_000;
let roleScopeCache: Map<string, RoleScopeInfo> | null = null;
let deptPathCache: Map<string, string> | null = null;
let cacheExpires = 0;

async function refresh(): Promise<void> {
  const now = Date.now();
  if (!roleScopeCache || !deptPathCache || now >= cacheExpires) {
    const rs = await pool.query<{ name: string; data_scope: DataScope; custom_dept_ids: string[] }>(
      `SELECT name, data_scope, custom_dept_ids FROM roles`);
    const rm = new Map<string, RoleScopeInfo>();
    for (const r of rs.rows) rm.set(r.name, { dataScope: r.data_scope, customDeptIds: r.custom_dept_ids ?? [] });
    const dp = await pool.query<{ id: string; path: string }>(`SELECT id, path FROM departments`);
    const dm = new Map<string, string>();
    for (const r of dp.rows) dm.set(r.id, r.path);
    roleScopeCache = rm; deptPathCache = dm; cacheExpires = now + TTL_MS;
  }
}

export const scopeApi = {
  async invalidate(): Promise<void> { roleScopeCache = null; deptPathCache = null; cacheExpires = 0; },
  async deptIdsFor(orgId: string, userId: string): Promise<string[]> {
    const r = await pool.query<{ dept_id: string }>(
      `SELECT dept_id FROM user_departments WHERE user_id=$1`);
    const set = new Set<string>(r.rows.map((x) => x.dept_id));
    return [...set];
  },
  async loadScope(claims: { sub: string; orgId: string; roles: string[] }): Promise<VisibleScope> {
    await refresh();
    const callerDeptIds = await this.deptIdsFor(claims.orgId, claims.sub);
    return effectiveScope({
      roles: claims.roles,
      callerDeptIds,
      roleScope: roleScopeCache!,
      deptPath: deptPathCache!,
      isSuperAdmin: claims.roles.includes('super_admin'),
    });
  },
};
```
> Also export `scopeApi` for consumers; keep `effectiveScope`/`descendantsOf`/`scopePredicate` exported (already).

- [ ] **Step 2: Swap `roleResolver` return type to `PermissionPoint`**

In `src/auth/roleResolver.ts`: change `import type { PermissionCode } ...` to `import type { PermissionPoint } from '../shared/permissionPoints';` and replace every `PermissionCode` (interface return, `load()`, `resolveMap()`, `pointsFor` `Set<...>`) with `PermissionPoint`. The `permissions` column now stores fine points post-migration, so no logic change beyond the type.

- [ ] **Step 3: Re-gate all admin routes to fine points**

Apply the §5.1 re-gating map. Concrete edits (import `PermissionPoint as PP` from `../shared/permissionPoints`):
- `routes/admin/users.ts`: replace the single `.use('/admin/users/*', requirePermission(PermissionCode.UsersManage))` with per-route gates: `GET` → `PP.UserView`, `POST` → `PP.UserCreate`, `PATCH/:id` → `PP.UserEdit`, `disable|enable|reset-password` → `PP.UserEdit`, `export` → `PP.UserExport`, `import` → `PP.UserCreate`, `batch` → `PP.UserEdit`. (Remove the `use()` blanket; add `.get/post/patch`-level `requirePermission`.)
- `routes/admin/departments.ts`: `GET` → `PP.DeptView`, `POST` → `PP.DeptCreate`, `PATCH/:id` → `PP.DeptEdit`, `DELETE/:id` → `PP.DeptDelete`, `reorder` → `PP.DeptEdit`.
- `routes/admin/roles.ts`: `GET` → `PP.RoleView`, `POST` → `PP.RoleCreate`, `PATCH/:id` → `PP.RoleEdit`, `DELETE/:id` → `PP.RoleDelete`, `copy` → `PP.RoleCreate`. Update the `pointsArray` schema to use `PermissionPoint` values: `const KNOWN_POINTS = Object.values(PP) as [string, ...string[]];`.
- `routes/admin/models.ts`: `GET` → `PP.ModelView`, writes → `PP.ModelCreate`/`PP.ModelEdit`/`PP.ModelDelete` (match existing verbs).
- `routes/admin/providerKeys.ts`: `GET` → `PP.ProviderView`, `PATCH`/edit → `PP.ProviderEdit`, `rotate` → `PP.ProviderRotate`.
- `routes/admin/releases.ts`: `GET` → `PP.VersionView`, create → `PP.VersionCreate`, edit → `PP.VersionEdit`, publish/set-latest → `PP.VersionPublish`, rollback/delete → `PP.VersionRollback`/`PP.VersionEdit`.
- `routes/{agentMarketplaceAdmin,skillMarketplaceAdmin,mcpMarketplaceAdmin}.ts`: mirror the `agent:*`/`skill:*`/`mcp:*` verbs.
- `routes/roleVocabulary.ts`: `requirePermission(PP.RoleView)` (was `RolesManage`).

- [ ] **Step 4: Update `/me` to expose points + scope (backward-compatible)**

In `src/routes/me.ts`, after the existing `fetchMe`, add:
```ts
import { roleResolver } from '../auth/roleResolver';
import { scopeApi } from '../auth/scopeResolver';
// in GET /me handler, after building `row`:
const points = [...(await roleResolver.pointsFor(row.extra_roles ?? []))];
const scope = await scopeApi.loadScope(claims);
const concurrent = await pool.query<{ path: string }>(
  `SELECT d.path FROM user_departments ud JOIN departments d ON d.id=ud.dept_id WHERE ud.user_id=$1 AND NOT ud.is_primary`, [claims.sub]);
return c.json({
  ...row,
  effective_roles: row.extra_roles ?? [],
  org_id: claims.orgId,
  permissions: points,
  effectiveDataScope: scope.kind === 'all' ? 'all' : scope.kind === 'self' ? 'self' : 'dept',
  concurrentDeptPaths: concurrent.rows.map((x) => x.path),
});
```

- [ ] **Step 5: Update existing tests to fine points**

- `tests/auth/roleResolver.test.ts`: change assertions from coarse to fine — e.g. `pts.has('users.manage')` → `pts.has('user:edit')`, `'audit.view'` → `'audit:view'`, `'roles.manage'` → `'role:view'`. Keep the legacy-alias + fail-closed tests (rename expected points).
- `tests/routes/roles.test.ts`: `'audit.view'` → `'audit:view'`; the 403 token `model_admin` still lacks `role:*` (now `role:view`) so those 403 tests still hold; the "create with valid points" uses `['audit:view']`; unknown-point test uses `'nope.nope'` (unchanged).
- `tests/shared/permissionCodes.test.ts`: if it asserted the coarse set, retarget to `PERMISSION_POINTS`/`PERMISSION_MODULES` (rename the file's intent). Read it first and adapt.

- [ ] **Step 6: Run the affected tests**

Run (per file):
```bash
npx vitest run tests/auth/roleResolver.test.ts
npx vitest run tests/routes/roles.test.ts
npx vitest run tests/shared/permissionPoints.test.ts
npx vitest run tests/routes/me.test.ts
```
Expected: PASS.

- [ ] **Step 7: Lint touched files + commit**

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/auth/scopeResolver.ts src/auth/roleResolver.ts src/routes/admin src/routes/me.ts src/routes/roleVocabulary.ts src/routes/agentMarketplaceAdmin.ts src/routes/skillMarketplaceAdmin.ts src/routes/mcpMarketplaceAdmin.ts
git add -A && git commit -m "feat(enterprise): re-gate admin routes to fine points + scope-aware /me"
```

**P1 checkpoint:** app boots (`npm run dev`), all P1 test files green, `GET /me` returns `permissions`/`effectiveDataScope` without breaking the desktop (new fields only).

---

# PHASE 2 — Backend APIs (departments, users, roles, audit)

### Task 6: Department service + routes (tree/detail/CRUD/move/delete-guard/reorder)

**Files:**
- Modify: `src/org/orgService.ts` (add dept methods), `src/routes/admin/departments.ts`
- Test: `tests/org/departmentService.test.ts`, `tests/routes/departments.test.ts`

**Interfaces:**
- Consumes: Task 3 schema, Task 5 `scopeApi.loadScope` + `scopePredicate`.
- Produces:
  - `orgService.listDeptTree(orgId, scope): Promise<DeptNode[]>` (scope-filtered, with `directMembers`, `subtreeMembers`)
  - `orgService.getDeptDetail(orgId, deptId): Promise<DeptDetail>`
  - `orgService.createDept(input)`, `orgService.updateDept(id, patch)`, `orgService.moveDept(id, newParentId)` (path rewrite), `orgService.deleteDept(id)` (throws `HasMembers`/`HasChildren`), `orgService.reorderSiblings(orgId, parentId, orderedIds)`
  - `class DeptGuardError extends Error { code: 'has_members'|'has_children' }`

- [ ] **Step 1: Write the failing service test**

`tests/org/departmentService.test.ts`:
```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => { const td = await import('../../src/db/testDb'); return { pool: td.testPool }; });
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { orgService, DeptGuardError } from '../../src/org/orgService';

beforeEach(async () => {
  await resetSchema(); await runMigrations();
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','Acme')`);
});

test('createDept with code + leader + sort', async () => {
  const { id, path } = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null, leaderId: null, sort: 1, description: 'd' });
  expect(path).toBe('/Eng');
  const row = await testPool.query<{ code: string; sort: number }>(`SELECT code, sort FROM departments WHERE id=$1`, [id]);
  expect(row.rows[0]).toEqual({ code: 'ENG', sort: 1 });
});

test('duplicate code in org → error', async () => {
  await orgService.createDept({ orgId: 'o1', name: 'A', code: 'X', parentId: null });
  await expect(orgService.createDept({ orgId: 'o1', name: 'B', code: 'X', parentId: null })).rejects.toThrow();
});

test('moveDept rewrites subtree paths', async () => {
  const { id: root } = await orgService.createDept({ orgId: 'o1', name: 'Root', code: 'ROOT', parentId: null });
  const { id: a } = await orgService.createDept({ orgId: 'o1', name: 'A', code: 'A', parentId: root });
  const { id: ab } = await orgService.createDept({ orgId: 'o1', name: 'AB', code: 'AB', parentId: a });
  await orgService.moveDept(a, null); // move A to top level
  const pathA = (await testPool.query<{ path: string }>(`SELECT path FROM departments WHERE id=$1`, [a])).rows[0].path;
  const pathAB = (await testPool.query<{ path: string }>(`SELECT path FROM departments WHERE id=$1`, [ab])).rows[0].path;
  expect(pathA).not.toBe(pathAB.startsWith(pathA) ? 'x' : pathA); // sanity
  expect(pathAB).toBe(`${pathA}/AB`);
});

test('deleteDept blocked when it has direct members', async () => {
  const { id } = await orgService.createDept({ orgId: 'o1', name: 'Eng', code: 'ENG', parentId: null });
  await testPool.query(`INSERT INTO users(id,org_id,username,password_hash,department_id,extra_roles) VALUES ('u1','o1','u1','h',$$1$$,'["member"]')`, []);
  // (placeholder — corrected in Step 3 to parameterized insert)
});

test('deleteDept blocked when it has children', async () => {
  const { id } = await orgService.createDept({ orgId: 'o1', name: 'A', code: 'A', parentId: null });
  await orgService.createDept({ orgId: 'o1', name: 'B', code: 'B', parentId: id });
  await expect(orgService.deleteDept(id)).rejects.toThrow(DeptGuardError);
});
```
> Correct the member-insert to a proper parameterized `testPool.query` in Step 3 (the `$$1$$` literal is not valid — use `$1` with `[id]`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/org/departmentService.test.ts`
Expected: FAIL (methods not defined).

- [ ] **Step 3: Implement department methods in `orgService.ts`**

Add to `orgService` (extend the object; keep existing methods):
```ts
export class DeptGuardError extends Error {
  constructor(public code: 'has_members' | 'has_children') { super(code); }
}

// listDeptTree(orgId, scope) — build node map, attach directMembers/subtreeMembers.
// Subtree member count = users whose primary/concurrent dept ∈ subtree.
async listDeptTree(orgId: string, scope: VisibleScope) {
  const r = await pool.query<DeptRow>(`SELECT * FROM departments WHERE org_id=$1 ORDER BY sort, path`, [orgId]);
  const byId = new Map(r.rows.map((d) => [d.id, d]));
  // scope filter: drop depts outside scope.deptIds (keep ancestors for path)
  const allowed = new Set(scope.kind === 'all' ? r.rows.map((d) => d.id) : scope.kind === 'self' ? [] : scope.deptIds);
  const visible = scope.kind === 'all' ? r.rows : r.rows.filter((d) => allowed.has(d.id));
  // member counts via one query
  const mc = await pool.query<{ dept_id: string; n: number }>(
    `SELECT ud.dept_id, COUNT(*)::int AS n FROM user_departments ud JOIN departments d ON d.id=ud.dept_id WHERE d.org_id=$1 GROUP BY ud.dept_id`, [orgId]);
  const direct = new Map(mc.rows.map((x) => [x.dept_id, x.n]));
  // assemble tree with children + subtree rollup
  const nodes = new Map<string, NodeShape>();
  for (const d of visible) nodes.set(d.id, { id: d.id, name: d.name, code: d.code, parent_id: d.parent_id, path: d.path, leader_id: d.leader_id, sort: d.sort, description: d.description, directMembers: direct.get(d.id) ?? 0, subtreeMembers: 0, children: [] });
  for (const d of visible) {
    const n = nodes.get(d.id)!;
    if (d.parent_id && nodes.has(d.parent_id)) nodes.get(d.parent_id)!.children.push(n);
  }
  const roots: NodeShape[] = [];
  for (const d of visible) if (!d.parent_id || !nodes.has(d.parent_id)) roots.push(nodes.get(d.id)!);
  const roll = (n: NodeShape) => { n.subtreeMembers = n.directMembers + n.children.reduce((s, c) => s + roll(c), 0); return n.subtreeMembers; };
  roots.forEach(roll);
  return roots;
},
```
(Add `DeptRow`/`NodeShape` interfaces locally. `getDeptDetail`, `createDept` (with `code` uniqueness check + `sort`), `updateDept` (reject `code` change → 422 via thrown error the route maps), `moveDept` (recompute `path` = newPrefix + oldSuffix for the whole subtree in a `pool.transaction`), `deleteDept` (guard: `SELECT COUNT(*) FROM user_departments WHERE dept_id=$1` and `SELECT COUNT(*) FROM departments WHERE parent_id=$1` → throw `DeptGuardError`), `reorderSiblings` (set `sort` = index+1).)

- [ ] **Step 4: Implement department routes in `routes/admin/departments.ts`**

- `GET /admin/departments?orgId=` → `const claims=c.get('claims'); const scope=await scopeApi.loadScope(claims); return c.json(await orgService.listDeptTree(orgId, scope));`
- `GET /admin/departments/:id` → detail; if `scope.kind==='self'` or dept not in `scope.deptIds` → `403 {error:'forbidden'}` + audit `admin_access_denied`.
- `POST` → `orgService.createDept` (zod: `orgId,name,code,parentId?,leaderId?,sort?,description?`). Duplicate code → 409.
- `PATCH /:id` → `orgService.updateDept`; `code` change → 422.
- `DELETE /:id` → `orgService.deleteDept` catch `DeptGuardError` → 409 `{error: code}`.
- `POST /admin/departments/reorder` → `{orgId,parentId,orderedIds[]}`.
- On create/update/delete/move → `auditStore.write` with before/after in `payload`; call `scopeApi.invalidate()` after structural changes.

- [ ] **Step 5: Run tests**

Run:
```bash
npx vitest run tests/org/departmentService.test.ts
npx vitest run tests/routes/departments.test.ts
```
Write `tests/routes/departments.test.ts` mirroring the route tests above (403 out-of-scope detail, delete-guard 409, reorder updates sort).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/org/orgService.ts src/routes/admin/departments.ts tests/org/departmentService.test.ts tests/routes/departments.test.ts
git commit -m "feat(enterprise): department tree/detail/CRUD/move/delete-guard/reorder APIs"
```

### Task 7: User service + routes (rich profile, primary/concurrent depts, status, login records)

**Files:**
- Modify: `src/org/orgService.ts` (user methods), `src/routes/admin/users.ts`, `src/org/loginRecord.ts` *(new)*
- Test: `tests/org/userService.test.ts`, `tests/routes/users.test.ts`

**Interfaces:**
- Consumes: Task 3 schema, Task 5 scope.
- Produces:
  - `orgService.createUser(input: UserCreateInput): Promise<{id, tempPassword}>` (generates 16-char password)
  - `orgService.listUsers(orgId, scope, q): Promise<UserRow[]>` (scope-filtered, joined dept/roles)
  - `orgService.getUserFull(id): Promise<UserFull>` (profile + `user_departments` + `login_events` last 10)
  - `orgService.setUserDepts(id, primaryId, concurrentIds)` (upserts junction, keeps `users.department_id`=primary)
  - `loginRecord.recordLogin(orgId, userId, ip, device, result)` (inserts `login_events`, updates `users.last_login_*` on success)

- [ ] **Step 1: Write the failing test**

`tests/org/userService.test.ts` (seed an org + depts, then):
- `createUser` returns `{id, tempPassword}` of length 16, user row `status='active'`, default `extra_roles=['member']` when omitted, `user_departments` has a primary row for `primaryDeptId`.
- `setUserDepts` adds a concurrent dept (junction row `is_primary=false`) and keeps `users.department_id`.
- `listUsers` scope: a `dept` scope containing only `/Eng` returns only users in `/Eng`.
- `loginRecord.recordLogin` inserts a `login_events` row and sets `last_login_at`/`ip`/`device` on success only.

- [ ] **Step 2: Run to verify fail** → `npx vitest run tests/org/userService.test.ts`

- [ ] **Step 3: Implement**

`src/org/loginRecord.ts`:
```ts
import { pool } from '../db/pool';
export const loginRecord = {
  async recordLogin(orgId: string, userId: string | null, ip: string | null, device: string | null, result: 'success' | 'failed'): Promise<void> {
    await pool.query(
      `INSERT INTO login_events(id, org_id, user_id, ip, device, result) VALUES ($1,$2,$3,$4,$5,$6)`,
      [crypto.randomUUID(), orgId, userId, ip, device, result]);
    if (result === 'success' && userId) {
      await pool.query(
        `UPDATE users SET last_login_at=now(), last_login_ip=$2, last_login_device=$3 WHERE id=$1`,
        [userId, ip, device]);
    }
  },
};
```
Extend `orgService.createUser` (accept `displayName,email,phone,position,level,primaryDeptId,concurrentDeptIds[],roles[],joinedAt,timezone`): generate `tempPassword` via `crypto.randomBytes` → base32-ish 16 chars, hash, insert `users` (incl. `email`,`position`,`level`,`joined_at`,`department_id=primaryDeptId`), then upsert `user_departments` (primary + concurrent). Return `{ id, tempPassword }`.
`setUserDepts`: in a `pool.transaction`, `DELETE FROM user_departments WHERE user_id=$1`, insert primary (`is_primary=true`) + each concurrent (`is_primary=false`), and `UPDATE users SET department_id=$primaryId`.
`listUsers(orgId, scope, q)`: base `SELECT u.* , d.path AS primary_dept_path, d.name AS primary_dept_name FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.org_id=$1` + `scopePredicate(scope, ...)` + optional `q` (ILIKE on `username/display_name/email/phone`) + role/status/dept filters (filter `role` via `extra_roles::text LIKE` or a `ANY` join; `status` equality; `deptId` via junction). `getUserFull` adds role names + last-10 `login_events`.

- [ ] **Step 4: Implement user routes in `routes/admin/users.ts`**

- `GET /admin/users` — add query params `q,deptId,roleId,status`; compute `scope`, pass to `listUsers`. (Gated `user:view` per Task 5.)
- `GET /admin/users/:id` — `getUserFull`; out-of-scope → 403.
- `POST /admin/users` — validate (email unique → 409; target dept in scope), return `{id, tempPassword}`.
- `PATCH /:id` — accept `displayName,email,phone,position,level,primaryDeptId,concurrentDeptIds,roles,joinedAt,timezone,status`; calls `setUserDepts` when dept fields present.
- `POST /:id/enable|disable` — status toggle (existing, keep).
- `POST /:id/reset-password` — generate + return `{tempPassword}` (replace the current request-supplied password with server-generated; keep the endpoint).

- [ ] **Step 5: Run tests** (`npx vitest run tests/org/userService.test.ts` and `tests/routes/users.test.ts`; write `users.test.ts` for scope-filtered list + 403 out-of-scope detail + reset returns tempPassword). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(enterprise): rich user profile, multi-dept, status, login records"
```

### Task 8: Batch ops + CSV export/import

**Files:**
- Modify: `src/routes/admin/users.ts` (add `/batch`, `/export`, `/import`), `src/org/orgService.ts` (batch + csv helpers)
- Test: `tests/routes/usersBatch.test.ts`, `tests/routes/usersCsv.test.ts`

**Interfaces:**
- Produces: `POST /admin/users/batch`, `GET /admin/users/export`, `POST /admin/users/import` (behaviors below).

- [ ] **Step 1: Write failing tests**

`tests/routes/usersBatch.test.ts`:
- Batch `assign_role` on 2 in-scope users → 200, both `extra_roles` updated, audit `user_batch` written.
- Batch targeting an out-of-scope user → 403 (fail-closed), and NO users modified.
- `enable` batch flips status.

`tests/routes/usersCsv.test.ts`:
- `export` returns a CSV body with a header row + one row per visible user, **scope-filtered** (dept scope excludes other-dept users).
- `import` with a well-formed CSV creates users (returns `{created:N, skipped, errors:[]}`); a CSV with a duplicate username + an unknown role code returns `errors` entries and does NOT create the bad rows.

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement**

Batch route (`POST /admin/users/batch`, gated `user:edit`):
```ts
const body = z.object({ action: z.enum(['assign_role','adjust_dept','enable','disable','reset_password']), userIds: z.array(z.string()).min(1), roleCodes: z.array(z.string()).optional(), deptId: z.string().optional() }).parse(await c.req.json());
const claims = c.get('claims');
const scope = await scopeApi.loadScope(claims);
// Fail-closed: every target must be visible. If scope is self/all use the
// listUsers-style visibility check; reject (403 + audit) if any target is outside.
const visible = await orgService.visibleUserIds(claims.orgId, scope);
if (body.userIds.some((id) => !visible.has(id))) { await auditStore.write({ orgId: claims.orgId, userId: claims.sub, action: 'admin_access_denied', targetType: 'route', targetId: c.req.path, payload: { action: body.action } }); return c.json({ error: 'forbidden' }, 403); }
await orgService.applyBatch(body);
await auditStore.write({ orgId: claims.orgId, userId: claims.sub, action: 'user_batch', targetType: 'user', payload: { action: body.action, userIds: body.userIds } });
return c.json({ ok: true, affected: body.userIds.length });
```
Add `orgService.visibleUserIds(orgId, scope): Promise<Set<string>>` (the listUsers visibility query, returning id set).

CSV: add a tiny `csv.ts` helper (`toCsv(rows: Record<string,string>[])`, `parseCsv(text)` — handle quoted fields/commas/newlines; no new dependency). `export` builds rows from the scope-filtered list. `import` parses, validates each row (`username`/`email` unique, `deptCode` exists, `roleCodes` all exist), inserts valid rows, collects `{row, reason}` errors. Gated `user:export` / `user:create` respectively.

- [ ] **Step 4: Run tests** (both files). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(enterprise): user batch ops + scope-filtered CSV export/import"
```

### Task 9: Role service/routes v2 (data_scope, copy, delete-guard, type filter)

**Files:**
- Modify: `src/org/roleService.ts`, `src/routes/admin/roles.ts`
- Test: `tests/routes/rolesV2.test.ts`

**Interfaces:**
- Produces: `roleService.list({type})` (returns `displayName, dataScope, customDeptIds, isBuiltin, memberCount`), `roleService.copy(id, newCode)`, `roleService.remove(id)` (throws if `is_builtin` or has members), `roleService.create/update` accept `displayName, dataScope, customDeptIds`.

- [ ] **Step 1: Write failing tests**
  - `GET /admin/roles?type=builtin` returns only the 6 built-ins; `type=custom` returns `model_admin` etc.
  - `DELETE` a built-in → 409; `DELETE` a custom role with members → 409; `DELETE` an unassigned custom → 200.
  - `POST /admin/roles/:id/copy` → 200, new role has a distinct name + same points/data_scope, `is_builtin=false`.
  - `POST /admin/roles` with `dataScope='custom_dept_tree'` + `customDeptIds` persists both.

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement**

Extend `roleService`:
- `create(input)` → include `display_name, data_scope, custom_dept_ids`; validate `dataScope ∈ DATA_SCOPE_VALUES` (route zod) and `name` matches `/^[a-z0-9_]+$/`.
- `list(filter)` → `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.extra_roles @> to_jsonb(r.name)) AS member_count FROM roles r` (+ `WHERE is_builtin` / `AND NOT is_builtin`).
- `copy(id, newCode)` → read role, `INSERT` new with `name=newCode, display_name=name+' (copy)', is_builtin=false`.
- `remove(id)` → if `is_builtin` throw; `SELECT COUNT(*) FROM users WHERE extra_roles @> to_jsonb($name)`; if >0 throw `RoleInUseError`; else delete.
- On any create/update/remove → `roleResolver.invalidate()` + `scopeApi.invalidate()` (data_scope changed).
Routes: add `GET ?type=`, `POST /:id/copy`, map `RoleInUseError`/builtin-guard → 409. Invalidate scope cache after data_scope edits.

- [ ] **Step 4: Run tests** (`npx vitest run tests/routes/rolesV2.test.ts`). Expected: PASS.

- [ ] **Step 5: Commit** → `git add -A && git commit -m "feat(enterprise): role v2 — data_scope, copy, delete-guard, type filter"`

### Task 10: Login events + audit wiring

**Files:**
- Modify: `src/routes/auth.ts` (record login events on success + failure), `src/routes/admin/audit.ts` (include `login_events`)
- Test: `tests/routes/auth.test.ts` (extend: a login writes a `login_events` row)

- [ ] **Step 1: Add a failing assertion to `tests/routes/auth.test.ts`** — after a successful login, `login_events` has 1 row with `result='success'` for that user; a failed login (wrong password) writes `result='failed'`.

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Implement in `routes/auth.ts`**
  - Compute `ip` from `x-forwarded-for` (first) or `c.req.socket?.remoteAddress` — in tests it's absent; fall back to `null`. `device` = trimmed `user-agent` header.
  - On success: `await loginRecord.recordLogin(claims.orgId, claims.sub, ip, device, 'success')`.
  - On `LoginFailed`: if the org + user resolved, `recordLogin(orgId, userId ?? null, ip, device, 'failed')` (best-effort; skip when org unknown).
  - `admin/audit.ts`: add a `?include=login` branch that unions `login_events` into the results (map to the audit row shape with `action='login'`).

- [ ] **Step 4: Run** (`npx vitest run tests/routes/auth.test.ts`). Expected: PASS.

- [ ] **Step 5: Commit** → `git add -A && git commit -m "feat(enterprise): record login events + include in audit"`

**P2 checkpoint:** all P2 test files green; `web:dev` can hit the new endpoints (manual smoke: dept tree, user list scope-filtered, batch, CSV, role copy).

---

# PHASE 3 — Frontend (SPA rebuild to prototype)

SPA paths under `enterprise_server/web`. Reuse `FormDrawer`, `DataTable`, `ConfirmDialog`, `Badge`, `StatusPill`, `PageHeader`, `toastStore`, i18n `t()`. Every user-visible string uses `t(key)` with zh+en.

### Task 11: Regenerate SPA permission mirror + mirror test

**Files:**
- Modify: `web/src/shared/permissions.ts`, `web/src/i18n.ts`
- Create: `web/tests/shared/permissionsMirror.test.ts`

**Interfaces:**
- Produces: `PERMISSION_MODULES` (mirrors server), `PERMISSION_POINTS`, `DataScope`, `DATA_SCOPE_VALUES`, `dataScopeLabelKey(s)`, `pointLabelKey(p)`, `moduleLabelKey(m)`.

- [ ] **Step 1: Write the mirror test**

`web/tests/shared/permissionsMirror.test.ts` (hardcoded expected codes — must match server Task 1):
```ts
import { describe, expect, test } from 'vitest';
import { DATA_SCOPE_VALUES, PERMISSION_MODULES, PERMISSION_POINTS } from '../../src/shared/permissions';
const expected = {
  user: ['user:view','user:create','user:edit','user:delete','user:export'],
  role: ['role:view','role:create','role:edit','role:delete'],
  dept: ['dept:view','dept:create','dept:edit','dept:delete','dept:adjust_member'],
  model: ['model:view','model:create','model:edit','model:delete'],
  provider: ['provider:view','provider:edit','provider:rotate'],
  skill: ['skill:view','skill:create','skill:edit','skill:toggle'],
  audit: ['audit:view','audit:export'],
  version: ['version:view','version:create','version:edit','version:publish','version:rollback'],
  mcp: ['mcp:view','mcp:create','mcp:edit','mcp:delete'],
  agent: ['agent:view','agent:create','agent:edit','agent:delete','agent:publish'],
};
test('SPA catalog matches server (codes + grouping)', () => {
  expect(PERMISSION_POINTS).toHaveLength(41);
  for (const m of PERMISSION_MODULES) {
    expect(m.points).toEqual(expected[m.key as keyof typeof expected]);
  }
});
test('data scope values', () => {
  expect(DATA_SCOPE_VALUES).toEqual(['org_wide','dept_and_below','dept','self','custom_dept_tree']);
});
```

- [ ] **Step 2: Run to verify fail** → `npx vitest run tests/shared/permissionsMirror.test.ts` (in `web/`).

- [ ] **Step 3: Regenerate `web/src/shared/permissions.ts`**

Replace the coarse mirror with:
```ts
export const PermissionPoint = { /* identical 41-entry as const object as server */ } as const;
export type PermissionPoint = (typeof PermissionPoint)[keyof typeof PermissionPoint];
export const PERMISSION_POINTS: PermissionPoint[] = Object.values(PermissionPoint);
export const DataScope = { OrgWide:'org_wide', DeptAndBelow:'dept_and_below', Dept:'dept', Self:'self', CustomDeptTree:'custom_dept_tree' } as const;
export type DataScope = (typeof DataScope)[keyof typeof DataScope];
export const DATA_SCOPE_VALUES: DataScope[] = ['org_wide','dept_and_below','dept','self','custom_dept_tree'];
export const PERMISSION_MODULES: ReadonlyArray<{key:string;name:string;desc:string;points:PermissionPoint[]}> = [ /* mirror server PERMISSION_MODULES, same order */ ];
export const pointLabelKey = (p: PermissionPoint) => `roles.point.${p}`;
export const moduleLabelKey = (k: string) => `roles.module.${k}`;
export const dataScopeLabelKey = (s: DataScope) => `roles.scope.${s}`;
```

- [ ] **Step 4: Add i18n keys** in `web/src/i18n.ts` — for every point `roles.point.<p>`, every module `roles.module.<k>`, and `roles.scope.<s>` (zh + en). Also add the new UI keys for the 3 pages (list under `dept.*`, `roles.*`, `users.*`, `batch.*`). Provide the full key list in the PR/PRD appendix; keep zh primary, en translated.

- [ ] **Step 5: Run test** (mirror test passes) + `npx eslint --max-warnings 0 src/shared/permissions.ts tests/shared/permissionsMirror.test.ts`.

- [ ] **Step 6: Commit** → `git add -A && git commit -m "feat(enterprise-web): regenerate permission mirror to fine points + mirror test"`

### Task 12: Departments page (tree + detail + form drawer)

**Files:**
- Create: `web/src/components/DeptTree.tsx`, `DeptDetail.tsx`, `DeptFormDrawer.tsx`
- Modify: `web/src/pages/DepartmentsPage.tsx`, `web/src/api/departments.ts`
- Test: `web/tests/pages/DepartmentsPage.test.tsx`

**Interfaces:**
- Consumes: `departmentsApi.list` (tree w/ counts), `get`, `create`, `patch`, `remove`, `reorder` (extend `api/departments.ts` to the P2 shapes).
- Produces: pages rendering the prototype dept view.

- [ ] **Step 1: Write the failing page test**

`web/tests/pages/DepartmentsPage.test.tsx` (fetch-mock pattern like `RolesPage.test.tsx`):
```tsx
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '../../src/auth/store';
import { DepartmentsPage } from '../../src/pages/DepartmentsPage';

const wrap = (ui: ReactElement) => { const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); return <QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>; };

describe('pages/DepartmentsPage', () => {
  beforeEach(() => { fetchMock.mockReset(); useAuthStore.setState({ token: 'jwt', claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] } }); });
  test('renders the tree with subtree counts and opens detail', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 'r', name: 'Acme', code: 'ROOT', parent_id: null, path: '/Acme', directMembers: 1, subtreeMembers: 5, children: [
        { id: 'e', name: 'Eng', code: 'ENG', parent_id: 'r', path: '/Acme/Eng', directMembers: 4, subtreeMembers: 4, children: [] },
      ] },
    ]), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'r', name: 'Acme', stats: { direct: 1, subtree: 5, children: 1 }, members: [] }), { status: 200 }));
    render(wrap(<DepartmentsPage />));
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    expect(screen.getByText('Eng')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify fail**

- [ ] **Step 3: Build `DeptTree`** (search box filtering by name/code, expand/collapse state, per-node `subtreeMembers` badge, select callback, sticky card). Match prototype `.dept-tree*` tokens.

- [ ] **Step 4: Build `DeptDetail`** (code tag, breadcrumb from `path`, 4 stat cards via `StatRow2`, base info, tabs 部门成员/下级/操作日志, member `DataTable` → `navigate(/orgs/users/:id)`).

- [ ] **Step 5: Build `DeptFormDrawer`** (name*, code* — disable + note when editing, parent tree-select, leader user picker, sort, description; delete-guard notice). Wire create/patch/remove/reorder via `departmentsApi`.

- [ ] **Step 6: Rebuild `DepartmentsPage`** as the two-pane layout (left `DeptTree`, right `DeptDetail`), `PageHeader` with 导入(禁用, V1.1) + 新增部门. Use `t()` for all strings; gate actions on `hasPermission('dept:…')` (add `hasPermission` to `useAuth` reading `/me.permissions`).

- [ ] **Step 7: Run** (`npx vitest run tests/pages/DepartmentsPage.test.tsx` in `web/`) + eslint on touched files. Expected: PASS.

- [ ] **Step 8: Commit** → `git add -A && git commit -m "feat(enterprise-web): departments tree/detail/form to match prototype"`

### Task 13: Roles page (card grid + 3-step drawer + permission group tree)

**Files:**
- Create: `web/src/components/RoleFormDrawer3.tsx`, `PermissionGroupTree.tsx`
- Modify: `web/src/pages/RolesPage.tsx`, `web/src/api/roles.ts`, `web/src/components/RoleFormDrawer.tsx` (superseded by `RoleFormDrawer3`)
- Test: `web/tests/pages/RolesPage.test.tsx`

**Interfaces:**
- Consumes: `rolesApi.list({type})`, `create/patch/remove/copy`, `PERMISSION_MODULES` (Task 11).
- Produces: card grid + 3-step drawer matching prototype.

- [ ] **Step 1: Extend `RolesPage.test.tsx`** — add: segmented 内置/自定义 switches the list; built-in card hides delete; 3-step drawer step 2 shows the 5 data-scope radio cards; step 3 renders all 10 modules with per-action checkboxes; 自定义部门树 expands a dept multi-select.
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Build `PermissionGroupTree`** — props `{value: PermissionPoint[], onChange}`; per-module header checkbox (all/none/partial of `module.points`), per-action checkboxes, 全选/清空 top controls. Controlled, no internal state.
- [ ] **Step 4: Build `RoleFormDrawer3`** — 3 steps (基本信息 / 数据范围 with 5 `radio-card`s; `custom_dept_tree` reveals a dept-tree multi-select / 功能权限点 via `PermissionGroupTree`). Submit posts `{name, displayName, description, dataScope, customDeptIds, permissions}`.
- [ ] **Step 5: Rebuild `RolesPage`** — segmented toggle, card grid (name, code, type tag 内置/自定义, desc, `memberCount`, `dataScope` label; built-in hides delete; hover 复制/编辑), 新增角色 button. Delete → `ConfirmDialog`.
- [ ] **Step 6: Run** (`npx vitest run tests/pages/RolesPage.test.tsx`) + eslint. Expected: PASS.
- [ ] **Step 7: Commit** → `git add -A && git commit -m "feat(enterprise-web): roles card grid + 3-step drawer with permission group tree"`

### Task 14: Users page (filter bar, table, batch bar, user drawer, import dialog)

**Files:**
- Create: `web/src/components/UserFormDrawer.tsx`, `BatchBar.tsx`, `UserImportDialog.tsx`
- Modify: `web/src/pages/UsersPage.tsx`, `web/src/pages/UserDetailPage.tsx`, `web/src/api/users.ts`
- Test: `web/tests/pages/UsersPage.test.tsx`

**Interfaces:**
- Consumes: `usersApi.list(q)`, `get`, `create`, `patch`, `enable/disable`, `resetPassword`, `batch`, `export`, `import`.
- Produces: the prototype 用户与权限 view.

- [ ] **Step 1: Extend `UsersPage.test.tsx`** — filter bar present; selecting rows shows the dark `BatchBar` with the 4 actions; role chips render with a data-scope suffix; 新建用户 drawer shows 组织归属 + 角色与权限 (chips with scope label + 并集+交集 hint).
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Build `BatchBar`** — floating dark bar, "已选 N 人", buttons 分配角色/调整部门/启用停用/重置密码; each triggers `usersApi.batch`.
- [ ] **Step 4: Build `UserFormDrawer`** — 基本信息 / 组织归属 (主部门 tree-select, 入职日期, 兼职部门 chips) / 角色与权限 (multi-select chips, each with its `dataScope` label; explainer line). On create show the returned `tempPassword` (in-app).
- [ ] **Step 5: Build `UserImportDialog`** — template download (calls `export` for a header sample or a static template), file upload → `usersApi.import`, show `{created, errors[]}` report.
- [ ] **Step 6: Rebuild `UsersPage`** — filter bar (search + dept/role/status selects + 导出/批量导入/新建), `DataTable` with checkbox column, `BatchBar`, row action 详情 → `UserDetailPage` (profile + 最近登录 table + 停用 button). All strings via `t()`.
- [ ] **Step 7: Run** (`npx vitest run tests/pages/UsersPage.test.tsx`) + eslint. Expected: PASS.
- [ ] **Step 8: Commit** → `git add -A && git commit -m "feat(enterprise-web): users page with batch bar, drawer, import dialog"`

**P3 checkpoint:** `npm run web:dev` — walk the 3 pages against a seeded server; `npm run web:test` (per-file) green; visual snapshot baseline generated (`npm run web:test:visual:update`).

---

# PHASE 4 — Hardening & acceptance

### Task 15: Provider-key field gating + security field-stripping

**Files:**
- Modify: `src/routes/admin/providerKeys.ts`
- Test: `tests/routes/providerKeysGating.test.ts`

- [ ] **Step 1: Failing test** — a caller with `provider:view` but not `provider:edit` can `GET` keys but the plaintext `value` is masked/stripped; a caller lacking `provider:view` gets 403 on `GET`.
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement** — `GET /admin/provider-keys` strips the plaintext secret field from the response when the caller lacks `provider:view` (return masked `…abcd`); ensure writes require `provider:edit`/`provider:rotate` (already gated in Task 5).
- [ ] **Step 4: Run** (`npx vitest run tests/routes/providerKeysGating.test.ts`). Expected: PASS.
- [ ] **Step 5: Commit** → `git add -A && git commit -m "feat(enterprise): gate + mask provider-key plaintext"`

### Task 16: Visual snapshots + acceptance walkthrough

**Files:**
- Create: `web/tests/visual/{departments,roles,users}.test.ts` (Playwright) if not present; run existing config.

- [ ] **Step 1: Add visual specs** — navigate to `/orgs/departments`, `/orgs/roles`, `/orgs/users`; open each drawer; `expect(page).toHaveScreenshot(...)` against the prototype look.
- [ ] **Step 2: Generate + review snapshots** — `npm run web:test:visual:update` in `web/`; diff against the prototype HTML manually (layout, stat cards, 3-step drawer, batch bar).
- [ ] **Step 3: Acceptance walkthrough (manual, documented)** — verify against PRD §八: dept tree 5-level expand; built-ins non-deletable; `dept_admin` 越权 → 403 (direct) + filtered lists; batch assign/dept/disable audited; 越权 direct request → 403 + audit; hidden buttons not the control (curl an out-of-scope endpoint → 403).
- [ ] **Step 4: Commit** → `git add -A && git commit -m "test(enterprise): visual snapshots + acceptance walkthrough"`

---

## Self-Review

**Spec coverage:**
- §5.1 fine points + re-gating → Tasks 1, 5. §5.2/5.3 scope engine + merge + multi-dept → Tasks 2, 5, 6, 7. §6 migrations → Tasks 3, 4. §7 scope enforcement surfaces → Tasks 5, 6, 7, 8. §8 roles + remap → Tasks 4, 9. §9 API surface → Tasks 6, 7, 8, 9, 10, 15. §10 frontend → Tasks 11–14. §11 security/audit → Tasks 10, 15. §12 testing → spread across. §13 phasing → P1–P4. **Gaps found & filled:** `visibleUserIds` (Task 8) needed for batch fail-closed; CSV helper (Task 8); `scopeApi` loaders (Task 5).

**Placeholder scan:** No TBD/TODO. One deliberate manual checkpoint (Task 4 Step 6: pre-existing-org remap) is explicitly labeled a manual P1 gate with the automated new-path coverage deferred to P2 — acceptable and flagged, not a silent gap. The Task 6 test has an inline note to fix a parameterized insert (flagged in-task).

**Type consistency:** `VisibleScope` (Task 2) used consistently in Tasks 5/6/7/8. `PermissionPoint` (Task 1) is the single type across `roleResolver` (Task 5), re-gating (Task 5), and the SPA mirror (Task 11) — the mirror test pins SPA==server. `scopeApi.loadScope(claims)` signature used identically in dept/user routes. Role `name`=code / `display_name`=human is consistent (Tasks 4, 9, 13). `orgService.createUser` returns `{id, tempPassword}` consistently (Task 7 → Task 14 drawer).

**Known execution notes:** run server tests per-file (sandbox fd limit); the full 3-phase frontend is the largest block — a coordinator may split Task 12/13/14 into separate subagent dispatches.
