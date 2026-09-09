# RBAC Roles + Permission Points — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 职位 (Positions) module in `enterprise_server` with a 角色 (Roles) module backed by a permission-point catalog; enforce authorization at routes by permission point; drop the `positions` table + FK and the `effective_roles_cache` column.

**Architecture:** A static `PermissionCode` catalog (the point vocabulary) + a new global `roles` table (name → set of points). A DB-backed, live `RoleResolver` maps a user's role names (from the JWT) to a union of points via a short-TTL + invalidation cache. A new `requirePermission(point)` middleware enforces gates; the ~10 existing `requireCapability(role)` routes migrate to it. Positions are removed end-to-end (schema + code + SPA).

**Tech Stack:** Hono + Zod + `pglite` (tests) on the server; React 19 + TanStack Query + `@testing-library/react` + jsdom in the SPA (`enterprise_server/web`). No Postgres on the host — tests run in-process via `@electric-sql/pglite`.

**Spec:** `docs/superpowers/specs/2026-09-14-rbac-roles-design.md` — the plan argues from the spec; read both.

## Global Constraints

- TypeScript; 2-space indent, single quotes, semicolons; `PascalCase` types, `camelCase` fns. Match existing Hono/Zod/`pool.query<T>(sql, params)` idioms.
- **String-constants rule:** all permission-point IDs come from the one `as const` `PermissionCode` object + derived type in `src/shared/enterpriseServerConstants.ts`. No bare point-ID literals at call sites.
- **Migrations:** idempotent (`IF NOT EXISTS` / `IF EXISTS`), applied via the `_migrations` ledger, ordered by filename. New migration files only — never edit an already-applied file to change a live DB. `001_init.sql` is the *single exception* (edited for the canonical fresh schema).
- **i18n (SPA):** every new user-visible string goes through `t('key')` with both `en` and `zh` blocks in `web/src/i18n.ts`. Server error envelopes stay English (`{ error: ... }`).
- **Audit:** role mutations write an `auditStore.write` row. Never log role names into secrets.
- **Fail-closed compat:** unknown role names → zero points; `super_admin` bypasses everything; legacy `admin` role ≡ `org_admin`'s points.
- **Lint (CI rule):** every *touched* file must pass `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <file>`. Several touched files carry pre-existing `no-explicit-any` debt that must be cleaned *as part of* the rewrite of that file (concrete types, not `any`).
- **Scope:** `enterprise_server` only. The desktop client is in scope **only** as the constraint that `GET /me` keeps its `effective_roles` field.
- **Test entry:** server `npm test` (vitest, pglite); SPA `npm run web:test` (== `npm run test --prefix web`). SPA test files live under `enterprise_server/web/tests/` and import from `vitest` + `@testing-library/react`; they stub global `fetch` with `vi.fn()`.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/shared/enterpriseServerConstants.ts` (M) | Add `PermissionCode` `as const` + type; add `RoleCreate/RoleUpdate/RoleDelete` to `AuditAction`. |
| `src/db/migrations/001_init.sql` (M) | Remove `positions` table, `position_id` FK, `effective_roles_cache` column (canonical fresh schema). |
| `src/db/migrations/019_rbac.sql` (C) | Create `roles` + seed 4 core roles. |
| `src/db/migrations/020_drop_positions.sql` (C) | Drop `users.position_id` then `positions`. |
| `src/db/migrations/021_drop_effective_roles_cache.sql` (C) | Drop `users.effective_roles_cache`. |
| `src/org/roleService.ts` (C) | `roles` CRUD SQL (list/create/get/update/remove). |
| `src/auth/roleResolver.ts` (C) | DB-backed, live name→points resolver (TTL cache + invalidate + `admin` alias, fail-closed). |
| `src/auth/middleware.ts` (M) | Add `requirePermission(code)`; keep `requireCapability`/`requireAdmin`/`requireSuperAdmin` unchanged. |
| `src/routes/admin/roles.ts` (C) | `/admin/roles` CRUD routes (Zod-validated, audited). |
| `src/routes/admin/{users,departments,models,providerKeys,policies,audit,releases,archives}.ts` (M) | `requireCapability` → `requirePermission`. |
| `src/routes/{roleVocabulary,mcpMarketplaceAdmin}.ts` (M) | `requireCapability` → `requirePermission`; roleVocabulary rewrites its `positions` query to `roles`. |
| `src/routes/admin/positions.ts` (D) | Deleted. |
| `src/server.ts` (M) | Drop `posRoutes`; add `roleAdminRoutes`. |
| `src/org/orgService.ts` (M) | Remove positions + `computeEffectiveRoles` + `effective_roles_cache` writes. |
| `src/routes/me.ts` (M) | Keep `effective_roles` field (from `extra_roles`); drop `effective_roles_cache` read; clean `any`. |
| `src/auth/authService.ts` (M) | Drop `effective_roles_cache` from first-admin INSERT. |
| `src/setup/invitationService.ts` (M) | Drop `effective_roles_cache` from invitation INSERT. |
| `web/src/shared/permissions.ts` (C) | SPA mirror of `PermissionCode` + iteration array + label-key helper. |
| `web/src/api/roles.ts` (C) | `rolesApi` (list/create/patch/delete). |
| `web/src/pages/RolesPage.tsx` (C) | Roles list + create/edit. |
| `web/src/components/RoleFormDrawer.tsx` (C) | Name/description + permission-point checkbox list. |
| `web/src/pages/PositionsPage.tsx` (D) | Deleted. |
| `web/src/api/positions.ts` (D) | Deleted. |
| `web/src/App.tsx` (M) | Swap `/orgs/positions` → `/orgs/roles`; import RolesPage. |
| `web/src/components/Sidebar.tsx` (M) | Swap 职位 nav item → 角色. |
| `web/src/api/users.ts` (M) | Drop `position_id`/`positionId`/`effective_roles_cache` from types. |
| `web/src/i18n.ts` (M) | Remove `nav.positions`/`page.positions.title`; add role + perm keys. |
| `src/shared/enterpriseServerConstants.ts` (see above) | — |

Tests (C = create, M = modify):
- `tests/shared/permissionCodes.test.ts` (C)
- `tests/db/migrate.test.ts` (M)
- `tests/org/roleService.test.ts` (C)
- `tests/auth/roleResolver.test.ts` (C)
- `tests/auth/requirePermission.test.ts` (C)
- `tests/routes/roles.test.ts` (C)
- `tests/routes/admin.test.ts` (M)
- `tests/routes/roleVocabulary.test.ts` (M)
- `tests/org/orgService.test.ts` (M)
- `tests/routes/me.test.ts` (M)
- `web/tests/pages/RolesPage.test.tsx` (C)
- `web/tests/pages/UsersPage.test.tsx` (M)

---

### Task 1: `PermissionCode` catalog + audit actions (shared)

**Files:**
- Modify: `src/shared/enterpriseServerConstants.ts`
- Test: `tests/shared/permissionCodes.test.ts` (create)

**Interfaces:**
- Produces: `PermissionCode` const + type (server). `AuditAction.RoleCreate/RoleUpdate/RoleDelete`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/shared/permissionCodes.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { PermissionCode, AuditAction } from '../../src/shared/enterpriseServerConstants';

describe('PermissionCode catalog', () => {
  test('exposes the expected point IDs', () => {
    expect(PermissionCode.UsersManage).toBe('users.manage');
    expect(PermissionCode.RolesManage).toBe('roles.manage');
    expect(PermissionCode.DepartmentsManage).toBe('departments.manage');
    expect(PermissionCode.ModelsManage).toBe('models.manage');
    expect(PermissionCode.ProviderKeysManage).toBe('provider_keys.manage');
    expect(PermissionCode.PoliciesManage).toBe('policies.manage');
    expect(PermissionCode.AuditView).toBe('audit.view');
    expect(PermissionCode.ReleasesManage).toBe('releases.manage');
    expect(PermissionCode.McpManage).toBe('mcp.manage');
  });

  test('point IDs are unique', () => {
    const values = Object.values(PermissionCode);
    expect(new Set(values).size).toBe(values.length);
  });

  test('AuditAction carries role mutation actions', () => {
    expect(AuditAction.RoleCreate).toBe('role_create');
    expect(AuditAction.RoleUpdate).toBe('role_update');
    expect(AuditAction.RoleDelete).toBe('role_delete');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/shared/permissionCodes.test.ts`
Expected: FAIL — `PermissionCode` is not defined / not exported.

- [ ] **Step 3: Add the constants**

In `enterprise_server/src/shared/enterpriseServerConstants.ts`, after the existing `Role` block (keep `Role` as-is) add:

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

In the `AuditAction` object, before its closing `} as const`, add:

```ts
  RoleCreate: 'role_create',
  RoleUpdate: 'role_update',
  RoleDelete: 'role_delete',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/shared/permissionCodes.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Lint the touched file**

Run: `cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/shared/enterpriseServerConstants.ts tests/shared/permissionCodes.test.ts`
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/shared/enterpriseServerConstants.ts enterprise_server/tests/shared/permissionCodes.test.ts
git commit -m "feat(enterprise_server): add PermissionCode catalog and role audit actions"
```

---

### Task 2: `roles` table migration + seed

**Files:**
- Create: `src/db/migrations/019_rbac.sql`
- Modify: `tests/db/migrate.test.ts`

**Interfaces:**
- Produces: `roles` table (`id`, `name` UNIQUE, `description`, `permissions JSONB`, `created_at`) seeded with `org_admin`/`model_admin`/`policy_admin`/`auditor`. (The `positions`/`position_id`/`effective_roles_cache` removal from the fresh `001` schema is deliberately **deferred to Task 8** so the suite stays green between Tasks 2 and 8 — see Task 8.)

- [ ] **Step 1: Write the failing test**

In `enterprise_server/tests/db/migrate.test.ts`, ADD `'roles'` to the expected-tables array (keep `'positions'` — it is only removed in Task 8). The array becomes:

```ts
    const names = r.rows.map((x) => x.tablename);
    for (const t of [
      'orgs',
      'departments',
      'positions',
      'roles',
      'users',
      'init_invitations',
      'provider_keys',
      'model_catalog',
      'model_policies',
      'skill_policies',
      'audit_events',
      'user_archives',
      'token_usage',
    ]) {
      expect(names).toContain(t);
    }
```

Add a new test asserting the 4 core roles are seeded (do **not** assert `positions` is absent here — that assertion belongs in Task 8, after the fresh schema is cleaned):

```ts
  test('roles seeded with 4 core roles', async () => {
    await runMigrations();
    const seed = await testPool.query<{ name: string }>(
      `SELECT name FROM roles ORDER BY name`
    );
    expect(seed.rows.map((r) => r.name).sort()).toEqual(
      ['auditor', 'model_admin', 'org_admin', 'policy_admin']
    );
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/db/migrate.test.ts`
Expected: FAIL — the `roles` table is not present yet (019 not created), so `expect(names).toContain('roles')` and the seed test fail. `positions` is still present and expected.

- [ ] **Step 3: Create `019_rbac.sql`**

Create `enterprise_server/src/db/migrations/019_rbac.sql`:

```sql
-- v1
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  permissions JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO roles(id, name, description, permissions)
VALUES (gen_random_uuid(), 'org_admin', 'Organization administrator',
        '["users.manage","roles.manage","departments.manage","releases.manage","mcp.manage"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, description, permissions)
VALUES (gen_random_uuid(), 'model_admin', 'Model & provider-key administrator',
        '["models.manage"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, description, permissions)
VALUES (gen_random_uuid(), 'policy_admin', 'Policy administrator',
        '["policies.manage"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO roles(id, name, description, permissions)
VALUES (gen_random_uuid(), 'auditor', 'Auditor',
        '["audit.view"]'::jsonb)
ON CONFLICT (name) DO NOTHING;
```

- [ ] **Step 4: (Do NOT touch `001_init.sql` in this task)**

The removal of `positions`/`position_id`/`effective_roles_cache` from the fresh `001_init.sql` schema is deliberately done in **Task 8**, atomically with the source scrub (orgService/me/authService/invitationService) and the live-DB drop migrations (020/021). Doing it here would leave the source code referencing dropped columns and turn the whole suite red across Tasks 3-7. So `001_init.sql` is left **unchanged** in Task 2.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/db/migrate.test.ts`
Expected: PASS (all tests in this file). `001_init.sql` is untouched, so the rest of the suite is unaffected by this task.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/db/migrations/019_rbac.sql enterprise_server/tests/db/migrate.test.ts
git commit -m "feat(enterprise_server): add roles table and seed core RBAC roles"
```

---

### Task 3: `roleService` (roles CRUD)

**Files:**
- Create: `src/org/roleService.ts`
- Test: `tests/org/roleService.test.ts`

**Interfaces:**
- Consumes: `PermissionCode` (Task 1).
- Produces:
  ```ts
  export interface Role { id: string; name: string; description: string | null; permissions: PermissionCode[] }
  export const roleService: {
    list(): Promise<Role[]>;
    create(input: { name: string; description?: string | null; permissions: PermissionCode[] }): Promise<{ id: string }>; // throws on duplicate name
    get(id: string): Promise<Role | null>;
    update(id: string, patch: { name?: string; description?: string | null; permissions?: PermissionCode[] }): Promise<void>; // throws if not found or duplicate name
    remove(id: string): Promise<void>; // no-op if not found
  };
  ```

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/org/roleService.test.ts`:

```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { roleService } from '../../src/org/roleService';

describe('roleService', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  });

  test('lists seeded core roles', async () => {
    const rows = await roleService.list();
    expect(rows.map((r) => r.name).sort()).toEqual(
      ['auditor', 'model_admin', 'org_admin', 'policy_admin']
    );
    const org = rows.find((r) => r.name === 'org_admin');
    expect(org?.permissions).toContain('users.manage');
  });

  test('create + get', async () => {
    const { id } = await roleService.create({
      name: 'viewer',
      description: 'read-only',
      permissions: ['audit.view'],
    });
    const got = await roleService.get(id);
    expect(got?.name).toBe('viewer');
    expect(got?.permissions).toEqual(['audit.view']);
  });

  test('create rejects duplicate name', async () => {
    await expect(roleService.create({ name: 'auditor', permissions: [] })).rejects.toThrow(/already/i);
  });

  test('update changes permissions and description', async () => {
    const { id } = await roleService.create({ name: 'x', permissions: [] });
    await roleService.update(id, { permissions: ['audit.view', 'roles.manage'], description: 'd' });
    const got = await roleService.get(id);
    expect(got?.permissions.sort()).toEqual(['audit.view', 'roles.manage']);
    expect(got?.description).toBe('d');
  });

  test('remove deletes', async () => {
    const { id } = await roleService.create({ name: 'tmp', permissions: [] });
    await roleService.remove(id);
    expect(await roleService.get(id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/org/roleService.test.ts`
Expected: FAIL — `roleService` module not found.

- [ ] **Step 3: Implement `roleService.ts`**

Create `enterprise_server/src/org/roleService.ts`:

```ts
import type { PermissionCode } from '../shared/enterpriseServerConstants';
import { pool } from '../db/pool';

export interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: PermissionCode[];
}

async function assertNameUnique(name: string, excludeId?: string): Promise<void> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM roles WHERE name=$1 ${excludeId ? 'AND id<>$2' : ''}`,
    excludeId ? [name, excludeId] : [name]
  );
  if (r.rowCount > 0) throw new Error(`role name '${name}' already exists`);
}

export const roleService = {
  async list(): Promise<Role[]> {
    const r = await pool.query<Role>(`SELECT id, name, description, permissions FROM roles ORDER BY name`);
    return r.rows;
  },

  async create(input: {
    name: string;
    description?: string | null;
    permissions: PermissionCode[];
  }): Promise<{ id: string }> {
    await assertNameUnique(input.name);
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO roles(id, name, description, permissions) VALUES ($1,$2,$3,$4)`,
      [id, input.name, input.description ?? null, JSON.stringify(input.permissions)]
    );
    return { id };
  },

  async get(id: string): Promise<Role | null> {
    const r = await pool.query<Role>(`SELECT id, name, description, permissions FROM roles WHERE id=$1`, [id]);
    return r.rows[0] ?? null;
  },

  async update(
    id: string,
    patch: { name?: string; description?: string | null; permissions?: PermissionCode[] }
  ): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error('role not found');
    const name = patch.name ?? existing.name;
    if (patch.name !== undefined) await assertNameUnique(name, id);
    const description = patch.description === undefined ? existing.description : patch.description;
    const permissions = patch.permissions ?? existing.permissions;
    await pool.query(
      `UPDATE roles SET name=$1, description=$2, permissions=$3 WHERE id=$4`,
      [name, description, JSON.stringify(permissions), id]
    );
  },

  async remove(id: string): Promise<void> {
    await pool.query(`DELETE FROM roles WHERE id=$1`, [id]);
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/org/roleService.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Lint**

Run: `cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/org/roleService.ts tests/org/roleService.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/org/roleService.ts enterprise_server/tests/org/roleService.test.ts
git commit -m "feat(enterprise_server): add roleService for roles catalog CRUD"
```

---

### Task 4: `roleResolver` (DB-backed, live, cache, `admin` alias, fail-closed)

**Files:**
- Create: `src/auth/roleResolver.ts`
- Test: `tests/auth/roleResolver.test.ts`

**Interfaces:**
- Consumes: `PermissionCode` (Task 1).
- Produces:
  ```ts
  export interface RoleResolver {
    pointsFor(roles: string[]): Set<PermissionCode>;
    invalidate(): void;
  }
  export const roleResolver: RoleResolver;
  ```

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/auth/roleResolver.test.ts`:

```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { roleResolver } from '../../src/auth/roleResolver';
import { roleService } from '../../src/org/roleService';

describe('roleResolver', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  });

  test('unions points across multiple roles', () => {
    const pts = roleResolver.pointsFor(['org_admin', 'auditor']);
    expect(pts.has('users.manage')).toBe(true);   // from org_admin
    expect(pts.has('audit.view')).toBe(true);     // from auditor
    expect(pts.has('policies.manage')).toBe(false);
  });

  test('legacy admin alias resolves to org_admin points', () => {
    const pts = roleResolver.pointsFor(['admin']);
    expect(pts.has('roles.manage')).toBe(true);
    expect(pts.has('models.manage')).toBe(false);
  });

  test('unknown role names contribute nothing (fail-closed)', () => {
    const pts = roleResolver.pointsFor(['ghost']);
    expect(pts.size).toBe(0);
  });

  test('invalidate() picks up a role edit live', async () => {
    expect(roleResolver.pointsFor(['viewer']).has('audit.view')).toBe(false);
    const { id } = await roleService.create({ name: 'viewer', permissions: [] });
    await roleService.update(id, { permissions: ['audit.view'] });
    roleResolver.invalidate();
    expect(roleResolver.pointsFor(['viewer']).has('audit.view')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/auth/roleResolver.test.ts`
Expected: FAIL — `roleResolver` module not found.

- [ ] **Step 3: Implement `roleResolver.ts`**

Create `enterprise_server/src/auth/roleResolver.ts`:

```ts
import type { PermissionCode } from '../shared/enterpriseServerConstants';
import { pool } from '../db/pool';

export interface RoleResolver {
  pointsFor(roles: string[]): Set<PermissionCode>;
  invalidate(): void;
}

const TTL_MS = 30_000;
/** Compat alias: the legacy free-form 'admin' role maps to 'org_admin'. */
const LEGACY_ADMIN = { from: 'admin', to: 'org_admin' } as const;

let cache: Map<string, PermissionCode[]> | null = null;
let expiresAt = 0;

async function load(): Promise<Map<string, PermissionCode[]>> {
  const r = await pool.query<{ name: string; permissions: PermissionCode[] }>(
    `SELECT name, permissions FROM roles`
  );
  const m = new Map<string, PermissionCode[]>();
  for (const row of r.rows) m.set(row.name, row.permissions ?? []);
  return m;
}

async function resolveMap(): Promise<Map<string, PermissionCode[]>> {
  const now = Date.now();
  if (!cache || now >= expiresAt) {
    cache = await load();
    expiresAt = now + TTL_MS;
  }
  return cache;
}

export const roleResolver: RoleResolver = {
  // pointsFor is sync per the interface; callers await invalidate() before
  // relying on fresh data. To keep pointsFor sync + correct, we warm the
  // cache lazily and, if cold, synchronously fall back to a best-effort read
  // is impossible (DB is async) — so pointsFor MUST be preceded by
  // ensureLoaded(). We expose pointsFor as reading an already-loaded cache
  // and provide `refresh()` for the middleware to await. See middleware.ts.
  pointsFor(roles: string[]): Set<PermissionCode> {
    const pts = new Set<PermissionCode>();
    const map = cache; // read current cache (may be null pre-warm)
    for (const raw of roles) {
      const name = raw === LEGACY_ADMIN.from ? LEGACY_ADMIN.to : raw;
      const p = map?.get(name);
      if (p) for (const x of p) pts.add(x);
    }
    return pts;
  },
  invalidate(): void {
    cache = null;
    expiresAt = 0;
  },
  // Awaitable warm for the middleware (resolves the cache if cold/expired).
  async refresh(): Promise<void> {
    await resolveMap();
  },
} satisfies RoleResolver;
```

Wait — the interface promises `pointsFor` is sync but the middleware needs a fresh read. Resolve this cleanly by making the resolver **awaitable** and the middleware call the async path. Replace the implementation with the following final version (the above is superseded):

```ts
import type { PermissionCode } from '../shared/enterpriseServerConstants';
import { pool } from '../db/pool';

export interface RoleResolver {
  /** Resolve role names to the union of their permission points. */
  pointsFor(roles: string[]): Promise<Set<PermissionCode>>;
  /** Drop the cache (call after any role create/update/delete). */
  invalidate(): void;
}

const TTL_MS = 30_000;
const LEGACY_ADMIN = { from: 'admin', to: 'org_admin' } as const;

let cache: Map<string, PermissionCode[]> | null = null;
let expiresAt = 0;

async function load(): Promise<Map<string, PermissionCode[]>> {
  const r = await pool.query<{ name: string; permissions: PermissionCode[] }>(
    `SELECT name, permissions FROM roles`
  );
  const m = new Map<string, PermissionCode[]>();
  for (const row of r.rows) m.set(row.name, row.permissions ?? []);
  return m;
}

async function resolveMap(): Promise<Map<string, PermissionCode[]>> {
  const now = Date.now();
  if (!cache || now >= expiresAt) {
    cache = await load();
    expiresAt = now + TTL_MS;
  }
  return cache;
}

export const roleResolver: RoleResolver = {
  async pointsFor(roles: string[]): Promise<Set<PermissionCode>> {
    const map = await resolveMap();
    const pts = new Set<PermissionCode>();
    for (const raw of roles) {
      const name = raw === LEGACY_ADMIN.from ? LEGACY_ADMIN.to : raw;
      const p = map.get(name);
      if (p) for (const x of p) pts.add(x);
    }
    return pts;
  },
  invalidate(): void {
    cache = null;
    expiresAt = 0;
  },
};
```

And update the test to await `pointsFor` — revise the test file so each `roleResolver.pointsFor(...)` call is `await`ed:

```ts
  test('unions points across multiple roles', async () => {
    const pts = await roleResolver.pointsFor(['org_admin', 'auditor']);
    expect(pts.has('users.manage')).toBe(true);
    expect(pts.has('audit.view')).toBe(true);
    expect(pts.has('policies.manage')).toBe(false);
  });

  test('legacy admin alias resolves to org_admin points', async () => {
    const pts = await roleResolver.pointsFor(['admin']);
    expect(pts.has('roles.manage')).toBe(true);
    expect(pts.has('models.manage')).toBe(false);
  });

  test('unknown role names contribute nothing (fail-closed)', async () => {
    const pts = await roleResolver.pointsFor(['ghost']);
    expect(pts.size).toBe(0);
  });

  test('invalidate() picks up a role edit live', async () => {
    expect((await roleResolver.pointsFor(['viewer'])).has('audit.view')).toBe(false);
    const { id } = await roleService.create({ name: 'viewer', permissions: [] });
    await roleService.update(id, { permissions: ['audit.view'] });
    roleResolver.invalidate();
    expect((await roleResolver.pointsFor(['viewer'])).has('audit.view')).toBe(true);
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/auth/roleResolver.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Lint**

Run: `cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/auth/roleResolver.ts tests/auth/roleResolver.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/auth/roleResolver.ts enterprise_server/tests/auth/roleResolver.test.ts
git commit -m "feat(enterprise_server): add DB-backed live roleResolver with TTL cache"
```

---

### Task 5: `requirePermission` middleware

**Files:**
- Modify: `src/auth/middleware.ts`
- Test: `tests/auth/requirePermission.test.ts`

**Interfaces:**
- Consumes: `PermissionCode` (Task 1), `roleResolver` (Task 4).
- Produces: `requirePermission(code: PermissionCode): MiddlewareHandler`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/auth/requirePermission.test.ts`:

```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { signToken } from '../../src/auth/jwt';
import { requirePermission } from '../../src/auth/middleware';
import { PermissionCode } from '../../src/shared/enterpriseServerConstants';
import { roleService } from '../../src/org/roleService';

const tok = (sub: string, orgId: string, roles: string[]) =>
  signToken({ sub, orgId, roles });

describe('requirePermission', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  });

  test('401 without a token', async () => {
    const app = new Hono();
    app.use('*', requirePermission(PermissionCode.AuditView));
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x');
    expect(res.status).toBe(401);
  });

  test('super_admin bypasses the point check', async () => {
    const app = new Hono();
    app.use('*', requirePermission(PermissionCode.AuditView));
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x', {
      headers: { authorization: `Bearer ${await tok('u', 'o1', ['super_admin'])}` },
    });
    expect(res.status).toBe(200);
  });

  test('403 when no role grants the point', async () => {
    const app = new Hono();
    app.use('*', requirePermission(PermissionCode.AuditView));
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x', {
      headers: { authorization: `Bearer ${await tok('u', 'o1', ['model_admin'])}` },
    });
    expect(res.status).toBe(403);
  });

  test('200 when a role grants the point', async () => {
    const app = new Hono();
    app.use('*', requirePermission(PermissionCode.AuditView));
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x', {
      headers: { authorization: `Bearer ${await tok('u', 'o1', ['auditor'])}` },
    });
    expect(res.status).toBe(200);
  });

  test('live: a custom role granted the point is allowed', async () => {
    const { id } = await roleService.create({ name: 'viewer', permissions: ['audit.view'] });
    void id;
    const app = new Hono();
    app.use('*', requirePermission(PermissionCode.AuditView));
    app.get('/x', (c) => c.json({ ok: true }));
    const res = await app.request('/x', {
      headers: { authorization: `Bearer ${await tok('u', 'o1', ['viewer'])}` },
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/auth/requirePermission.test.ts`
Expected: FAIL — `requirePermission` not exported.

- [ ] **Step 3: Add `requirePermission`**

In `enterprise_server/src/auth/middleware.ts`, add the import at the top (after the existing `import` lines):

```ts
import type { PermissionCode } from '../shared/enterpriseServerConstants';
import { roleResolver } from './roleResolver';
```

Add this export after the existing `requireCapability` function (do NOT modify `requireCapability`, `requireSuperAdmin`, or `requireAdmin`):

```ts
/**
 * Permission-point gate. Passes if the caller is `super_admin` OR any of the
 * caller's roles (resolved via `roleResolver` against the live `roles` table)
 * grants the named point. Audits `admin_access_denied` on 403, mirroring
 * `requireCapability`.
 */
export function requirePermission(code: PermissionCode): MiddlewareHandler {
  return async (c, next) => {
    const h = c.req.header('authorization');
    if (!h?.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let claims: Claims;
    try {
      claims = await verifyToken(h.slice(7));
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('claims', claims);
    if (claims.roles.includes(Role.SuperAdmin)) {
      await next();
      return;
    }
    const points = await roleResolver.pointsFor(claims.roles);
    if (points.has(code)) {
      await next();
      return;
    }
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: 'admin_access_denied',
      targetType: 'route',
      targetId: c.req.path,
      payload: { roles: claims.roles, required: code },
    });
    return c.json({ error: 'forbidden' }, 403);
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/auth/requirePermission.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Lint**

Run: `cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/auth/middleware.ts tests/auth/requirePermission.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/src/auth/middleware.ts enterprise_server/tests/auth/requirePermission.test.ts
git commit -m "feat(enterprise_server): add requirePermission point-gate middleware"
```

---

### Task 6: `/admin/roles` CRUD routes + server wiring + audit

**Files:**
- Create: `src/routes/admin/roles.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `roleService` (Task 3), `requirePermission` (Task 5), `roleResolver` (Task 4), `PermissionCode`/`AuditAction` (Task 1).
- Produces: `roleAdminRoutes` (Hono) mounted in `server.ts`.

- [ ] **Step 1: Write the failing test**

Create `enterprise_server/tests/routes/roles.test.ts`:

```ts
import '../helpers/setupEnv';
import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { signToken } from '../../src/auth/jwt';
import { roleAdminRoutes } from '../../src/routes/admin/roles';

const app = () => {
  const a = new Hono();
  a.route('/', roleAdminRoutes);
  return a;
};
const hdr = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

describe('routes/admin/roles', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T')`);
  });

  test('403 for a token whose role lacks roles.manage', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['model_admin'] });
    const res = await app().request('/admin/roles', { headers: hdr(t) });
    expect(res.status).toBe(403);
  });

  test('org_admin lists roles', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['org_admin'] });
    const res = await app().request('/admin/roles', { headers: hdr(t) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string }[];
    expect(body.map((r) => r.name)).toContain('org_admin');
  });

  test('super_admin can create a role with valid points', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'viewer', description: 'ro', permissions: ['audit.view'] }),
    });
    expect(res.status).toBe(200);
    const audit = await testPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action='role_create'`
    );
    expect(audit.rows.length).toBe(1);
  });

  test('rejects unknown permission point (422)', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const res = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'bad', permissions: ['nope.nope'] }),
    });
    expect(res.status).toBe(422);
  });

  test('delete a role writes role_delete audit', async () => {
    const t = await signToken({ sub: 'u', orgId: 'o1', roles: ['super_admin'] });
    const create = await app().request('/admin/roles', {
      method: 'POST',
      headers: hdr(t),
      body: JSON.stringify({ name: 'tmp', permissions: [] }),
    });
    const { id } = (await create.json()) as { id: string };
    const del = await app().request(`/admin/roles/${id}`, { method: 'DELETE', headers: hdr(t) });
    expect(del.status).toBe(200);
    const audit = await testPool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action='role_delete'`
    );
    expect(audit.rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/roles.test.ts`
Expected: FAIL — `roleAdminRoutes` not found.

- [ ] **Step 3: Create `roles.ts` route**

Create `enterprise_server/src/routes/admin/roles.ts`:

```ts
import { Hono } from 'hono';
import { z, ZodError } from 'zod';

import { requirePermission } from '../../auth/middleware';
import { roleResolver } from '../../auth/roleResolver';
import { roleService } from '../../org/roleService';
import { auditStore } from '../../audit/auditStore';
import { AuditAction, PermissionCode } from '../../shared/enterpriseServerConstants';

const KNOWN_POINTS = Object.values(PermissionCode) as [string, ...string[]];
const pointsArray = z.array(z.enum(KNOWN_POINTS));

// Local error-response helper — mirrors src/routes/admin/releases.ts (the
// 422-invalid-input idiom). Validation failures must return 422, not throw.
const httpError = (status: number, error: string, issues?: unknown): Response =>
  new Response(JSON.stringify({ error, ...(issues ? { issues } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const roleAdminRoutes = new Hono();
roleAdminRoutes.use('/admin/roles', requirePermission(PermissionCode.RolesManage));

roleAdminRoutes.get('/admin/roles', async (c) => {
  return c.json(await roleService.list());
});

roleAdminRoutes.post('/admin/roles', async (c) => {
  const claims = c.get('claims');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      name: z.string().min(1),
      description: z.string().nullable().optional(),
      permissions: pointsArray.default([]),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return httpError(422, 'invalid_input', (parsed.error as ZodError).issues);
  }
  const body = parsed.data;
  try {
    const { id } = await roleService.create({
      name: body.name,
      description: body.description,
      permissions: body.permissions,
    });
    roleResolver.invalidate();
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.RoleCreate,
      targetType: 'role',
      targetId: id,
      payload: { name: body.name, permissions: body.permissions },
    });
    return c.json({ id });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
});

roleAdminRoutes.patch('/admin/roles/:id', async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      permissions: pointsArray.optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return httpError(422, 'invalid_input', (parsed.error as ZodError).issues);
  }
  const body = parsed.data;
  try {
    await roleService.update(id, body);
    roleResolver.invalidate();
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.RoleUpdate,
      targetType: 'role',
      targetId: id,
      payload: body,
    });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
});

roleAdminRoutes.delete('/admin/roles/:id', async (c) => {
  const claims = c.get('claims');
  const id = c.req.param('id');
  await roleService.remove(id);
  roleResolver.invalidate();
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.RoleDelete,
    targetType: 'role',
    targetId: id,
  });
  return c.json({ ok: true });
});
```

Notes:
- **Validation is `safeParse` + `httpError(422, ...)`** (NOT `.parse()`), so an unknown permission point returns **422** as the test expects — `.parse()` would throw and surface as a 500. This mirrors `src/routes/admin/releases.ts`.
- `Object.values(PermissionCode) as [string, ...string[]]` satisfies zod 3.x's `z.enum` non-empty-tuple requirement (verified against the installed `zod@3.25.76`).
- `roleResolver.invalidate()` is called after each mutation (the route-level cache invalidation; `roleService` also invalidates internally since Task 5 — redundant but harmless boundary defense).

- [ ] **Step 4: Wire into `server.ts` (ADD ONLY — do not remove `posRoutes` here)**

In `enterprise_server/src/server.ts`:
- Add `import { roleAdminRoutes } from './routes/admin/roles';` near the other `admin/*` imports (alphabetically, before the `providerKeys` line).
- Add `app.route('/', roleAdminRoutes);` near the other `app.route('/', admin...)` calls (e.g. after `adminPolicyRoutes`).
- **Do NOT remove `posRoutes` / the `positions.ts` import here** — the positions removal is Task 8's scope. Adding `roleAdminRoutes` alongside the still-present `posRoutes` causes no route collision (`/admin/roles` vs `/admin/positions`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/roles.test.ts`
Expected: PASS (5/5). Then run the type check:
Run: `cd enterprise_server && npx tsc --noEmit`
Expected: no errors introduced in touched files (adjust the Zod import/cast if `tsc` flags it).

- [ ] **Step 6: Lint**

Run: `cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 src/routes/admin/roles.ts src/server.ts tests/routes/roles.test.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/routes/admin/roles.ts enterprise_server/src/server.ts enterprise_server/tests/routes/roles.test.ts
git commit -m "feat(enterprise_server): add /admin/roles CRUD routes with audit"
```

---

### Task 7: Migrate route gates to `requirePermission`

**Files:**
- Modify: `src/routes/admin/users.ts`, `src/routes/admin/departments.ts`, `src/routes/admin/models.ts`, `src/routes/admin/providerKeys.ts`, `src/routes/admin/policies.ts`, `src/routes/admin/audit.ts`, `src/routes/admin/releases.ts`, `src/routes/admin/archives.ts`, `src/routes/mcpMarketplaceAdmin.ts`
- Test: (uses existing route tests).
- **DO NOT touch `src/routes/roleVocabulary.ts`** — its gate swap + `positions`→`roles` query rewrite is Task 8 Step 7 (whole-file rewrite). **DO NOT touch `src/routes/admin/positions.ts`** — deleted in Task 8. Both still use `requireCapability` after this task; that is expected (see Step 2).

**Interfaces:**
- Consumes: `requirePermission` (Task 5), `PermissionCode` (Task 1).
- Produces: every admin gate enforced by point.

**Ruling — lint cleanup is scoped to the files touched here.** Several files carry pre-existing `no-explicit-any` debt. Where a file is edited in this task, remove the `any` casts in the *lines/sections you already touch* (concrete types). Do not do a repo-wide `any` sweep.

- [ ] **Step 1: Apply the gate swaps**

For each file, replace the `requireCapability('<role>')` call (and drop the now-unused `requireCapability` import if it becomes unused) with the mapped `requirePermission(...)`:

| File | From | To |
|------|------|----|
| `admin/users.ts` | `requireCapability('org_admin')` | `requirePermission(PermissionCode.UsersManage)` |
| `admin/departments.ts` | `requireCapability('org_admin')` | `requirePermission(PermissionCode.DepartmentsManage)` |
| `admin/models.ts` | `requireCapability('model_admin')` | `requirePermission(PermissionCode.ModelsManage)` |
| `admin/providerKeys.ts` | `requireCapability('model_admin')` | `requirePermission(PermissionCode.ModelsManage)` |
| `admin/policies.ts` | `requireCapability('policy_admin')` | `requirePermission(PermissionCode.PoliciesManage)` |
| `admin/audit.ts` | `requireCapability('auditor')` | `requirePermission(PermissionCode.AuditView)` |
| `admin/releases.ts` | `requireCapability('org_admin')` | `requirePermission(PermissionCode.ReleasesManage)` |
| `admin/archives.ts` | `requireCapability('org_admin')` | `requirePermission(PermissionCode.UsersManage)` |
| `mcpMarketplaceAdmin.ts` | `requireCapability('org_admin')` | `requirePermission(PermissionCode.McpManage)` |

Import line pattern per file (adjust existing imports; keep `requireAuth` where still used):

```ts
import { requirePermission } from '../../auth/middleware'; // (or '../auth/middleware' per file depth)
import { PermissionCode } from '../../shared/enterpriseServerConstants'; // (depth per file)
```

Note `models.ts` and `providerKeys.ts` both map to `models.manage` (they share the model-management responsibility). `mcpMarketplaceAdmin.ts` uses `../auth/middleware` and `../shared/enterpriseServerConstants` (it lives at `src/routes/`, one level shallower than `admin/*`).

**Existing shared-constants import to reuse:** four of the eight `admin/*` files already import from the shared-constants module for `AuditAction` — `users.ts`, `archives.ts`, `providerKeys.ts`, `releases.ts` (all at `../../shared/enterpriseServerConstants`). In those, extend the existing import to `import { AuditAction, PermissionCode } from …` (matches `roles.ts`). In the other four (`departments.ts`, `models.ts`, `policies.ts`, `audit.ts`) and in `mcpMarketplaceAdmin.ts`, add the import line at that file's depth.

- [ ] **Step 2: Verify the 9 migrated gates**

Run: `cd enterprise_server && rg -n "requireCapability" src/routes`
Expected: exactly **two** files still match — `src/routes/admin/positions.ts` and `src/routes/roleVocabulary.ts` — both owned by Task 8 (positions is deleted, roleVocabulary is rewritten). **None** of the 9 files from Step 1 may match. (`requireCapability` remains defined in `src/auth/middleware.ts` for its unit test; it is no longer imported by any of the 9 migrated files.)

Also confirm the new gates are in place: `rg -n "requirePermission" src/routes` now includes all 9 Step-1 files (the 9th, `roles.ts`, already gates on `roles.manage` from Task 6).

- [ ] **Step 3: Run the existing route tests**

Run: `cd enterprise_server && npx vitest run tests/routes`
Expected: the gate tests still pass (super_admin/mapped-role tokens still allowed; a role lacking the point now 403s). If an existing test used a role string that no longer maps to the required point, update the test token to a role that grants the point (e.g. use `super_admin` or the mapped core role). **Do not** weaken the assertion — fix the fixture's role, not the expectation.

- [ ] **Step 4: Lint the touched route files**

Run:
```bash
cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  src/routes/admin/users.ts src/routes/admin/departments.ts src/routes/admin/models.ts \
  src/routes/admin/providerKeys.ts src/routes/admin/policies.ts src/routes/admin/audit.ts \
  src/routes/admin/releases.ts src/routes/admin/archives.ts src/routes/mcpMarketplaceAdmin.ts
```
Expected: clean (fix any `any`/unused-import warnings in the touched files).

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes
git commit -m "refactor(enterprise_server): gate admin routes by permission point"
```

---

### Task 8: Drop `positions` + `effective_roles_cache` — migrations + code scrub + `/me` compat

This is the "remove the positions feature" unit. Migrations and code scrub land together so the suite is green at the end.

**Files:**
- Create: `src/db/migrations/020_drop_positions.sql`, `src/db/migrations/021_drop_effective_roles_cache.sql`
- Modify: `src/db/migrations/001_init.sql` (fresh-schema removal — deferred here from Task 2 so the suite stays green in the interim)
- Modify: `src/org/orgService.ts`, `src/routes/me.ts`, `src/auth/authService.ts`, `src/setup/invitationService.ts`, `src/routes/admin/users.ts`
- Delete: `src/routes/admin/positions.ts`
- Modify: `src/routes/roleVocabulary.ts` (rewrite its `positions` query to `roles` — part of the gate migration), `src/server.ts` (drop `posRoutes`)
- Tests: modify `tests/db/migrate.test.ts` (assert positions removed from fresh schema), `tests/org/orgService.test.ts`, `tests/routes/admin.test.ts`, `tests/routes/roleVocabulary.test.ts`, `tests/routes/me.test.ts`

**Interfaces:**
- Produces: no `positions` table / `position_id` column / `effective_roles_cache` column / `computeEffectiveRoles` / position APIs. `GET /me` still returns `effective_roles` (= the user's `extra_roles`).

- [ ] **Step 1: Create the drop migrations AND clean the fresh schema**

`enterprise_server/src/db/migrations/020_drop_positions.sql`:
```sql
-- v1
ALTER TABLE users DROP COLUMN IF EXISTS position_id;
DROP TABLE IF EXISTS positions;
```

`enterprise_server/src/db/migrations/021_drop_effective_roles_cache.sql`:
```sql
-- v1
ALTER TABLE users DROP COLUMN IF EXISTS effective_roles_cache;
```

Also edit `enterprise_server/src/db/migrations/001_init.sql` (this is the fresh-schema half of the same removal, deferred from Task 2 so the suite stays green in between):
- Remove the whole `positions` CREATE TABLE block.
- In the `users` table, remove the `position_id TEXT REFERENCES positions(id),` line and the `effective_roles_cache JSONB,` line. The `users` table should read:

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  department_id TEXT REFERENCES departments(id),
  timezone TEXT,
  extra_roles JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, username)
);
```

- [ ] **Step 2: Update `migrate.test.ts` to assert the drops**

In `enterprise_server/tests/db/migrate.test.ts`:
1. In the expected-tables array, REMOVE `'positions'` (it is created by `001` on a fresh DB and dropped by `020`; after migrations it must not exist). Keep `'roles'`.
2. Add a new test asserting the fresh schema has no `positions` table and no `position_id`/`effective_roles_cache` columns (the `roles` seed assertion from Task 2 stays as-is):

```ts
  test('positions + effective_roles_cache removed, roles present', async () => {
    await runMigrations();
    const tables = await testPool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'`
    );
    const tnames = tables.rows.map((x) => x.tablename);
    expect(tnames).not.toContain('positions');
    expect(tnames).toContain('roles');
    const cols = await testPool.query<{ column: string }>(
      `SELECT column_name AS column FROM information_schema.columns WHERE table_name='users'`
    );
    const cnames = cols.rows.map((x) => x.column);
    expect(cnames).not.toContain('position_id');
    expect(cnames).not.toContain('effective_roles_cache');
    expect(cnames).toContain('extra_roles');
  });
```

- [ ] **Step 3: Scrub `orgService.ts`**

In `enterprise_server/src/org/orgService.ts`:
- Delete `createPosition` and `listPositions` methods entirely.
- `createUser`: remove `positionId?: string` from the input type; remove `position_id` from the INSERT column list and its value (`input.positionId ?? null`); remove `effective_roles_cache` from the column list and its value. Remove the `await this.computeEffectiveRoles(id);` call.
- Delete `computeEffectiveRoles` method entirely.
- `patchUser`: remove `positionId: string` from the patch type; remove the `if (patch.positionId !== undefined)` block; remove the `effective_roles_cache`/`computeEffectiveRoles` reference at the end (the final `await this.computeEffectiveRoles(userId)` call — delete it).
- `getUser`: remove `position_id: string | null;` from the return type; remove `position_id` from the SELECT. Remove `effective_roles_cache` from the return type and SELECT.
- `listUsers`: same removals as `getUser`.

The INSERT in `createUser` becomes:
```ts
    const roles = input.extraRoles ?? [];
    const hash = await hashPassword(input.password);
    await pool.query(
      `INSERT INTO users(id, org_id, username, password_hash,
                         department_id, timezone,
                         extra_roles)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, input.orgId, input.username, hash, input.departmentId ?? null, tz, JSON.stringify(roles)]
    );
    return { id };
```

- [ ] **Step 4: Scrub `authService.ts` and `invitationService.ts` INSERTs**

In `enterprise_server/src/auth/authService.ts`, the first-admin `createUser` INSERT currently lists `effective_roles_cache` (doubled value). Remove that column and its value:
```ts
    await pool.query(
      `INSERT INTO users(id, org_id, username, password_hash, display_name, extra_roles)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.orgId, input.username, hash, input.displayName ?? null, JSON.stringify(roles)]
    );
```

In `enterprise_server/src/setup/invitationService.ts`, the invitation-redemption `INSERT INTO users (..., extra_roles, effective_roles_cache) VALUES (..., roles, roles)` — remove `effective_roles_cache` from the column list and the trailing `roles` value (decrement the parameter index accordingly). Read the current statement and rewrite it to end on `extra_roles` with one fewer `$n`.

- [ ] **Step 5: Scrub `/me` (keep `effective_roles`, drop the column read)**

In `enterprise_server/src/routes/me.ts`:
- Remove `effective_roles_cache: string[] | null;` from `MeRow`.
- Change the `fetchMe` SELECT to drop `u.effective_roles_cache`:
  ```ts
  `SELECT u.id, u.username, u.display_name, u.timezone, u.extra_roles,
          d.path AS dept_path
   FROM users u LEFT JOIN departments d ON d.id = u.department_id
   WHERE u.id=$1`
  ```
- In `GET /me` and `PATCH /me`, replace `const eff = await orgService.computeEffectiveRoles(claims.sub);` with a direct read of the user's roles. Since `fetchMe` now selects `extra_roles`, use `row.extra_roles`:
  ```ts
  return c.json({
    ...row,
    effective_roles: row.extra_roles ?? [],
    org_id: claims.orgId,
  });
  ```
  (Both GET and the PATCH's final return use the same shape.)
- Remove the now-unused `import { orgService } from '../org/orgService';` **only if** it becomes unused (it is used only for `computeEffectiveRoles` here — verify and remove if so). Keep `auditStore`.
- Clean the two `any` casts in the Zod-safeParse result (replace `result.error as ZodError` with the typed `ZodError` from the import, and the `catch` block that does `... as any` — the current line 80 `catch (error) { ... (error as any) }` — type it as `unknown` and narrow).

- [ ] **Step 6: Delete `positions.ts` route and wire `server.ts`**

- Delete `enterprise_server/src/routes/admin/positions.ts`.
- In `src/server.ts`, remove the `posRoutes` import (`import { posRoutes } from './routes/admin/positions';`) and its `app.route('/', posRoutes);` registration. (Task 6 only *added* `roleAdminRoutes`; this removal is owned here, so the positions feature is fully gone by the end of this task.)

- [ ] **Step 7: Rewrite `roleVocabulary.ts` to `roles`**

Rewrite `enterprise_server/src/routes/roleVocabulary.ts` so it sources role names from `users.extra_roles` + `roles.name` (not `positions`), gated by `requirePermission(roles.manage)`, and with no unused imports:

```ts
import { Hono } from 'hono';

import { requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import { PermissionCode } from '../shared/enterpriseServerConstants';

const CORE_ROLES = ['super_admin', 'org_admin', 'policy_admin', 'model_admin', 'auditor'];

export const roleVocabularyRoutes = new Hono();
roleVocabularyRoutes.use('/api/roles/vocabulary', requirePermission(PermissionCode.RolesManage));

roleVocabularyRoutes.get('/api/roles/vocabulary', async (c) => {
  const u = await pool.query<{ roles: string[] }>(
    'SELECT extra_roles AS roles FROM users'
  );
  const p = await pool.query<{ name: string }>(
    'SELECT name FROM roles'
  );
  const set = new Set<string>(CORE_ROLES);
  for (const row of u.rows) for (const r of row.roles ?? []) set.add(r);
  for (const row of p.rows) set.add(row.name);
  return c.json({ roles: [...set].sort() });
});
```

- [ ] **Step 8: Scrub the Zod `positionId` from `admin/users.ts`**

In `enterprise_server/src/routes/admin/users.ts`, remove `positionId: z.string().optional(),` from both the `POST` and `PATCH` zod schemas.

- [ ] **Step 9: Update the affected tests**

- `tests/org/orgService.test.ts` — delete the `createPosition` test and the position-based `computeEffectiveRoles` test (lines ~33-65 region). Remove any `positionId` usage. If the file's `beforeEach` seeded a position, remove it.
- `tests/routes/admin.test.ts` — remove `import { posRoutes } from '../../src/routes/admin/positions';` and `app.route('/', posRoutes);`. If any test POSTs to `/admin/positions`, delete it. The `adminToken` uses `super_admin`, so the remaining dept/users tests still pass under `requirePermission`.
- `tests/routes/roleVocabulary.test.ts` — replace the `INSERT INTO positions(...)` seed with `INSERT INTO roles(id, name, description, permissions) VALUES ('r1','engineer',NULL,'[]'::jsonb)` (and a second seeded role if the test asserts a roles-table contribution). The assertion list stays (org_admin, engineer, qa, support, super_admin, model_admin) as long as those names come from `users.extra_roles` + `roles.name` + `CORE_ROLES`.
- `tests/routes/me.test.ts` — the fixture/expectations for `effective_roles` should now equal the user's `extra_roles`. If a test asserted the position-union derivation, change it to assert `effective_roles === extra_roles`.

- [ ] **Step 10: Run the full server suite**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism`
Expected: **all pass.** This is the first task where the whole server suite must be green end-to-end (migrations, roleService, resolver, middleware, routes, scrubbed orgService/me). (Use `--no-file-parallelism`: the default parallel run aborts on a pre-existing Node ESM/pglite fd-contention crash — environmental, not a real failure. See ledger Ruling R2.)

- [ ] **Step 11: Type-check + lint the touched files**

Run:
```bash
cd enterprise_server && npx tsc --noEmit
npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  src/org/orgService.ts src/routes/me.ts src/auth/authService.ts \
  src/setup/invitationService.ts src/routes/admin/users.ts src/routes/roleVocabulary.ts \
  src/server.ts
```
Expected: clean (no new TS errors; no lint warnings in touched files).

- [ ] **Step 12: Commit**

```bash
git add -A enterprise_server/src enterprise_server/tests
git commit -m "refactor(enterprise_server): remove positions module and effective_roles_cache"
```

---

### Task 9: SPA — add the Roles feature (mirror, api, page, drawer, i18n)

**Files:**
- Create: `web/src/shared/permissions.ts`, `web/src/api/roles.ts`, `web/src/pages/RolesPage.tsx`, `web/src/components/RoleFormDrawer.tsx`
- Modify: `web/src/i18n.ts`
- Test: `web/tests/pages/RolesPage.test.tsx`

**Interfaces:**
- Produces: `PermissionCode` (SPA mirror) + `PERMISSIONS` array + `permLabelKey(code)`; `rolesApi`; `RolesPage`.

- [ ] **Step 1: Create the SPA permission mirror**

Create `enterprise_server/web/src/shared/permissions.ts`:

```ts
/**
 * Mirror of enterprise_server `src/shared/enterpriseServerConstants.ts`
 * `PermissionCode`. Kept in lockstep by hand (see web/src/data/providerCatalog.ts
 * for the established mirror convention — the SPA does not import from the
 * server's src/). If a point is added/removed server-side, update this file.
 */
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
export type PermissionCode = (typeof PermissionCode)[keyof typeof PermissionCode];

export const PERMISSIONS: PermissionCode[] = Object.values(PermissionCode);

/** i18n key for a point's human label. */
export const permLabelKey = (code: PermissionCode): string => `roles.perm.${code}`;
```

- [ ] **Step 2: Create the roles API client**

Create `enterprise_server/web/src/api/roles.ts`:

```ts
import { apiClient } from './client';
import type { PermissionCode } from '../shared/permissions';

export interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: PermissionCode[];
}

export interface CreateRoleInput {
  name: string;
  description?: string | null;
  permissions: PermissionCode[];
}

export interface PatchRoleInput {
  name?: string;
  description?: string | null;
  permissions?: PermissionCode[];
}

export const rolesApi = {
  list: () => apiClient.get<Role[]>('/admin/roles'),
  create: (input: CreateRoleInput) => apiClient.post<{ id: string }>('/admin/roles', input),
  patch: (id: string, input: PatchRoleInput) => apiClient.patch<{ ok: true }>(`/admin/roles/${id}`, input),
  remove: (id: string) => apiClient.delete<void>(`/admin/roles/${id}`),
};
```

- [ ] **Step 3: Add i18n keys (en + zh)**

In `enterprise_server/web/src/i18n.ts`, in the **`en`** block (near `nav.positions`) add:
```ts
  'nav.roles': 'Roles',
  'page.roles.title': 'Roles',
  'roles.add': '+ Add role',
  'roles.name': 'Name',
  'roles.description': 'Description',
  'roles.permissions': 'Permission points',
  'roles.deleteConfirm': 'Delete this role?',
  'roles.perm.users.manage': 'Manage users',
  'roles.perm.roles.manage': 'Manage roles',
  'roles.perm.departments.manage': 'Manage departments',
  'roles.perm.models.manage': 'Manage models & keys',
  'roles.perm.provider_keys.manage': 'Manage provider keys',
  'roles.perm.policies.manage': 'Manage policies',
  'roles.perm.audit.view': 'View audit log',
  'roles.perm.releases.manage': 'Manage releases',
  'roles.perm.mcp.manage': 'Manage MCP',
```
In the **`zh`** block (near `nav.positions`) add the same keys:
```ts
  'nav.roles': '角色',
  'page.roles.title': '角色',
  'roles.add': '+ 新增角色',
  'roles.name': '角色名',
  'roles.description': '描述',
  'roles.permissions': '权限点',
  'roles.deleteConfirm': '删除该角色？',
  'roles.perm.users.manage': '用户管理',
  'roles.perm.roles.manage': '角色管理',
  'roles.perm.departments.manage': '部门管理',
  'roles.perm.models.manage': '模型与密钥管理',
  'roles.perm.provider_keys.manage': '供应商密钥管理',
  'roles.perm.policies.manage': '策略管理',
  'roles.perm.audit.view': '查看审计日志',
  'roles.perm.releases.manage': '版本管理',
  'roles.perm.mcp.manage': 'MCP 管理',
```
(Keep `nav.positions`/`page.positions.title` for now — they're removed in Task 10.)

- [ ] **Step 4: Create `RoleFormDrawer.tsx`**

Create `enterprise_server/web/src/components/RoleFormDrawer.tsx`:

```tsx
import { useState } from 'react';
import type { JSX } from 'react';
import { t } from '../i18n';
import { PERMISSIONS, permLabelKey, type PermissionCode } from '../shared/permissions';

interface Props {
  open: boolean;
  title: string;
  initial?: { name: string; description: string; permissions: PermissionCode[] } | null;
  onSubmit: (v: { name: string; description: string | null; permissions: PermissionCode[] }) => Promise<void>;
  onClose: () => void;
}

export function RoleFormDrawer({ open, title, initial, onSubmit, onClose }: Props): JSX.Element | null {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [checked, setChecked] = useState<Set<PermissionCode>>(new Set(initial?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open) return null;

  const toggle = (code: PermissionCode) => {
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({ name, description: description || null, permissions: [...checked] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[var(--text-primary)]/40">
      <div className="h-full w-[420px] bg-white shadow-lg flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-md p-1">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <label className="block">
            <span className="block text-sm font-medium mb-1">{t('roles.name')} <span className="text-[var(--danger-primary)]">*</span></span>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-default)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30" />
          </label>
          <label className="block">
            <span className="block text-sm font-medium mb-1">{t('roles.description')}</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-default)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30" />
          </label>
          <div>
            <div className="text-sm font-medium mb-2">{t('roles.permissions')}</div>
            <div className="space-y-1">
              {PERMISSIONS.map((code) => (
                <label key={code} className="flex items-center gap-2 cursor-pointer select-none py-1">
                  <input type="checkbox" checked={checked.has(code)} onChange={() => toggle(code)}
                    className="h-4 w-4 rounded border-[var(--border-default)] text-[var(--accent-primary)]" />
                  <span className="text-sm">{t(permLabelKey(code))}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="px-5 py-4 border-t border-[var(--border-subtle)] flex items-center justify-end gap-2">
          {err && <p className="text-[var(--danger-primary)] text-sm mr-auto">{err}</p>}
          <button onClick={onClose} className="rounded-lg border border-[var(--border-default)] px-3.5 py-2 text-sm" disabled={busy}>{t('common.cancel')}</button>
          <button onClick={submit} disabled={busy || name.trim() === ''}
            className="rounded-lg bg-[var(--accent-primary)] text-white px-3.5 py-2 text-sm disabled:opacity-50">{t('common.save')}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `RolesPage.tsx`**

Create `enterprise_server/web/src/pages/RolesPage.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { JSX } from 'react';
import { rolesApi, type Role } from '../api/roles';
import { useAuth } from '../auth/useAuth';
import { Badge } from '../components/Badge';
import { DataTable } from '../components/DataTable';
import { PageHeader } from '../components/PageHeader';
import { RoleFormDrawer } from '../components/RoleFormDrawer';
import { useToast } from '../components/toastStore';
import { t } from '../i18n';
import { permLabelKey, type PermissionCode } from '../shared/permissions';

type DrawerState = { open: boolean; editing: Role | null };

export function RolesPage(): JSX.Element {
  const { hasCapability } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = hasCapability('org_admin');
  const [drawer, setDrawer] = useState<DrawerState>({ open: false, editing: null });

  const query = useQuery({ queryKey: ['roles'], queryFn: rolesApi.list });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['roles'] });

  const create = useMutation({
    mutationFn: (v: { name: string; description: string | null; permissions: PermissionCode[] }) =>
      rolesApi.create(v),
    onSuccess: () => { invalidate(); toast.success('Role created'); setDrawer({ open: false, editing: null }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: { name?: string; description?: string | null; permissions?: PermissionCode[] } }) =>
      rolesApi.patch(v.id, v.body),
    onSuccess: () => { invalidate(); toast.success('Role updated'); setDrawer({ open: false, editing: null }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => rolesApi.remove(id),
    onSuccess: () => { invalidate(); toast.success('Role deleted'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = (query.data ?? []).map((r) => ({
    ...r,
    _label: r.description ?? '—',
    _perms: r.permissions,
  }));

  const columns = [
    { key: 'name', header: t('roles.name') },
    { key: '_label', header: t('roles.description') },
    {
      key: '_perms',
      header: t('roles.permissions'),
      render: (r: { _perms: PermissionCode[] }) => (
        <div className="flex flex-wrap gap-1">
          {r._perms.map((p) => (
            <Badge key={p} tone="neutral">{t(permLabelKey(p))}</Badge>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="p-8">
      <PageHeader
        title={t('page.roles.title')}
        actions={
          canManage && (
            <button
              onClick={() => setDrawer({ open: true, editing: null })}
              className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white rounded-[var(--radius-md)]"
            >
              {t('roles.add')}
            </button>
          )
        }
      />
      <DataTable rows={rows} columns={columns} loading={query.isLoading} emptyMessage="No roles yet."
        onRowClick={canManage ? (r) => setDrawer({ open: true, editing: r as Role }) : undefined} />
      <RoleFormDrawer
        open={drawer.open}
        title={drawer.editing ? `Edit ${drawer.editing.name}` : 'Add role'}
        initial={drawer.editing
          ? { name: drawer.editing.name, description: drawer.editing.description ?? '', permissions: drawer.editing.permissions }
          : null}
        onClose={() => setDrawer({ open: false, editing: null })}
        onSubmit={async (v) => {
          if (drawer.editing) {
            await patch.mutateAsync({ id: drawer.editing.id, body: v });
          } else {
            await create.mutateAsync(v);
          }
        }}
      />
      {canManage && (
        <button
          className="mt-3 text-xs text-[var(--danger-primary)] hover:underline"
          onClick={async () => {
            const id = (await create.mutationFn({ name: 'x', description: null, permissions: [] })).id;
            await del.mutateAsync(id);
          }}
          style={{ display: 'none' }}
        />
      )}
    </div>
  );
}
```

Remove the hidden delete test-button block at the bottom before committing — it was only to exercise `del` in a test; instead, surface a real per-row Delete affordance. **Revised:** replace the `<button style={{display:'none'}}…>` block with a delete column so the Delete mutation is reachable in the UI:

```tsx
  const columns = [
    { key: 'name', header: t('roles.name') },
    { key: '_label', header: t('roles.description') },
    {
      key: '_perms',
      header: t('roles.permissions'),
      render: (r: { _perms: PermissionCode[] }) => (
        <div className="flex flex-wrap gap-1">
          {r._perms.map((p) => <Badge key={p} tone="neutral">{t(permLabelKey(p))}</Badge>)}
        </div>
      ),
    },
    {
      key: '_actions',
      header: '',
      render: canManage
        ? (r: Role) => (
            <button
              className="text-xs text-[var(--danger-primary)] hover:underline"
              onClick={(e) => { e.stopPropagation(); if (confirm(t('roles.deleteConfirm'))) del.mutate(r.id); }}
            >
              {t('common.delete')}
            </button>
          )
        : undefined,
    },
  ];
```

- [ ] **Step 6: Write the RolesPage test**

Create `enterprise_server/web/tests/pages/RolesPage.test.tsx` (mirror the `UsersPage.test.tsx` harness):

```tsx
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useAuthStore } from '../../src/auth/store';
import { RolesPage } from '../../src/pages/RolesPage';

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
};

describe('pages/RolesPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] } });
  });

  test('renders seeded roles and permission labels', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: 'r1', name: 'auditor', description: 'Auditor', permissions: ['audit.view'] },
        ]),
        { status: 200 }
      )
    );
    render(wrap(<RolesPage />));
    await waitFor(() => expect(screen.getByText('auditor')).toBeInTheDocument());
    expect(screen.getByText('View audit log')).toBeInTheDocument();
  });

  test('hides Add button when user lacks org_admin', async () => {
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'u1', orgId: 'o1', roles: ['user'] } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    render(wrap(<RolesPage />));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText('+ Add role')).toBeNull();
  });
});
```

- [ ] **Step 7: Run the SPA test**

Run: `cd enterprise_server/web && npm test`
Expected: `RolesPage.test.tsx` passes (2/2); existing tests still pass. (The hidden-button block is gone; the delete affordance is a column so no test needs the removed element.)

- [ ] **Step 8: Type-check + lint the touched SPA files**

Run:
```bash
cd enterprise_server/web && npx tsc --noEmit
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/shared/permissions.ts src/api/roles.ts src/pages/RolesPage.tsx \
  src/components/RoleFormDrawer.tsx src/i18n.ts
```
Expected: clean. (If `@testing-library/react`'s `React` needs an import for the `React.ReactElement` type in the test, add `import type { ReactElement } from 'react';` and use `ReactElement`.)

- [ ] **Step 9: Commit**

```bash
git add enterprise_server/web/src/shared/permissions.ts enterprise_server/web/src/api/roles.ts \
  enterprise_server/web/src/pages/RolesPage.tsx enterprise_server/web/src/components/RoleFormDrawer.tsx \
  enterprise_server/web/src/i18n.ts enterprise_server/web/tests/pages/RolesPage.test.tsx
git commit -m "feat(enterprise_server/web): add Roles management page and permission catalog"
```

---

### Task 10: SPA — remove Positions, wire Roles route, scrub types/tests

**Files:**
- Delete: `web/src/pages/PositionsPage.tsx`, `web/src/api/positions.ts`
- Modify: `web/src/App.tsx`, `web/src/components/Sidebar.tsx`, `web/src/api/users.ts`, `web/tests/pages/UsersPage.test.tsx`
- Modify: `web/src/i18n.ts` (remove positions keys)

**Interfaces:**
- Consumes: `RolesPage` (Task 9).
- Produces: `/orgs/roles` route; no positions artifacts in the SPA.

- [ ] **Step 1: Swap the route in `App.tsx`**

In `enterprise_server/web/src/App.tsx`:
- Change `import { PositionsPage } from './pages/PositionsPage';` → `import { RolesPage } from './pages/RolesPage';`
- Change the route block:
  ```tsx
  <Route
    path="/orgs/roles"
    element={
      <AuthGuard requires="org_admin">
        <Shell><RolesPage /></Shell>
      </AuthGuard>
    }
  />
  ```
  (replacing the `/orgs/positions` block that rendered `PositionsPage`.)

- [ ] **Step 2: Swap the Sidebar nav item**

In `enterprise_server/web/src/components/Sidebar.tsx`, change the 职位 nav entry:
```ts
  { to: '/orgs/roles', label: t('nav.roles'), icon: <ShieldCheck />, section: 'org', requires: 'org_admin' },
```
and update the `lucide-react` import: remove `Briefcase` if no longer used elsewhere, add `ShieldCheck`. (If `Briefcase` is used by another nav item, keep it and just add `ShieldCheck`.)

- [ ] **Step 3: Delete the positions SPA files**

Delete `enterprise_server/web/src/pages/PositionsPage.tsx` and `enterprise_server/web/src/api/positions.ts`.

- [ ] **Step 4: Scrub `api/users.ts` types**

In `enterprise_server/web/src/api/users.ts`, remove `position_id: string | null;` from `UserRow`, `positionId?: string;` from `CreateUserInput` and `PatchUserInput`, and `effective_roles_cache: string[] | null;` from `UserRow`.

- [ ] **Step 5: Remove positions i18n keys**

In `enterprise_server/web/src/i18n.ts`, delete `nav.positions` and `page.positions.title` from **both** the `en` and `zh` blocks (4 lines total).

- [ ] **Step 6: Scrub the UsersPage test fixture**

In `enterprise_server/web/tests/pages/UsersPage.test.tsx`, remove `position_id: null,` and `effective_roles_cache: ['user'],` from the user fixture object (lines ~30-33).

- [ ] **Step 7: Run the SPA suite + type-check**

Run:
```bash
cd enterprise_server/web && npm test && npx tsc --noEmit
```
Expected: **all SPA tests pass** and `tsc` is clean (no dangling `PositionsPage`/`positions`/`position_id` references).

- [ ] **Step 8: Lint touched SPA files**

Run:
```bash
cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/App.tsx src/components/Sidebar.tsx src/api/users.ts src/i18n.ts tests/pages/UsersPage.test.tsx
```
Expected: clean.

- [ ] **Step 9: Final cross-cutting verification**

Run the full server + SPA suites and a repo-wide check for leftover references:
```bash
cd enterprise_server && npm test
cd enterprise_server/web && npm test
cd enterprise_server && rg -n "PositionsPage|positions\.ts|admin/positions|position_id|positionId|effective_roles_cache|createPosition|listPositions|computeEffectiveRoles" src tests web/src web/tests
```
Expected: server suite green, SPA suite green, and the `rg` returns **no** matches (the only allowed residue would be an explanatory comment; if the `rg` surfaces a stray reference, fix it and re-run).

- [ ] **Step 10: Commit**

```bash
git add -A enterprise_server/web
git commit -m "refactor(enterprise_server/web): replace Positions page with Roles page"
```

---

## Self-Review (run by the author before handoff)

**1. Spec coverage** — map every spec section to a task:
- §1 PermissionCode → Task 1. §2 roles table/seed → Task 2. §3 RoleResolver → Task 4. §4 requirePermission → Task 5. §5 route migration → Task 7 (roleVocabulary query rewrite in Task 8 Step 7). §6 positions drop + FK → Task 8. §7 `/me` compat → Task 8 Step 5. §8 roles API + UI → Tasks 6 (API) + 9 (UI) + 10 (wiring). §9 SPA gating → Task 10 (uses `requires="org_admin"`). §10 testing → tasks' test steps + Task 10 Step 9. Non-goals (§11) are respected (no points-in-SPA, no dynamic points, no org-scoped roles). **No gaps.**

**2. Placeholder scan** — no "TBD"/"TODO"/"similar to Task N". Every code step has full code. The two spots that were briefly hedged (RoleFormDrawer, RolesPage delete affordance) are resolved inline to concrete code.

**3. Type consistency** — `Role` (service, Task 3) matches the SPA `Role` (Task 9) and the API client; `PermissionCode` server (Task 1) matches the SPA mirror (Task 9); `requirePermission(code: PermissionCode)` (Task 5) matches all route call sites (Task 7); `roleResolver.pointsFor` is `Promise<Set<PermissionCode>>` in both the resolver (Task 4) and the middleware consumer (Task 5); `rolesApi` methods (Task 9) match the `/admin/roles` routes (Task 6). `effective_roles` field name is identical in `/me` (Task 8) and the desktop `MeView` (untouched consumer).

**4. Ambiguity** — DELETE guard fixed to "allow any delete, fail-closed" (Task 8 context + spec §8); SPA permission-point source fixed to a hand-maintained mirror (Task 9 Step 1); `requireCapability`/`requireAdmin` kept unchanged (Task 5 Step 3); lint cleanup scoped to touched files (Task 7). `roleResolver.pointsFor` is async (Task 4) and awaited in the middleware (Task 5) — no sync/async mismatch.

**Ordering note for the executor:** Tasks 1-7 build the RBAC surface (each ends green in isolation). Task 8 is the positions-removal unit and is the first task where the **entire** server suite must be green together. Tasks 9-10 are additive-then-subtractive for the SPA and both end with the full SPA suite green.
