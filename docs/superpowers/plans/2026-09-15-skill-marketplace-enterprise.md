# Enterprise-Hosted Skills Catalog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the desktop Skills "企业/Enterprise" tab to a role-scoped, enterprise-hosted skill catalog (server route + admin SPA two-column page + JWT download), and delete the old free-text skill-policies feature.

**Architecture:** Mirror the existing MCP-connector marketplace end-to-end. The server gains a `skill_marketplace` catalog (categories + skills + `allowed_roles` + on-disk `.zip`), a public role-filtered catalog route, and an admin CRUD + zip-upload route gated on a renamed `skills.manage` permission. The desktop 企业 tab fetches the catalog with a JWT and downloads the `.zip` with a JWT. The old `skill_policies` feature is removed.

**Tech Stack:** enterprise_server (Hono + pglite/Postgres + Zod + `adm-zip`), admin SPA (React 19 + TanStack Query + Zustand + Vitest/jsdom), desktop (Electron + React, Vitest).

**Spec:** `docs/superpowers/specs/2026-09-15-skill-marketplace-enterprise-design.md`

## Global Constraints

- **Two apps, one repo.** `enterprise_server/` (server + SPA) and the desktop at repo root. Coupled only by HTTP; the desktop is enterprise-only (`ENTERPRISE_SERVER_URL` required, thrown-on-unset by `src/main/libs/endpoints.ts`).
- **Migrations are idempotent.** `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `?`-guarded `UPDATE`s. The test harness replays every migration file on a fresh schema with **no** `_migrations` ledger; re-runs must not trip constraints. `testPool.query` is one statement per call. Next free migration number: **023**.
- **i18n (SPA):** every new user-visible string needs an `en` and a `zh` key. `t(key)` takes only a key; use `fill(msg, vars)` for templates (see `web/src/pages/mcpManage/types.ts`).
- **Fail-closed auth.** Unknown role → zero access; only `super_admin` bypasses the `allowed_roles` filter. Public catalog + download are `requireAuth`; download additionally 403s when the caller's roles don't intersect `allowed_roles`.
- **Quality gates:** touched files lint-clean (`npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`), `npx tsc --noEmit`, Conventional Commits in English, no `Co-Authored-By` trailers.
- **Test commands:** server → `cd enterprise_server && npx vitest run --no-file-parallelism`; SPA → `cd enterprise_server/web && npx vitest run`; desktop → `npx vitest run` from repo root (do **not** run the whole Electron suite unless a test lives there — run the specific file).
- **SPA is a hand-maintained mirror** of the server `PermissionCode` catalog (`web/src/shared/permissions.ts`); it never imports from server `src/`.
- The role **name stays `policy_admin`** (a load-bearing literal in `App.tsx`, `Sidebar.tsx`, `roleVocabulary.ts`). Only its permission array changes.

---

### Task 1: Migration 023 — catalog tables, seed, permission backfill, old-table drop

**Files:**
- Create: `enterprise_server/src/db/migrations/023_skill_marketplace.sql`
- Test: `enterprise_server/tests/db/migrate.test.ts` (append)

**Interfaces:**
- Produces: tables `skill_marketplace_categories(category_id,name_zh,name_en,display_order)`, `skill_marketplace_skills(skill_id,name_en,name_zh,description_en,description_zh,icon,version,category_id,source_json,allowed_roles,enabled,created_at,updated_at)`; a seeded `uncategorized` category; `roles.permissions` backfilled from `policies.manage`→`skills.manage`; `skill_policies` dropped.

- [ ] **Step 1: Write the failing migration test**

Append to `enterprise_server/tests/db/migrate.test.ts` (reuse its existing `resetSchema`/`runMigrations`/`testPool` imports — read the file's existing helpers first and match its style):

```ts
test('023 creates skill_marketplace tables, seeds uncategorized, backfills skills.manage, drops skill_policies', async () => {
  // Seed a pre-existing role carrying the OLD permission code, like a live DB would.
  await testPool.query(
    `INSERT INTO roles (id, name, description, permissions)
     VALUES ('r-legacy', 'legacy_policy', 'x', '["policies.manage"]'::jsonb)`,
  );
  await runMigrations();

  // Tables exist.
  const t = await testPool.query(
    `SELECT to_regclass('public.skill_marketplace_categories') AS c,
            to_regclass('public.skill_marketplace_skills') AS s,
            to_regclass('public.skill_policies') AS old`,
  );
  expect(t.rows[0].c).toBeTruthy();
  expect(t.rows[0].s).toBeTruthy();
  expect(t.rows[0].old).toBeFalsy(); // dropped

  // Reserved category seeded.
  const cat = await testPool.query(
    `SELECT name_zh, name_en FROM skill_marketplace_categories WHERE category_id = 'uncategorized'`,
  );
  expect(cat.rows[0]).toEqual({ name_zh: '未分类', name_en: 'Uncategorized' });

  // Backfill swapped the code in the legacy role.
  const role = await testPool.query(
    `SELECT permissions FROM roles WHERE name = 'legacy_policy'`,
  );
  expect(role.rows[0].permissions).toEqual(['skills.manage']);

  // Idempotent: replaying the backfill is a no-op (still one entry, not duplicated).
  const again = await testPool.query(
    `SELECT permissions FROM roles WHERE name = 'legacy_policy'`,
  );
  expect(again.rows[0].permissions).toEqual(['skills.manage']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/db/migrate.test.ts`
Expected: FAIL — `skill_marketplace_categories` / `skill_marketplace_skills` don't exist (or the assertion on the dropped table / backfill fails).

- [ ] **Step 3: Write the migration file**

Create `enterprise_server/src/db/migrations/023_skill_marketplace.sql`:

```sql
-- v1
-- Skill marketplace catalog (mirrors 012/018 MCP marketplace).
-- One file: catalog tables + seed + permission-code backfill + old-table drop.

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

-- Reserved bucket. Always present so skills always have a valid category to
-- assign; deleting any other category re-homes its skills here.
INSERT INTO skill_marketplace_categories (category_id, name_zh, name_en, display_order)
VALUES ('uncategorized', '未分类', 'Uncategorized', 0)
ON CONFLICT (category_id) DO NOTHING;

-- Rename the permission code for already-deployed DBs (019 is edited directly
-- for fresh DBs). Guarded by `?` so it is a no-op once migrated.
UPDATE roles
   SET permissions = (
       SELECT jsonb_agg(
                CASE WHEN el = 'policies.manage' THEN 'skills.manage'::jsonb ELSE el END
              )
       FROM jsonb_array_elements(permissions) el
     )
 WHERE permissions ? 'policies.manage';

-- Delete the old free-text skill-policies feature (decision: delete, not merge).
DROP TABLE IF EXISTS skill_policies;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/db/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/db/migrations/023_skill_marketplace.sql enterprise_server/tests/db/migrate.test.ts
git commit -m "feat(enterprise_server): add skill marketplace catalog migration 023

Creates skill_marketplace_categories/skills, seeds the uncategorized
category, backfills the policies.manage -> skills.manage code rename on
live DBs, and drops the old skill_policies table."
```

---

### Task 2: Rename permission code + delete old skill-policies feature (server)

**Files:**
- Modify: `enterprise_server/src/shared/enterpriseServerConstants.ts:14`
- Modify: `enterprise_server/src/db/migrations/019_rbac.sql:21-22`
- Modify: `enterprise_server/src/server.ts` (remove `adminPolicyRoutes`/`policiesRoutes` imports + registrations)
- Modify: `enterprise_server/tests/auth/roleResolver.test.ts`, `enterprise_server/tests/shared/permissionCodes.test.ts`
- Delete: `enterprise_server/src/routes/policies.ts`, `enterprise_server/src/routes/admin/policies.ts`, `enterprise_server/src/policies/policyStore.ts`, `enterprise_server/src/policies/scope.ts`, **and** `enterprise_server/tests/policies/policyStore.test.ts` (it imports `policyStore` + `scope`, which no longer exist)
- Test: (updated) `tests/shared/permissionCodes.test.ts`, `tests/auth/roleResolver.test.ts`

**Interfaces:**
- Consumes: Task 1's backfill (019 now seeds the new code for fresh DBs; both stay consistent).
- Produces: `PermissionCode.SkillsManage === 'skills.manage'`; no `/policies/*` or `/admin/policies/*` routes resolve.

- [ ] **Step 1: Confirm `scope.ts` has no other importers, and `policies` routes are skill-only**

Run: `cd enterprise_server && rg -n "policies/scope|from '../policies|from '../../policies|policyStore|adminPolicyRoutes|policiesRoutes" src/ tests/`
Expected: `scope.ts` imported only by `src/routes/policies.ts`; `policyStore` used only by the two policies routes; no `/policies/mcp` or `/policies/model`. If `scope.ts` has an unexpected importer, STOP and note it.

- [ ] **Step 2: Rename the code in the constants**

In `enterprise_server/src/shared/enterpriseServerConstants.ts`, change line 14:
`PoliciesManage: 'policies.manage',` → `SkillsManage: 'skills.manage',`

- [ ] **Step 3: Edit the 019 seed (fresh DB)**

In `enterprise_server/src/db/migrations/019_rbac.sql`, change the `policy_admin` INSERT (lines ~20-23):
```sql
INSERT INTO roles(id, name, description, permissions)
VALUES (gen_random_uuid(), 'policy_admin', 'Skill catalog administrator',
        '["skills.manage"]'::jsonb)
ON CONFLICT (name) DO NOTHING;
```
(Keep the role name `policy_admin`; only the description and the permission change.)

- [ ] **Step 4: Delete the old policy routes + store + scope, their test, and unwire them**

Delete these files (both route files are skill-only — `/policies/skill` and `/admin/policies/skill*`; there is no `/policies/mcp` or `/policies/model` route, and `policyStore`/`scope` are imported only by these two routes plus the test below):
`src/routes/policies.ts`, `src/routes/admin/policies.ts`, `src/policies/policyStore.ts`, `src/policies/scope.ts`, and `tests/policies/policyStore.test.ts`.

In `src/server.ts`, remove the imports `import { adminPolicyRoutes } from './routes/admin/policies';` and `import { policiesRoutes } from './routes/policies';`, and their `app.route('/', adminPolicyRoutes)` / `app.route('/', policiesRoutes)` lines.

- [ ] **Step 5: Update the rename tests**

- `tests/shared/permissionCodes.test.ts:12`: `expect(PermissionCode.PoliciesManage).toBe('policies.manage')` → `expect(PermissionCode.SkillsManage).toBe('skills.manage')`.
- `tests/auth/roleResolver.test.ts:23`: the negative assertion `expect(pts.has('policies.manage')).toBe(false)` (org_admin + auditor do not hold the skill point) → `expect(pts.has('skills.manage')).toBe(false)`. Intent unchanged; only the code string moves.

- [ ] **Step 6: Run the affected tests**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/shared/permissionCodes.test.ts tests/auth/roleResolver.test.ts tests/db/migrate.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + lint**

Run: `cd enterprise_server && npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/shared/enterpriseServerConstants.ts src/server.ts`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add -A enterprise_server/src enterprise_server/tests
git commit -m "refactor(enterprise_server): rename policies.manage to skills.manage and drop skill-policies

Renames the permission code (fresh seed in 019 + live backfill from
023) and deletes the old free-text skill-policies routes, policyStore,
scope module, and the skill_policies table consumer."
```

---

### Task 3: File-storage helper + skill marketplace view/model

**Files:**
- Modify: `enterprise_server/src/lib/stateDir.ts`
- Create: `enterprise_server/src/models/skillMarketplaceView.ts`
- Test: `enterprise_server/tests/models/skillMarketplaceView.test.ts` (create), and a `stateDir` assertion

**Interfaces:**
- Consumes: nothing from prior tasks (pure types + a path helper).
- Produces: `skillStoreDir(id)`, and `UNCATEGORIZED`, `SKILL_COLUMNS`, `SkillRow`, `CategoryRow`, `SkillMarketplaceView`, `mapSkill(row)` — consumed by Tasks 4 and 5.

- [ ] **Step 1: Add the storage-dir helper**

In `enterprise_server/src/lib/stateDir.ts`, after `htmlShareDir`:
```ts
export function skillStoreDir(skillId: string): string {
  return join(_stateDir, 'skill-marketplace', skillId);
}
```

- [ ] **Step 2: Write the failing view test**

Create `enterprise_server/tests/models/skillMarketplaceView.test.ts`:
```ts
import { describe, expect, test } from 'vitest';

import { mapSkill, UNCATEGORIZED } from '../../src/models/skillMarketplaceView';

describe('skillMarketplaceView', () => {
  test('UNCATEGORIZED is the reserved slug', () => {
    expect(UNCATEGORIZED).toBe('uncategorized');
  });

  test('mapSkill maps row -> wire view, preferring zh description', () => {
    const v = mapSkill({
      skill_id: 'canvas-design',
      name_en: 'Canvas Design',
      name_zh: '画布设计',
      description_en: 'desc en',
      description_zh: '描述 zh',
      icon: null,
      version: '1.2.0',
      category_id: 'design',
      source_json: { from: 'GitHub', url: 'https://x/repo' },
      allowed_roles: ['org_admin', 'user'],
      enabled: true,
    });
    expect(v).toEqual({
      id: 'canvas-design',
      name: 'Canvas Design',
      name_zh: '画布设计',
      description: '描述 zh',
      category: 'design',
      version: '1.2.0',
      icon: null,
      source: { from: 'GitHub', url: 'https://x/repo' },
      allowed_roles: ['org_admin', 'user'],
      enabled: true,
    });
  });

  test('mapSkill falls back to en description and null source', () => {
    const v = mapSkill({
      skill_id: 's1', name_en: 'S1', name_zh: null,
      description_en: 'en only', description_zh: null,
      icon: 'https://i/x.png', version: null,
      category_id: UNCATEGORIZED, source_json: null,
      allowed_roles: ['user'], enabled: false,
    });
    expect(v.description).toBe('en only');
    expect(v.source).toBeNull();
    expect(v.category).toBe('uncategorized');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/models/skillMarketplaceView.test.ts`
Expected: FAIL — module `skillMarketplaceView` not found.

- [ ] **Step 4: Write the view model**

Create `enterprise_server/src/models/skillMarketplaceView.ts` (mirror `src/models/mcpMarketplaceView.ts`):
```ts
export const UNCATEGORIZED = 'uncategorized' as const;

/** Single source of the SELECT column list used by the public catalog and
 *  the admin list route. Keep in sync with the 023 schema. */
export const SKILL_COLUMNS = `skill_id, name_en, name_zh, description_en, description_zh,
  icon, version, category_id, source_json, allowed_roles, enabled`;

/** DB row shape for a marketplace skill (post-023). */
export interface SkillRow {
  skill_id: string;
  name_en: string;
  name_zh: string | null;
  description_en: string;
  description_zh: string | null;
  icon: string | null;
  version: string | null;
  category_id: string;
  source_json: { from?: string; url?: string; author?: string } | null;
  allowed_roles: string[];
  enabled: boolean;
}

/** DB row shape for a marketplace category (same as MCP). */
export interface CategoryRow {
  category_id: string;
  name_zh: string;
  name_en: string;
  display_order: number;
}

/** Wire shape returned by both the public catalog and the admin list. The
 *  download URL is NOT here — the desktop main process assembles it from the
 *  base URL + id. */
export interface SkillMarketplaceView {
  id: string;
  name: string;
  name_zh: string | null;
  description: string;
  category: string;
  version: string | null;
  icon: string | null;
  source: { from?: string; url?: string; author?: string } | null;
  allowed_roles: string[];
  enabled: boolean;
}

export function mapSkill(row: SkillRow): SkillMarketplaceView {
  return {
    id: row.skill_id,
    name: row.name_en,
    name_zh: row.name_zh,
    description: row.description_zh ?? row.description_en,
    category: row.category_id,
    version: row.version,
    icon: row.icon,
    source: row.source_json ?? null,
    allowed_roles: row.allowed_roles,
    enabled: row.enabled,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/models/skillMarketplaceView.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

Run: `cd enterprise_server && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/lib/stateDir.ts src/models/skillMarketplaceView.ts`

```bash
git add enterprise_server/src/lib/stateDir.ts enterprise_server/src/models/skillMarketplaceView.ts enterprise_server/tests/models/skillMarketplaceView.test.ts
git commit -m "feat(enterprise_server): add skill marketplace view model and skillStoreDir"
```

---

### Task 4: Public catalog + download route

**Files:**
- Create: `enterprise_server/src/routes/skillMarketplace.ts`
- Modify: `enterprise_server/src/server.ts`
- Test: `enterprise_server/tests/routes/skillMarketplace.test.ts` (create)

**Interfaces:**
- Consumes: `mapSkill`, `SKILL_COLUMNS`, `SkillRow`, `CategoryRow`, `UNCATEGORIZED` (Task 3); `skillStoreDir` (Task 3); tables (Task 1); `Role.SuperAdmin` from `../shared/enterpriseServerConstants`.
- Produces: `GET /api/skill-marketplace` → `{ categories, skills }` (enabled + role-visible); `GET /api/skill-marketplace/download/:id` → zip bytes / 403 / 404.

- [ ] **Step 1: Write the failing route test**

Create `enterprise_server/tests/routes/skillMarketplace.test.ts` (mirror `tests/routes/mcpMarketplace.test.ts` — read it first for the exact `signToken`/`testPool`/app-setup idiom):
```ts
import '../helpers/setupEnv';

import { AdmZip } from 'adm-zip';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';
import { join } from 'node:path';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { skillStoreDir } from '../../src/lib/stateDir';
import { skillMarketplaceRoutes } from '../../src/routes/skillMarketplace';

const app = new Hono();
app.route('/', skillMarketplaceRoutes);

const tokenFor = async (roles: string[]): Promise<string> => signToken({ sub: 'u1', orgId: 'o1', roles });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function seedSkill(overrides: Record<string, unknown> = {}): Promise<void> {
  await testPool.query(`INSERT INTO skill_marketplace_skills
    (skill_id, name_en, description_en, category_id, allowed_roles, enabled)
    VALUES ($1,$2,$3,'uncategorized',$4::jsonb,$5)`,
    ['sk1', 'Canvas', 'd', JSON.stringify(['user', 'org_admin']), true]);
}

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
});

describe('GET /api/skill-marketplace', () => {
  test('401 without a token', async () => {
    expect((await app.request('/api/skill-marketplace')).status).toBe(401);
  });

  test('returns only enabled skills whose allowed_roles intersect the caller', async () => {
    await testPool.query(`INSERT INTO skill_marketplace_skills
      (skill_id, name_en, description_en, category_id, allowed_roles, enabled)
      VALUES ('a','A','d','uncategorized','["user"]'::jsonb,TRUE),
             ('b','B','d','uncategorized','["model_admin"]'::jsonb,TRUE),
             ('c','C','d','uncategorized','["user"]'::jsonb,FALSE)`);
    const res = await app.request('/api/skill-marketplace', { headers: auth(await tokenFor(['user'])) });
    expect(res.status).toBe(200);
    const body = await res.json() as { skills: Array<{ id: string }>; categories: Array<{ id: string }> };
    expect(body.skills.map(s => s.id)).toEqual(['a']); // b (no role), c (disabled) excluded
    expect(body.categories.map(c => c.id)).toEqual(['uncategorized']);
  });

  test('super_admin sees every enabled skill', async () => {
    await testPool.query(`INSERT INTO skill_marketplace_skills
      (skill_id, name_en, description_en, category_id, allowed_roles, enabled)
      VALUES ('a','A','d','uncategorized','["model_admin"]'::jsonb,TRUE)`);
    const res = await app.request('/api/skill-marketplace', { headers: auth(await tokenFor(['super_admin'])) });
    const body = await res.json() as { skills: Array<{ id: string }> };
    expect(body.skills.map(s => s.id)).toEqual(['a']);
  });
});

describe('GET /api/skill-marketplace/download/:id', () => {
  async function writeZip(id: string): Promise<void> {
    const zip = new AdmZip();
    zip.file('SKILL.md', '# Skill');
    mkdirSync(skillStoreDir(id), { recursive: true });
    writeFileSync(join(skillStoreDir(id), 'skill.zip'), zip.toBuffer());
  }

  test('404 for a disabled skill', async () => {
    await seedSkill();
    await testPool.query(`UPDATE skill_marketplace_skills SET enabled=FALSE WHERE skill_id='sk1'`);
    const res = await app.request('/api/skill-marketplace/download/sk1', { headers: auth(await tokenFor(['user'])) });
    expect(res.status).toBe(404);
  });

  test('403 when the caller lacks the allowed role', async () => {
    await seedSkill();
    const res = await app.request('/api/skill-marketplace/download/sk1', { headers: auth(await tokenFor(['model_admin'])) });
    expect(res.status).toBe(403);
  });

  test('404 when the file is absent', async () => {
    await seedSkill();
    const res = await app.request('/api/skill-marketplace/download/sk1', { headers: auth(await tokenFor(['user'])) });
    expect(res.status).toBe(404);
  });

  test('200 streams the uploaded zip with zip headers', async () => {
    await seedSkill();
    await writeZip('sk1');
    const res = await app.request('/api/skill-marketplace/download/sk1', { headers: auth(await tokenFor(['user'])) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/routes/skillMarketplace.test.ts`
Expected: FAIL — module `routes/skillMarketplace` not found.

- [ ] **Step 3: Implement the route**

Create `enterprise_server/src/routes/skillMarketplace.ts` (mirror `src/routes/mcpMarketplace.ts`):
```ts
import { readFile } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { pool } from '../db/pool';
import {
  type CategoryRow,
  mapSkill,
  SKILL_COLUMNS,
  type SkillRow,
} from '../models/skillMarketplaceView';
import { Role } from '../shared/enterpriseServerConstants';
import { skillStoreDir } from '../lib/stateDir';

export const skillMarketplaceRoutes = new Hono();
skillMarketplaceRoutes.use('/api/skill-marketplace', requireAuth);

skillMarketplaceRoutes.get('/api/skill-marketplace', async (c) => {
  const claims = c.get('claims');
  const userRoles = claims?.roles ?? [];
  const isSuperAdmin = userRoles.includes(Role.SuperAdmin);

  const rows = await pool.query<SkillRow>(
    `SELECT ${SKILL_COLUMNS} FROM skill_marketplace_skills WHERE enabled = TRUE ORDER BY skill_id`,
  );
  const userRoleSet = new Set(userRoles);
  const visible = rows.rows.filter(
    row => isSuperAdmin || row.allowed_roles.some(r => userRoleSet.has(r)),
  );

  const visibleCategoryIds = Array.from(new Set(visible.map(s => s.category_id)));
  const categoriesResult = visibleCategoryIds.length === 0
    ? { rows: [] as CategoryRow[] }
    : await pool.query<CategoryRow>(
        `SELECT category_id, name_zh, name_en, display_order
           FROM skill_marketplace_categories
          WHERE category_id = ANY($1) ORDER BY display_order, category_id`,
        [visibleCategoryIds],
      );
  const categories = categoriesResult.rows.map(row => ({
    id: row.category_id, name_zh: row.name_zh, name_en: row.name_en,
  }));

  return c.json({ categories, skills: visible.map(mapSkill) });
});

skillMarketplaceRoutes.get('/api/skill-marketplace/download/:id', async (c) => {
  const id = c.req.param('id');
  const claims = c.get('claims');
  const userRoles = claims?.roles ?? [];
  const isSuperAdmin = userRoles.includes(Role.SuperAdmin);

  const r = await pool.query<{ enabled: boolean; allowed_roles: string[] }>(
    'SELECT enabled, allowed_roles FROM skill_marketplace_skills WHERE skill_id = $1', [id]);
  const row = r.rows[0];
  if (!row || !row.enabled) return c.json({ error: 'not_found' }, 404);
  const allowed = isSuperAdmin || row.allowed_roles.some(role => userRoles.includes(role));
  if (!allowed) return c.json({ error: 'forbidden' }, 403);

  const file = join(skillStoreDir(id), 'skill.zip');
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.body(buf, 200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${id}.zip"`,
  });
});
```

- [ ] **Step 4: Wire the route in `server.ts`**

Add the import next to the MCP ones: `import { skillMarketplaceRoutes } from './routes/skillMarketplace';`
Add the registration next to `app.route('/', mcpMarketplaceRoutes);`: `app.route('/', skillMarketplaceRoutes);`

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/routes/skillMarketplace.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

Run: `cd enterprise_server && npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/routes/skillMarketplace.ts src/server.ts`

```bash
git add enterprise_server/src/routes/skillMarketplace.ts enterprise_server/src/server.ts enterprise_server/tests/routes/skillMarketplace.test.ts
git commit -m "feat(enterprise_server): add role-scoped skill catalog and zip download routes"
```

---

### Task 5: Admin routes (categories + skills + zip upload)

**Files:**
- Create: `enterprise_server/src/routes/skillMarketplaceAdmin.ts`
- Modify: `enterprise_server/src/server.ts`
- Test: `enterprise_server/tests/routes/skillMarketplaceAdmin.test.ts` (create)

**Interfaces:**
- Consumes: `SkillMarketplaceView`/`mapSkill`/`SKILL_COLUMNS`/`SkillRow`/`UNCATEGORIZED` (Task 3); `skillStoreDir` (Task 3); `PermissionCode.SkillsManage` (Task 2); `requirePermission`, `requireAuth`.
- Produces: `/api/admin/skill-marketplace/categories` CRUD, `/api/admin/skill-marketplace/skills` CRUD, `POST …/skills/:id/zip`.

- [ ] **Step 1: Write the failing route test**

Create `enterprise_server/tests/routes/skillMarketplaceAdmin.test.ts` (mirror `tests/routes/mcpMarketplaceAdmin.test.ts` for the `signToken`/admin-app idiom; use `skills.manage` role for auth). Cover at minimum:
```ts
import '../helpers/setupEnv';

import { AdmZip } from 'adm-zip';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { skillMarketplaceAdminRoutes } from '../../src/routes/skillMarketplaceAdmin';

const app = new Hono();
app.route('/', skillMarketplaceAdminRoutes);

const admin = async () => signToken({ sub: 'a', orgId: 'o1', roles: ['super_admin'] });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const json = { 'content-type': 'application/json' };

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
});

describe('categories', () => {
  test('create, list, update, delete; delete re-homes skills; reserved 409', async () => {
    const tok = await admin();
    let res = await app.request('/api/admin/skill-marketplace/categories', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ category_id: 'design', name_zh: '设计', name_en: 'Design' }),
    });
    expect(res.status).toBe(200);

    res = await app.request('/api/admin/skill-marketplace/categories', { headers: auth(tok) });
    const cats = await res.json() as Array<{ id: string }>;
    expect(cats.map(c => c.id)).toContain('design');

    // a skill in design, then delete the category
    res = await app.request('/api/admin/skill-marketplace/skills', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ skill_id: 's1', name_en: 'S', description_en: 'd',
        category_id: 'design', allowed_roles: ['org_admin'] }),
    });
    expect(res.status).toBe(200);

    res = await app.request('/api/admin/skill-marketplace/categories/design', { method: 'DELETE', headers: auth(tok) });
    expect(res.status).toBe(204);
    const moved = await testPool.query(`SELECT category_id FROM skill_marketplace_skills WHERE skill_id='s1'`);
    expect(moved.rows[0].category_id).toBe('uncategorized');

    // deleting the reserved bucket is rejected
    res = await app.request('/api/admin/skill-marketplace/categories/uncategorized', { method: 'DELETE', headers: auth(tok) });
    expect(res.status).toBe(409);
  });

  test('unknown category on skill create -> 400', async () => {
    const tok = await admin();
    const res = await app.request('/api/admin/skill-marketplace/skills', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ skill_id: 's2', name_en: 'S', description_en: 'd',
        category_id: 'nope', allowed_roles: ['org_admin'] }),
    });
    expect(res.status).toBe(400);
  });

  test('empty allowed_roles -> 400', async () => {
    const tok = await admin();
    const res = await app.request('/api/admin/skill-marketplace/skills', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ skill_id: 's3', name_en: 'S', description_en: 'd',
        category_id: 'uncategorized', allowed_roles: [] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('zip upload', () => {
  test('rejects an empty body (400) and a good zip (200)', async () => {
    const tok = await admin();
    await app.request('/api/admin/skill-marketplace/skills', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ skill_id: 's1', name_en: 'S', description_en: 'd',
        category_id: 'uncategorized', allowed_roles: ['org_admin'] }),
    });
    let res = await app.request('/api/admin/skill-marketplace/skills/s1/zip', {
      method: 'POST', headers: auth(tok), body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);

    const zip = new AdmZip(); zip.file('SKILL.md', '# S');
    res = await app.request('/api/admin/skill-marketplace/skills/s1/zip', {
      method: 'POST', headers: { ...auth(tok), 'content-type': 'application/zip' },
      body: zip.toBuffer(),
    });
    expect(res.status).toBe(200);
  });

  test('rejects a zip without SKILL.md (400 bad_zip)', async () => {
    const tok = await admin();
    await app.request('/api/admin/skill-marketplace/skills', {
      method: 'POST', headers: { ...auth(tok), ...json },
      body: JSON.stringify({ skill_id: 's4', name_en: 'S', description_en: 'd',
        category_id: 'uncategorized', allowed_roles: ['org_admin'] }),
    });
    const zip = new AdmZip(); zip.file('other.txt', 'hi');
    const res = await app.request('/api/admin/skill-marketplace/skills/s4/zip', {
      method: 'POST', headers: auth(tok), body: zip.toBuffer(),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/routes/skillMarketplaceAdmin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the admin routes**

Create `enterprise_server/src/routes/skillMarketplaceAdmin.ts` (mirror `src/routes/mcpMarketplaceAdmin.ts` — copy its category CRUD, adapting table name to `skill_marketplace_categories`/`skill_marketplace_skills`; copy its `serverWriteSchema`/`serverPatch`/dynamic-`push` pattern for skills):
```ts
import AdmZip from 'adm-zip';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import {
  mapSkill,
  SKILL_COLUMNS,
  type SkillRow,
  UNCATEGORIZED,
} from '../models/skillMarketplaceView';
import { PermissionCode } from '../shared/enterpriseServerConstants';
import { skillStoreDir } from '../lib/stateDir';

const MAX_BYTES = 50 * 1024 * 1024;

const sourceSchema = z.object({
  from: z.string().optional(), url: z.string().optional(), author: z.string().optional(),
}).optional();

const skillWriteSchema = z.object({
  skill_id: z.string().min(1),
  name_en: z.string().min(1),
  name_zh: z.string().optional(),
  description_en: z.string().min(1),
  description_zh: z.string().optional(),
  icon: z.string().optional(),
  version: z.string().optional(),
  category_id: z.string().min(1),
  source: sourceSchema,
  allowed_roles: z.array(z.string().min(1)).min(1),
});

const skillPatch = z.object({
  name_en: z.string().min(1).optional(),
  name_zh: z.string().optional(),
  description_en: z.string().min(1).optional(),
  description_zh: z.string().optional(),
  icon: z.string().optional(),
  version: z.string().optional(),
  category_id: z.string().min(1).optional(),
  source: sourceSchema,
  allowed_roles: z.array(z.string().min(1)).min(1).optional(),
  enabled: z.boolean().optional(),
});

async function categoryExists(categoryId: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM skill_marketplace_categories WHERE category_id = $1) AS exists',
    [categoryId]);
  return r.rows[0]?.exists === true;
}

export const skillMarketplaceAdminRoutes = new Hono();
skillMarketplaceAdminRoutes.use('/api/admin/skill-marketplace/*', requireAuth);
skillMarketplaceAdminRoutes.use('/api/admin/skill-marketplace/*', requirePermission(PermissionCode.SkillsManage));

// --- Skills ---
skillMarketplaceAdminRoutes.post('/api/admin/skill-marketplace/skills', async (c) => {
  const parsed = skillWriteSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  if (!(await categoryExists(b.category_id))) return c.json({ error: 'unknown_category' }, 400);
  if (b.allowed_roles.length === 0) return c.json({ error: 'no_roles' }, 400);
  await pool.query(
    `INSERT INTO skill_marketplace_skills
       (skill_id, name_en, name_zh, description_en, description_zh, icon, version,
        category_id, source_json, allowed_roles, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,TRUE)`,
    [b.skill_id, b.name_en, b.name_zh ?? null, b.description_en, b.description_zh ?? null,
     b.icon ?? null, b.version ?? null, b.category_id, JSON.stringify(b.source ?? null),
     JSON.stringify(b.allowed_roles)],
  );
  return c.json({ skill_id: b.skill_id });
});

skillMarketplaceAdminRoutes.put('/api/admin/skill-marketplace/skills/:skillId', async (c) => {
  const id = c.req.param('skillId');
  const parsed = skillPatch.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  if (b.category_id && !(await categoryExists(b.category_id))) return c.json({ error: 'unknown_category' }, 400);
  if (b.allowed_roles !== undefined && b.allowed_roles.length === 0) return c.json({ error: 'no_roles' }, 400);

  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.name_en !== undefined) push('name_en', b.name_en);
  if (b.name_zh !== undefined) push('name_zh', b.name_zh);
  if (b.description_en !== undefined) push('description_en', b.description_en);
  if (b.description_zh !== undefined) push('description_zh', b.description_zh);
  if (b.icon !== undefined) push('icon', b.icon);
  if (b.version !== undefined) push('version', b.version);
  if (b.category_id !== undefined) push('category_id', b.category_id);
  if (b.source !== undefined) push('source_json', JSON.stringify(b.source ?? null));
  if (b.allowed_roles !== undefined) push('allowed_roles', JSON.stringify(b.allowed_roles));
  if (b.enabled !== undefined) push('enabled', b.enabled);

  if (sets.length === 0) return c.json({ error: 'empty_patch' }, 400);
  const result = await pool.query(
    `UPDATE skill_marketplace_skills SET ${sets.join(', ')}, updated_at = NOW() WHERE skill_id = $1`, params);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

skillMarketplaceAdminRoutes.delete('/api/admin/skill-marketplace/skills/:skillId', async (c) => {
  const id = c.req.param('skillId');
  const result = await pool.query('DELETE FROM skill_marketplace_skills WHERE skill_id = $1', [id]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  rmSync(skillStoreDir(id), { recursive: true, force: true });
  return c.body(null, 204);
});

skillMarketplaceAdminRoutes.get('/api/admin/skill-marketplace/skills', async (c) => {
  const r = await pool.query<SkillRow>(`SELECT ${SKILL_COLUMNS} FROM skill_marketplace_skills ORDER BY skill_id`);
  return c.json(r.rows.map(mapSkill));
});

// --- Zip upload / replace ---
skillMarketplaceAdminRoutes.post('/api/admin/skill-marketplace/skills/:skillId/zip', async (c) => {
  const id = c.req.param('skillId');
  const exists = await pool.query('SELECT 1 FROM skill_marketplace_skills WHERE skill_id = $1', [id]);
  if (exists.rowCount === 0) return c.json({ error: 'not_found' }, 404);

  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.byteLength === 0) return c.json({ error: 'empty' }, 400);
  if (buf.byteLength > MAX_BYTES) return c.json({ error: 'too_large' }, 413);

  let hasSkillMd = false;
  try {
    const zip = new AdmZip(buf);
    hasSkillMd = zip.getEntries().some((e) => !e.isDirectory && /(^|\/)SKILL\.md$/i.test(e.entryName));
  } catch {
    return c.json({ error: 'bad_zip' }, 400);
  }
  if (!hasSkillMd) return c.json({ error: 'bad_zip' }, 400);

  rmSync(skillStoreDir(id), { recursive: true, force: true });
  mkdirSync(skillStoreDir(id), { recursive: true });
  writeFileSync(join(skillStoreDir(id), 'skill.zip'), buf);
  return c.json({ status: 'uploaded' });
});

// --- Categories (mirror MCP admin) ---
const categoryWriteSchema = z.object({
  category_id: z.string().min(1),
  name_zh: z.string().min(1),
  name_en: z.string().min(1),
  display_order: z.number().int().optional(),
});
const categoryPatchSchema = categoryWriteSchema.partial();

skillMarketplaceAdminRoutes.get('/api/admin/skill-marketplace/categories', async (c) => {
  const r = await pool.query<{ category_id: string; name_zh: string; name_en: string; display_order: number }>(
    'SELECT category_id, name_zh, name_en, display_order FROM skill_marketplace_categories ORDER BY display_order, category_id');
  return c.json(r.rows.map((row) => ({ id: row.category_id, name_zh: row.name_zh, name_en: row.name_en, display_order: row.display_order })));
});

skillMarketplaceAdminRoutes.post('/api/admin/skill-marketplace/categories', async (c) => {
  const parsed = categoryWriteSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  await pool.query(
    `INSERT INTO skill_marketplace_categories (category_id, name_zh, name_en, display_order)
     VALUES ($1,$2,$3,COALESCE($4,0)) ON CONFLICT (category_id) DO NOTHING`,
    [parsed.data.category_id, parsed.data.name_zh, parsed.data.name_en, parsed.data.display_order ?? null]);
  return c.json({ category_id: parsed.data.category_id });
});

skillMarketplaceAdminRoutes.put('/api/admin/skill-marketplace/categories/:categoryId', async (c) => {
  const id = c.req.param('categoryId');
  const parsed = categoryPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const result = await pool.query(
    `UPDATE skill_marketplace_categories SET
       name_zh = COALESCE($2, name_zh), name_en = COALESCE($3, name_en),
       display_order = COALESCE($4, display_order) WHERE category_id = $1`,
    [id, parsed.data.name_zh ?? null, parsed.data.name_en ?? null, parsed.data.display_order ?? null]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

// Migrate-on-delete: re-home the category's skills into 未分类, then delete it.
skillMarketplaceAdminRoutes.delete('/api/admin/skill-marketplace/categories/:categoryId', async (c) => {
  const id = c.req.param('categoryId');
  if (id === UNCATEGORIZED) return c.json({ error: 'reserved_category' }, 409);
  await pool.query(
    `UPDATE skill_marketplace_skills SET category_id = $1 WHERE category_id = $2`, [UNCATEGORIZED, id]);
  const result = await pool.query('DELETE FROM skill_marketplace_categories WHERE category_id = $1', [id]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});
```

- [ ] **Step 4: Wire the route in `server.ts`**

Add `import { skillMarketplaceAdminRoutes } from './routes/skillMarketplaceAdmin';` and `app.route('/', skillMarketplaceAdminRoutes);` next to the MCP admin registration.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run --no-file-parallelism tests/routes/skillMarketplaceAdmin.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + typecheck + commit**

Run: `cd enterprise_server && npx tsc --noEmit && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/routes/skillMarketplaceAdmin.ts src/server.ts`

```bash
git add enterprise_server/src/routes/skillMarketplaceAdmin.ts enterprise_server/src/server.ts enterprise_server/tests/routes/skillMarketplaceAdmin.test.ts
git commit -m "feat(enterprise_server): add skill marketplace admin CRUD and zip upload"
```

---

### Task 6: Admin SPA — permission mirror + i18n

**Files:**
- Modify: `enterprise_server/web/src/shared/permissions.ts:13`
- Modify: `enterprise_server/web/src/i18n.ts`
- Test: `enterprise_server/web/tests/shared/permissions.test.ts` (create)

**Interfaces:**
- Consumes: server rename (Task 2).
- Produces: `PermissionCode.SkillsManage === 'skills.manage'`; i18n keys `roles.perm.skills.manage` / `roles.permDesc.skills.manage` and the `skillmgmt.*` page strings (en + zh).

- [ ] **Step 1: Write the failing mirror test**

Create `enterprise_server/web/tests/shared/permissions.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { PermissionCode, PERMISSIONS } from '../../src/shared/permissions';

describe('permissions mirror', () => {
  test('skills.manage replaces policies.manage', () => {
    expect(PermissionCode.SkillsManage).toBe('skills.manage');
    expect((PERMISSIONS as string[])).toContain('skills.manage');
    expect((PERMISSIONS as string[])).not.toContain('policies.manage');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/shared/permissions.test.ts`
Expected: FAIL — `SkillsManage` undefined.

- [ ] **Step 3: Rename the code in the SPA mirror**

In `enterprise_server/web/src/shared/permissions.ts`, change line 13:
`PoliciesManage: 'policies.manage',` → `SkillsManage: 'skills.manage',`

- [ ] **Step 4: Rename the i18n permission keys**

In `enterprise_server/web/src/i18n.ts`, rename the two keys (values unchanged) in **both** the `en` and `zh` blocks:
- `roles.perm.policies.manage` → `roles.perm.skills.manage` (en `"Manage skills"`, zh `"技能管理"`)
- `roles.permDesc.policies.manage` → `roles.permDesc.skills.manage` (en/zh unchanged)

- [ ] **Step 5: Add the `skillmgmt.*` page strings (en + zh)**

Add to the `en` block and the `zh` block of `enterprise_server/web/src/i18n.ts`. (Mirror the `mcp.*` block at `src/i18n.ts:307+` for tone; keep `nav.skill` as-is.)

en:
```ts
'skillmgmt.title': 'Skill management',
'skillmgmt.breadcrumb': 'Skills',
'skillmgmt.all': 'All',
'skillmgmt.search': 'Search skills',
'skillmgmt.categories': 'Categories',
'skillmgmt.addCategory': '+ New category',
'skillmgmt.addCategory.title': 'New category',
'skillmgmt.addCategory.placeholder': 'e.g. Design',
'skillmgmt.addSkill': '+ Add skill',
'skillmgmt.count': 'Total {n} skills',
'skillmgmt.empty': 'No skills in this category yet. Click “+ Add skill” to create one.',
'skillmgmt.enabled': 'Enabled',
'skillmgmt.disabled': 'Disabled',
'skillmgmt.create.title': 'New skill',
'skillmgmt.nameEn': 'Name (EN)',
'skillmgmt.nameZh': 'Name (ZH)',
'skillmgmt.descEn': 'Description (EN)',
'skillmgmt.descZh': 'Description (ZH)',
'skillmgmt.icon': 'Icon URL',
'skillmgmt.version': 'Version',
'skillmgmt.category': 'Category',
'skillmgmt.sourceFrom': 'Source (from)',
'skillmgmt.sourceUrl': 'Source URL',
'skillmgmt.allowedRoles': 'Allowed roles',
'skillmgmt.uploadPackage': 'Upload package (.zip)',
'skillmgmt.replacePackage': 'Replace package (.zip)',
'skillmgmt.delete.confirm': 'Delete “{name}”?',
'skillmgmt.categoryDelete.title': 'Delete category',
'skillmgmt.categoryDelete.confirm': 'Delete “{name}”? Its {n} skills move to Uncategorized.',
'skillmgmt.categoryDelete.confirmEmpty': 'Delete “{name}”?',
'skillmgmt.uncategorized': 'Uncategorized',
```
zh:
```ts
'skillmgmt.title': '技能管理',
'skillmgmt.breadcrumb': '技能',
'skillmgmt.all': '全部',
'skillmgmt.search': '搜索技能',
'skillmgmt.categories': '分类',
'skillmgmt.addCategory': '+ 新增分类',
'skillmgmt.addCategory.title': '新增分类',
'skillmgmt.addCategory.placeholder': '例如 设计',
'skillmgmt.addSkill': '+ 添加技能',
'skillmgmt.count': '共 {n} 个技能',
'skillmgmt.empty': '该分类下暂无技能，点击右上角「+ 添加技能」创建。',
'skillmgmt.enabled': '启用',
'skillmgmt.disabled': '停用',
'skillmgmt.create.title': '新增技能',
'skillmgmt.nameEn': '名称（英文）',
'skillmgmt.nameZh': '名称（中文）',
'skillmgmt.descEn': '描述（英文）',
'skillmgmt.descZh': '描述（中文）',
'skillmgmt.icon': '图标 URL',
'skillmgmt.version': '版本',
'skillmgmt.category': '所属分类',
'skillmgmt.sourceFrom': '来源（from）',
'skillmgmt.sourceUrl': '来源 URL',
'skillmgmt.allowedRoles': '允许的角色',
'skillmgmt.uploadPackage': '上传安装包（.zip）',
'skillmgmt.replacePackage': '替换安装包（.zip）',
'skillmgmt.delete.confirm': '删除「{name}」？',
'skillmgmt.categoryDelete.title': '删除分类',
'skillmgmt.categoryDelete.confirm': '删除「{name}」？其 {n} 个技能将移入未分类。',
'skillmgmt.categoryDelete.confirmEmpty': '删除「{name}」？',
'skillmgmt.uncategorized': '未分类',
```

- [ ] **Step 6: Run the test + lint**

Run: `cd enterprise_server/web && npx vitest run tests/shared/permissions.test.ts && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/shared/permissions.ts src/i18n.ts`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/web/src/shared/permissions.ts enterprise_server/web/src/i18n.ts enterprise_server/web/tests/shared/permissions.test.ts
git commit -m "feat(enterprise_server/web): rename skill permission code and add skillmgmt i18n"
```

---

### Task 7: Admin SPA — API client + binary POST helper

**Files:**
- Modify: `enterprise_server/web/src/api/client.ts`
- Create: `enterprise_server/web/src/api/skillMarketplace.ts`
- Delete: `enterprise_server/web/src/api/policies.ts`
- Test: `enterprise_server/web/tests/api/skillMarketplace.test.ts` (create)

**Interfaces:**
- Consumes: `apiClient` (existing); the server routes (Tasks 4, 5).
- Produces: `skillMarketplaceApi` (listSkills, listCategories, createSkill, updateSkill, deleteSkill, createCategory, updateCategory, deleteCategory, uploadZip) + `apiClient.postRaw`.

- [ ] **Step 1: Add a raw/binary POST helper to `apiClient`**

In `enterprise_server/web/src/api/client.ts`, add to the `ApiClient` interface:
```ts
postRaw<T = unknown>(path: string, body: BodyInit, headers?: Record<string, string>): Promise<T>;
```
Add the implementation in the `apiClient` object (reuse `buildHeaders` + `readErrorBody`). Do **not** reuse `call()` for the 401 path: the body is a binary `Blob`/`Uint8Array`, and `call()` would `JSON.stringify` it. A session-expired upload surfaces as a 401 the caller (a `DetailDrawer` catch) renders — no silent retry:
```ts
async postRaw<T>(path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<T> {
  const h = buildHeaders(headers);
  // content-type is set by the caller (e.g. application/zip) — do not force JSON.
  h.set('content-type', headers['content-type'] ?? 'application/octet-stream');
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: h, body });
  } catch (e) {
    throw new ApiError(0, { error: 'network', detail: (e as Error).message });
  }
  if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
  const text = await res.text();
  return (text ? JSON.parse(text) : (undefined as T)) as T;
},
```

- [ ] **Step 2: Write the failing API test**

Create `enterprise_server/web/tests/api/skillMarketplace.test.ts` (stub `globalThis.fetch`, mirror how the SPA tests stub `apiClient` — first set `apiClient.setBaseUrl` and a token provider if the client requires them):
```ts
import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { apiClient } from '../../src/api/client';
import { skillMarketplaceApi } from '../../src/api/skillMarketplace';

beforeEach(() => {
  fetchMock.mockReset();
  apiClient.setBaseUrl('http://server');
  apiClient.setTokenProvider(() => 'tok');
});

describe('skillMarketplaceApi', () => {
  test('listSkills hits the admin route', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await skillMarketplaceApi.listSkills();
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://server/api/admin/skill-marketplace/skills');
  });

  test('uploadZip posts raw bytes with a zip content-type', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'uploaded' }), { status: 200 }));
    const res = await skillMarketplaceApi.uploadZip('s1', new Uint8Array([1, 2, 3]) as unknown as Blob, 'application/zip');
    expect(res).toEqual({ status: 'uploaded' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/zip');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/api/skillMarketplace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the API client + delete the old one**

Create `enterprise_server/web/src/api/skillMarketplace.ts` (mirror `api/mcpMarketplace.ts`):
```ts
import { apiClient } from './client';

export interface SkillCategory { id: string; name_zh: string; name_en: string; display_order?: number; }
export interface SkillSource { from?: string; url?: string; author?: string; }
export interface SkillItem {
  id: string; name: string; name_zh: string | null; description: string;
  category: string; version: string | null; icon: string | null;
  source: SkillSource | null; allowed_roles: string[]; enabled: boolean;
}
export interface SkillInput {
  skill_id: string; name_en: string; name_zh?: string; description_en: string;
  description_zh?: string; icon?: string; version?: string; category_id: string;
  source?: SkillSource; allowed_roles: string[];
}
export interface SkillPatch {
  name_en?: string; name_zh?: string; description_en?: string; description_zh?: string;
  icon?: string; version?: string; category_id?: string; source?: SkillSource;
  allowed_roles?: string[]; enabled?: boolean;
}

export const skillMarketplaceApi = {
  listSkills: () => apiClient.get<SkillItem[]>('/api/admin/skill-marketplace/skills'),
  listCategories: () => apiClient.get<SkillCategory[]>('/api/admin/skill-marketplace/categories'),
  listRoleVocabulary: () => apiClient.get<{ roles: string[] }>('/api/roles/vocabulary'),
  createSkill: (input: SkillInput) => apiClient.post<{ skill_id: string }>('/api/admin/skill-marketplace/skills', input),
  updateSkill: (id: string, input: SkillPatch) => apiClient.put<void>(`/api/admin/skill-marketplace/skills/${id}`, input),
  deleteSkill: (id: string) => apiClient.delete(`/api/admin/skill-marketplace/skills/${id}`),
  uploadZip: (id: string, body: BodyInit, contentType = 'application/zip') =>
    apiClient.postRaw<{ status: string }>(`/api/admin/skill-marketplace/skills/${id}/zip`, body, { 'content-type': contentType }),
  createCategory: (input: { category_id: string; name_zh: string; name_en: string }) =>
    apiClient.post<{ category_id: string }>('/api/admin/skill-marketplace/categories', input),
  updateCategory: (id: string, input: { name_zh?: string; name_en?: string }) =>
    apiClient.put<void>(`/api/admin/skill-marketplace/categories/${id}`, input),
  deleteCategory: (id: string) => apiClient.delete(`/api/admin/skill-marketplace/categories/${id}`),
};
```
Delete `enterprise_server/web/src/api/policies.ts` (only `SkillPoliciesPage` used it; that page is deleted in Task 8).

- [ ] **Step 5: Run the test + lint**

Run: `cd enterprise_server/web && npx vitest run tests/api/skillMarketplace.test.ts && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/api/client.ts src/api/skillMarketplace.ts`
Expected: PASS + clean. (If `npx tsc --noEmit` fails here only because `SkillPoliciesPage.tsx` still imports the deleted `api/policies.ts`, that's expected and is fixed in Task 8; note it and proceed.)

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/web/src/api/client.ts enterprise_server/web/src/api/skillMarketplace.ts enterprise_server/web/tests/api/skillMarketplace.test.ts
git add -A enterprise_server/web/src/api/policies.ts
git commit -m "feat(enterprise_server/web): add skill marketplace API client and raw-post helper"
```

---

### Task 8: Admin SPA — page skeleton, category sidebar, wire route/nav, delete old page

**Files:**
- Create: `enterprise_server/web/src/pages/SkillManagePage.tsx`
- Create: `enterprise_server/web/src/pages/skillManage/types.ts`, `CategorySidebar.tsx`, `AddCategoryModal.tsx`
- Modify: `enterprise_server/web/src/App.tsx`
- Delete: `enterprise_server/web/src/pages/SkillPoliciesPage.tsx`
- Test: `enterprise_server/web/tests/pages/skillManage/SkillManagePage.test.tsx` (create)

**Interfaces:**
- Consumes: `skillMarketplaceApi` (Task 7), `skillmgmt.*` i18n (Task 6), `UNCATEGORIZED`, `autoIcon`, `ConfirmDialog`, `apiClient` token.
- Produces: `SkillManagePage` (renders category sidebar + an empty skill area for now; Task 9 fills the grid/form/drawer).

- [ ] **Step 1: Write the failing page test**

Create `enterprise_server/web/tests/pages/skillManage/SkillManagePage.test.tsx` (mirror `tests/pages/mcpManage/MCPManagePage.test.tsx` — stub `globalThis.fetch` on the dispatcher for `/skills`, `/categories`, `/roles/vocabulary`):
```tsx
import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useAuthStore } from '../../../src/auth/store';
import { SkillManagePage } from '../../../src/pages/SkillManagePage';

function seedFetch(): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/skills')) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes('/categories')) return new Response(JSON.stringify([
      { id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized', display_order: 9999 },
    ]), { status: 200 });
    if (url.includes('/roles/vocabulary')) return new Response(JSON.stringify({ roles: ['super_admin', 'org_admin', 'user'] }), { status: 200 });
    return new Response('{}', { status: 200 });
  });
}

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><SkillManagePage /></MemoryRouter></QueryClientProvider>);
}

describe('SkillManagePage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'a', orgId: 'o1', roles: ['org_admin'] } });
    seedFetch();
  });

  test('renders the skillmgmt title and the uncategorized category', async () => {
    renderPage();
    expect(await screen.findByText('技能管理')).toBeInTheDocument();
    expect(await screen.findByText('未分类')).toBeInTheDocument();
  });

  test('new category posts to the admin route', async () => {
    let posted = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/categories') && init?.method === 'POST') { posted = true; return new Response('{}', { status: 200 }); }
      if (url.includes('/skills')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('/categories')) return new Response(JSON.stringify([
        { id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized', display_order: 9999 }]), { status: 200 });
      if (url.includes('/roles/vocabulary')) return new Response(JSON.stringify({ roles: ['org_admin'] }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    renderPage();
    await screen.findByText(/新增分类/i);
    fireEvent.click(screen.getByRole('button', { name: /新增分类/i }));
    const input = await screen.findByLabelText(/新增分类/i);
    fireEvent.change(input, { target: { value: '设计' } });
    fireEvent.click(screen.getByRole('button', { name: /确定|确认|Confirm/i }));
    await waitFor(() => expect(posted).toBe(true));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/skillManage/SkillManagePage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the shared types + sidebar + modal**

`enterprise_server/web/src/pages/skillManage/types.ts` (copy `pages/mcpManage/types.ts`, change the i18n namespace usage):
```ts
import { t } from '../../i18n';
export function fill(s: string, kv: Record<string, string | number>): string {
  return Object.entries(kv).reduce((a, [k, v]) => a.split(`{${k}}`).join(String(v)), s);
}
export const UNCATEGORIZED = 'uncategorized';
export { t };
```
`enterprise_server/web/src/pages/skillManage/CategorySidebar.tsx` (copy `pages/mcpManage/CategorySidebar.tsx`; replace `McpCategory` with `SkillCategory` and `t('mcp.*')` keys with `t('skillmgmt.*')`; keep `UNCATEGORIZED` non-deletable).
`enterprise_server/web/src/pages/skillManage/AddCategoryModal.tsx` (copy `pages/mcpManage/AddCategoryModal.tsx`; swap `t('mcp.addCategory.*')` → `t('skillmgmt.addCategory.*')`).

- [ ] **Step 4: Create the page skeleton**

Create `enterprise_server/web/src/pages/SkillManagePage.tsx` — copy `pages/MCPManagePage.tsx` and adapt: query `skillMarketplaceApi.listSkills` / `listCategories` / `listRoleVocabulary`; render `CategorySidebar`; the main area is a placeholder list of `skillmgmt.empty` for now (Task 9 swaps in `SkillCardGrid`/`CreateSkillForm`/`DetailDrawer`). Keep the category add/delete logic (migrate-on-delete confirm via `ConfirmDialog` + `skillmgmt.categoryDelete.*`). Keep the `useEffect` Escape handler.

- [ ] **Step 5: Wire the route and delete the old page**

- `enterprise_server/web/src/App.tsx`: replace `import { SkillPoliciesPage } from './pages/SkillPoliciesPage';` with `import { SkillManagePage } from './pages/SkillManagePage';`, and change the `path="/config/skill"` route body from `<SkillPoliciesPage />` to `<SkillManagePage />` (keep `<AuthGuard requires="policy_admin">` and `<Shell>`).
- Delete `enterprise_server/web/src/pages/SkillPoliciesPage.tsx`.
- `Sidebar.tsx` needs **no change** (the `nav.skill` item already points at `/config/skill`).

- [ ] **Step 6: Run the test + typecheck**

Run: `cd enterprise_server/web && npx vitest run tests/pages/skillManage/SkillManagePage.test.tsx && npx tsc --noEmit`
Expected: PASS + clean (the `SkillPoliciesPage` import is gone, so `tsc` is now green again).

- [ ] **Step 7: Commit**

```bash
git add -A enterprise_server/web/src/pages enterprise_server/web/src/App.tsx enterprise_server/web/tests/pages/skillManage/
git commit -m "feat(enterprise_server/web): add skill management page skeleton and wire /config/skill"
```

---

### Task 9: Admin SPA — skill grid, create form, detail drawer (roles + upload)

**Files:**
- Create: `enterprise_server/web/src/pages/skillManage/SkillCardGrid.tsx`, `CreateSkillForm.tsx`, `DetailDrawer.tsx`
- Modify: `enterprise_server/web/src/pages/SkillManagePage.tsx` (swap the placeholder for the real grid/form/drawer)
- Test: `enterprise_server/web/tests/pages/skillManage/SkillCardGrid.test.tsx` (create), extend `SkillManagePage.test.tsx`

**Interfaces:**
- Consumes: `skillMarketplaceApi` (Task 7), i18n (Task 6), page state (Task 8), `ConfirmDialog`.
- Produces: full catalog management UI — create/edit skill (metadata + allowed-roles + enabled), upload/replace `.zip`, delete.

- [ ] **Step 1: Write the failing grid test**

Create `enterprise_server/web/tests/pages/skillManage/SkillCardGrid.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { SkillCardGrid } from '../../../src/pages/skillManage/SkillCardGrid';

const skills = [
  { id: 'a', name: 'Canvas', name_zh: '画布', description: 'd', category: 'design', version: '1.0.0', icon: null, source: null, allowed_roles: ['org_admin'], enabled: true },
];

describe('SkillCardGrid', () => {
  test('renders each skill card by its (zh-preferred) name', () => {
    render(<SkillCardGrid skills={skills} categoryName="All" current="all" onAdd={() => {}} onOpen={() => {}} />);
    expect(screen.getByText('Canvas')).toBeInTheDocument();
  });

  test('shows the empty state when there are no skills', () => {
    render(<SkillCardGrid skills={[]} categoryName="All" current="all" onAdd={() => {}} onOpen={() => {}} />);
    expect(screen.getByText(/No skills/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/skillManage/SkillCardGrid.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the three components**

- `SkillCardGrid.tsx`: copy `pages/mcpManage/McpCardGrid.tsx`; render a card per `SkillItem` (name via `name_zh || name`, description, `skillmgmt.empty` when empty), `onAdd` button uses `t('skillmgmt.addSkill')`, `onOpen(skill)`.
- `CreateSkillForm.tsx`: copy `pages/mcpManage/CreateMcpForm.tsx`; fields = name_en, name_zh, desc_en, desc_zh, icon, version, **category** (select from `categories`, default the current), **allowed_roles** (multi-select from `roles`), optional source from/url. On submit, call the passed `onSave(input: SkillInput)` — the parent then creates the skill and (optionally) opens its drawer for the `.zip` upload.
- `DetailDrawer.tsx`: copy `pages/mcpManage/DetailDrawer.tsx`; show metadata (name/desc zh+en, icon, version, category, source), an **allowed-roles** multi-select, an **enabled** toggle (`Switch`), and a **package upload** section: a file input (accept `.zip`) that calls `skillMarketplaceApi.uploadZip(skill.id, file, 'application/zip')` — label `t('skillmgmt.uploadPackage')` (or `replacePackage` if a package already exists). Save → `updateSkill(id, patch)`. Delete → parent confirm.

- [ ] **Step 4: Wire them into the page**

In `SkillManagePage.tsx`, replace the placeholder main area with the `view === 'create' ? <CreateSkillForm …/> : <SkillCardGrid …/>` pattern and the `DetailDrawer` overlay, exactly as `MCPManagePage.tsx` does (adapt prop names to the skill types). On create, open the new skill's drawer so the admin can upload the `.zip` immediately.

- [ ] **Step 5: Extend the page test for create/edit**

In `tests/pages/skillManage/SkillManagePage.test.tsx`, add a test: click "+ 添加技能" → the create form shows; submit with a category + allowed_roles posts to `/skills`; then a card renders. (Stub `fetch` for the POST.)

- [ ] **Step 6: Run the tests + typecheck**

Run: `cd enterprise_server/web && npx vitest run tests/pages/skillManage/ && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add -A enterprise_server/web/src/pages/skillManage enterprise_server/web/src/pages/SkillManagePage.tsx enterprise_server/web/tests/pages/skillManage/
git commit -m "feat(enterprise_server/web): add skill grid, create form, and detail drawer with upload"
```

---

### Task 10: Desktop main — enterprise skill catalog client + handler

**Files:**
- Modify: `src/main/auth/enterpriseClient.ts` (add `listEnterpriseSkills`)
- Modify: `src/main/ipcHandlers/skills/handlers.ts` (rewrite `skills:fetchMarketplace`)
- Test: `src/main/ipcHandlers/skills/handlers.test.ts` (create or extend — mirror `src/main/ipcHandlers/mcp/handlers.test.ts` for capturing the registered handler)

**Interfaces:**
- Consumes: `enterpriseClient` (existing), `getEnterpriseServerUrl` (`src/main/libs/endpoints.ts`), the server catalog route (Task 4).
- Produces: `skills:fetchMarketplace` → `{ success, skills, categories }` where each `skill.url = ${base}/api/skill-marketplace/download/<id>` and `categories` is mapped to `{ id, en, zh }`.

- [ ] **Step 1: Add `listEnterpriseSkills` to `enterpriseClient`**

In `src/main/auth/enterpriseClient.ts`, add a method to the `enterpriseClient = { … }` object literal, immediately after `listEnterpriseMcps` (which ends ~line 336). Mirror it exactly — it uses the module-scope `baseUrl` + `tokenProvider()` and a direct `fetch` (not `call()`), with an explicit inline return type (no `this`/`ReturnType` cast, since the method lives inside an object literal where `this` isn't the client type):
```ts
async listEnterpriseSkills(): Promise<{
  categories: Array<{ id: string; name_zh: string; name_en: string }>;
  skills: Array<{
    id: string;
    name: string;
    name_zh: string | null;
    description: string;
    category: string;
    version: string | null;
    icon: string | null;
    source: { from?: string; url?: string; author?: string } | null;
    allowed_roles: string[];
    enabled: boolean;
  }>;
}> {
  const url = `${baseUrl}/api/skill-marketplace`;
  const token = tokenProvider();
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`enterprise-skill-marketplace fetch failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    categories: Array<{ id: string; name_zh: string; name_en: string }>;
    skills: Array<{
      id: string; name: string; name_zh: string | null; description: string;
      category: string; version: string | null; icon: string | null;
      source: { from?: string; url?: string; author?: string } | null;
      allowed_roles: string[]; enabled: boolean;
    }>;
  };
  return body;
},
```

- [ ] **Step 2: Write the failing handler test**

Create `src/main/ipcHandlers/skills/handlers.test.ts` (mirror `src/main/ipcHandlers/mcp/handlers.test.ts`: capture the registered `ipcMain.handle` callbacks, mock `enterpriseClient`). Use `vi.hoisted` for the handler map — `vi.mock` factories are hoisted **above** module-scope `const`s, so a plain top-level `const handlers` referenced inside the factory would be in the TDZ and throw. `registerSkillHandlers` value-imports from `'../../skills'` (`updatePluginSkillIdsFromReport`), so that module must be mocked too:
```ts
import { describe, expect, test, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, fn: unknown) => { handlers.set(channel, fn); }) },
}));
vi.mock('../../auth/enterpriseClient', () => ({
  enterpriseClient: { listEnterpriseSkills: vi.fn() },
}));
vi.mock('../../libs/endpoints', () => ({ getEnterpriseServerUrl: () => 'https://ent.example' }));
vi.mock('../../skills', () => ({ updatePluginSkillIdsFromReport: vi.fn() }));

import { enterpriseClient } from '../../auth/enterpriseClient';
import { registerSkillHandlers } from './handlers';

function register(): void {
  registerSkillHandlers({
    getSkillManager: () => ({} as never),
    getSkillStoreUrl: () => '',
    getOpenClawRuntimeAdapter: () => null,
  });
}

describe('skills:fetchMarketplace', () => {
  test('returns role-scoped skills with assembled download urls and mapped categories', async () => {
    vi.mocked(enterpriseClient.listEnterpriseSkills).mockResolvedValue({
      categories: [{ id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized' }],
      skills: [{ id: 'sk1', name: 'Canvas', name_zh: '画布', description: 'd', category: 'uncategorized', version: '1.0.0', icon: null, source: null, allowed_roles: ['org_admin'], enabled: true }],
    });
    register();
    const out = await handlers.get('skills:fetchMarketplace')!(undefined, undefined) as {
      success: boolean; skills: Array<{ id: string; url: string }>; categories: Array<{ id: string; en: string; zh: string }>;
    };
    expect(out.success).toBe(true);
    expect(out.skills[0].url).toBe('https://ent.example/api/skill-marketplace/download/sk1');
    expect(out.categories[0]).toEqual({ id: 'uncategorized', en: 'Uncategorized', zh: '未分类' });
  });

  test('returns success=false on error', async () => {
    vi.mocked(enterpriseClient.listEnterpriseSkills).mockRejectedValue(new Error('boom'));
    register();
    const out = await handlers.get('skills:fetchMarketplace')!(undefined, undefined) as { success: boolean; error: string };
    expect(out.success).toBe(false);
    expect(out.error).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/main/ipcHandlers/skills/handlers.test.ts`
Expected: FAIL — the handler still returns `{ success: true, data }` (the old static-URL path) or `skills` is undefined.

- [ ] **Step 4: Rewrite the handler**

In `src/main/ipcHandlers/skills/handlers.ts`:

1. Add these imports at the top (next to the existing `import type { SkillManager }` block):
```ts
import { enterpriseClient } from '../../auth/enterpriseClient';
import { getEnterpriseServerUrl } from '../../libs/endpoints';
```

2. `getSkillStoreUrl` is destructured on line 24 but was used **only** by the `fetchMarketplace` handler (line 161). Once that call is gone the binding is unused → lint error under `--max-warnings 0`. Drop it from the destructure (leave it in the `SkillHandlerDeps` interface — `main.ts:6798` still passes it, and removing it from the interface would make that caller error):
```ts
// line 24, before:
const { getSkillManager, getSkillStoreUrl, getOpenClawRuntimeAdapter } = deps;
// after:
const { getSkillManager, getOpenClawRuntimeAdapter } = deps;
```

3. Replace the entire `ipcMain.handle('skills:fetchMarketplace', …)` block (lines ~160-185, from `ipcMain.handle('skills:fetchMarketplace'` through its closing `});`) with:
```ts
ipcMain.handle('skills:fetchMarketplace', async () => {
  try {
    const { categories, skills } = await enterpriseClient.listEnterpriseSkills();
    const base = getEnterpriseServerUrl();
    return {
      success: true,
      skills: skills.map((s) => ({
        ...s,
        url: `${base}/api/skill-marketplace/download/${s.id}`,
      })),
      categories: categories.map((c) => ({ id: c.id, en: c.name_en, zh: c.name_zh })),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch skill marketplace' };
  }
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/ipcHandlers/skills/handlers.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/auth/enterpriseClient.ts src/main/ipcHandlers/skills/handlers.ts`

```bash
git add src/main/auth/enterpriseClient.ts src/main/ipcHandlers/skills/handlers.ts src/main/ipcHandlers/skills/handlers.test.ts
git commit -m "feat(desktop): fetch the skill catalog from the enterprise server"
```

---

### Task 11: Desktop main — authed `.zip` download

**Files:**
- Modify: `src/main/skills/skillManager.ts` (auth header in `downloadZipUrl`; export it via `__skillManagerTestUtils`)
- Test: `src/main/skills/skillManager.test.ts` (append)

**Interfaces:**
- Consumes: `getEnterpriseServerUrl`, `enterpriseClient.getToken()`; the download route (Task 4).
- Produces: `downloadZipUrl(zipUrl, tempRoot)` that attaches `Authorization: Bearer <token>` when `new URL(zipUrl).origin === getEnterpriseServerUrl()`; exported via `__skillManagerTestUtils.downloadZipUrl`.

- [ ] **Step 1: Write the failing test**

Edit `src/main/skills/skillManager.test.ts`. First, in the existing top-of-file `vi.mock('electron', …)` factory (lines 7-11), add `fetch: vi.fn()` to `session.defaultSession` (it currently only has `webRequest`):
```ts
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() }, fetch: vi.fn() } },
}));
```
The file currently imports `{ afterEach, expect, test, vi }` and `__skillManagerTestUtils` at the top. Add these right after them (`vi.mock` calls are hoisted, so this is safe; the mock makes `getToken()` return a fixed token for the auth assertion — no need to import `enterpriseClient` itself):
```ts
import * as electron from 'electron';
vi.mock('../auth/enterpriseClient', () => ({
  enterpriseClient: { getToken: vi.fn().mockResolvedValue('tok-123') },
}));
```
Then append these tests at the bottom (the file uses bare `test(...)`, so no `describe` wrapper — matching its existing style):
```ts
const fetchMock = (electron.session.defaultSession as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;

test('downloadZipUrl attaches a Bearer token for the enterprise origin', async () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
  await expect(
    __skillManagerTestUtils.downloadZipUrl('https://ent.example/api/skill-marketplace/download/sk1', process.cwd()),
  ).rejects.toThrow();
  const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  expect(headers.authorization).toBe('Bearer tok-123');
});

test('downloadZipUrl omits the auth header for a non-enterprise origin', async () => {
  process.env.ENTERPRISE_SERVER_URL = 'https://ent.example';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
  await expect(
    __skillManagerTestUtils.downloadZipUrl('https://github.com/x/y.zip', process.cwd()),
  ).rejects.toThrow();
  const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  expect(headers.authorization).toBeUndefined();
});
```
(`process.env.ENTERPRISE_SERVER_URL` must be set in both cases: `getEnterpriseServerUrl()` is called for the origin comparison and would otherwise throw — the `catch` then silently drops the header, which is the intended fail-safe but would mask a real regression in the first test.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/skills/skillManager.test.ts`
Expected: FAIL — `__skillManagerTestUtils.downloadZipUrl` is undefined (and/or no auth header sent).

- [ ] **Step 3: Add the auth header + export the function**

In `src/main/skills/skillManager.ts`:
- Add imports at the top: `import { getEnterpriseServerUrl } from '../libs/endpoints';` and `import { enterpriseClient } from '../auth/enterpriseClient';`
- Modify `downloadZipUrl` (~line 1256) to build a headers object and attach the token when the origin matches:
```ts
const downloadZipUrl = async (zipUrl: string, tempRoot: string): Promise<string> => {
  const headers: Record<string, string> = { 'User-Agent': 'GenWork Skill Downloader' };
  try {
    if (new URL(zipUrl).origin === getEnterpriseServerUrl()) {
      const token = await enterpriseClient.getToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
  } catch {
    // malformed URL or unset ENTERPRISE_SERVER_URL → no auth header.
  }
  const response = await session.defaultSession.fetch(zipUrl, { method: 'GET', headers });
  // …rest of the function is unchanged (ok check, buffer, extractZip) …
};
```
- Add `downloadZipUrl` to the `__skillManagerTestUtils` export object (~line 3241).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/skills/skillManager.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/skills/skillManager.ts`

```bash
git add src/main/skills/skillManager.ts src/main/skills/skillManager.test.ts
git commit -m "feat(desktop): attach JWT when downloading skill zips from the enterprise server"
```

---

### Task 12: Desktop renderer — types, service, analytics, and the category filter

**Files:**
- Modify: `src/renderer/types/skill.ts`
- Modify: `src/renderer/types/electron.d.ts:544`
- Modify: `src/renderer/services/skill.ts`
- Modify: `src/renderer/components/skills/analytics.ts`
- Modify: `src/renderer/components/skills/SkillsManager.tsx`
- Test: `src/renderer/services/skill.test.ts` (create), extend/`create` `src/renderer/components/skills/SkillsManager.test.tsx`

**Interfaces:**
- Consumes: the main handler contract (Task 10) via `electron.d.ts`; the server categories.
- Produces: `MarketplaceSkill.category`, `MarketCategory`, structured `fetchMarketplaceSkills`, and a category-filtered 企业 tab.

- [ ] **Step 1: Update the types**

In `src/renderer/types/skill.ts`:
```ts
export interface MarketCategory { id: string; en: string; zh: string; }

export interface MarketplaceSkill {
  id: string;
  name: string;
  name_zh: string | null;      // new: the wire shape carries the zh name
  description: string | LocalizedText;
  category: string;            // was tags?: string[]
  url: string;
  version: string;
  source: { from?: string; url?: string; author?: string } | null;
  displayName?: string | LocalizedText;
  icon?: string;
}
```
(Remove `tags` and `downloadCount` from `MarketplaceSkill`; remove the `MarketTag` interface or replace its definition with `MarketCategory`. Keep `LocalizedText` and `LocalSkillInfo` unchanged. `description` stays `string | LocalizedText` — the enterprise server always sends a single `string`, and `resolveLocalizedText` handles both, so no existing call site changes.)

- [ ] **Step 2: Update `electron.d.ts`**

Change `src/renderer/types/electron.d.ts:544` from:
```ts
fetchMarketplace: () => Promise<{ success: boolean; data?: string; error?: string }>;
```
to:
```ts
fetchMarketplace: () => Promise<{
  success: boolean;
  skills?: Array<Record<string, unknown>>;
  categories?: Array<{ id: string; en: string; zh: string }>;
  error?: string;
}>;
```

- [ ] **Step 3: Write the failing service test**

Create `src/renderer/services/skill.test.ts` (stub `window.electron.skills.fetchMarketplace` via `vi.stubGlobal('window', …)`, mirroring `src/renderer/services/auth.test.ts`):
```ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { skillService } from './skill';

afterEach(() => vi.unstubAllGlobals());

test('fetchMarketplaceSkills maps structured IPC result and populates icon map', async () => {
  vi.stubGlobal('window', {
    electron: {
      skills: {
        fetchMarketplace: () => Promise.resolve({
          success: true,
          skills: [{ id: 'sk1', name: 'Canvas', name_zh: '画布设计', description: 'd', category: 'design', url: 'https://ent.example/api/skill-marketplace/download/sk1', version: '1.0.0', source: null, icon: 'https://i/x.png' }],
          categories: [{ id: 'design', en: 'Design', zh: '设计' }],
        }),
      },
    },
  });
  const { skills, categories } = await skillService.fetchMarketplaceSkills();
  expect(skills).toHaveLength(1);
  expect(skills[0].id).toBe('sk1');
  expect(skills[0].category).toBe('design');
  expect(categories).toEqual([{ id: 'design', en: 'Design', zh: '设计' }]);
  // icon map is populated (locale-independent); the localized name is fed into
  // the same name map the other tabs use, so getLocalizedSkillName resolves it
  // by the active language — asserted here only for the locale-free icon.
  expect(skillService.getSkillIcon('sk1')).toBe('https://i/x.png');
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/renderer/services/skill.test.ts`
Expected: FAIL — the service still reads `result.data` / returns `tags`.

- [ ] **Step 5: Update the service**

In `src/renderer/services/skill.ts`:

- Update the `MarketTag` import to `MarketCategory` (line 2: `import { LocalizedText, LocalSkillInfo, MarketplaceSkill, MarketCategory, Skill } from '../types/skill';`).
- Change the cache/promise types from `{ skills; tags: MarketTag[] }` to `{ skills: MarketplaceSkill[]; categories: MarketCategory[] }` (lines ~101-102, and the two method signatures at ~377 and ~391).
- Rewrite `loadMarketplaceSkills` (lines ~391-432). The old body read `value.localSkill` / `value.marketplace` / `value.marketTags` from the dead skill-store payload (`json.data.value`) — all gone. The new structured IPC result carries only `skills` + `categories`. Feed the three shared maps (`marketplaceSkillNames`/`marketplaceSkillDescriptions`/`skillIcons`) from `skills`; give the name map localized text (`{ en, zh }`) so the 企业 card title (which calls `skillService.getLocalizedSkillName(skill.id, skill.name)`) shows `name_zh` in zh and `name` in en — exactly the MCP card-title pattern. An installed-from-enterprise skill is also present in the catalog, so this same map serves the localized-name fallback for My Skills/BuiltIn:
```ts
private async loadMarketplaceSkills(): Promise<{ skills: MarketplaceSkill[]; categories: MarketCategory[] }> {
  try {
    const result = await window.electron.skills.fetchMarketplace();
    if (!result.success || !result.skills) {
      throw new Error(result.error || 'Failed to fetch');
    }
    const skills = result.skills as unknown as MarketplaceSkill[];
    const categories = Array.isArray(result.categories) ? result.categories : [];
    // Populate the shared maps so the 企业 tab titles/descriptions and the
    // Mine/BuiltIn localized-name fallbacks all resolve. A skill installed
    // from the enterprise catalog is also listed here, so its localized name
    // is served from `marketplaceSkillNames` (no separate localSkill source
    // anymore — the old skill-store `localSkill` payload is gone).
    this.marketplaceSkillNames.clear();
    this.marketplaceSkillDescriptions.clear();
    this.skillIcons.clear();
    for (const ms of skills) {
      this.marketplaceSkillNames.set(ms.id, { en: ms.name, zh: ms.name_zh ?? ms.name });
      if (ms.description) this.marketplaceSkillDescriptions.set(ms.id, ms.description);
      if (ms.icon) this.skillIcons.set(ms.id, ms.icon);
    }
    this.marketplaceCache = { skills, categories };
    return this.marketplaceCache;
  } catch (error) {
    console.error('Failed to fetch marketplace skills:', error);
    return { skills: [], categories: [] };
  }
}
```

Note on the known tradeoff: the old code also read `value.localSkill` to seed `localSkillNames`/`localSkillDescriptions` and to set `skillIcons` for the *local* (non-marketplace) skills. The enterprise catalog does not carry that data, so local-skill i18n now relies on the remaining fallbacks in `getLocalizedSkillName`/`getLocalizedSkillDescription` (`installedKitSkillNames`, the bundled display-name map, and the local `Skill.description` from `skills:list`). For skills installed from the 企业 catalog this is fully covered by `marketplaceSkillNames`; only purely-local (never-catalog) skills lose their server-provided localized override. This is the intended consequence of replacing the skill store with the enterprise catalog — flag it, don't silently fake the data.

- [ ] **Step 6: Fix analytics**

In `src/renderer/components/skills/analytics.ts`, replace the two `tags: serializeSkillAnalyticsList(x?.tags ?? [])` lines (lines 37 and 57) with the single `category`:
```ts
tags: serializeSkillAnalyticsList(marketplaceSkill?.category ? [marketplaceSkill.category] : []),
// …and…
tags: serializeSkillAnalyticsList(skill.category ? [skill.category] : []),
```
(Keep the analytics param key named `tags` for event stability; only the value source changes.)

- [ ] **Step 7: Update `SkillsManager.tsx` to the category filter**

In `src/renderer/components/skills/SkillsManager.tsx` (line numbers are pre-change; re-locate by context):
- Import (line 17): replace `MarketTag` with `MarketCategory`.
- State (lines 92-93): `const [marketTags, setMarketTags] = useState<MarketTag[]>([])` → `const [categories, setCategories] = useState<MarketCategory[]>([])`; `const [activeMarketTag, setActiveMarketTag] = useState('all')` → `const [activeCategory, setActiveCategory] = useState('all')`.
- Fetch effect (line 154): `setMarketTags(data.tags)` → `setCategories(data.categories)`.
- Filter memo (lines 252-265): `results = results.filter(skill => skill.tags?.includes(activeMarketTag))` → `results = results.filter(skill => skill.category === activeCategory)`; and the `useMemo` dependency array `activeMarketTag` → `activeCategory` (line 265).
- **Card title: no change.** The 企业 card already renders `skillService.getLocalizedSkillName(skill.id, skill.name)` (line 1529), and the service now feeds `marketplaceSkillNames` with `{ en, zh }` (Step 5), so the title localizes for free — exactly the MCP card-title behavior.
- Facts-strip category badge (`getMarketplaceSkillStats`, line 958): `const categoryTag = skill.tags?.map(tagId => marketTags.find(tag => tag.id === tagId)).find(Boolean)` → `const categoryCat = categories.find(c => c.id === skill.category)`; when it exists, push `{ label: i18nService.t('skillDetailCategory'), value: resolveLocalizedText(categoryCat) }` (`MarketCategory` is `{en, zh}` so `resolveLocalizedText` picks by the active language, matching the MCP chip pattern).
- Chip row (lines 1334-1381): change the guard `marketTags.length > 0` → `categories.length > 0`; `marketTags.map((tag) => …)` → `categories.map((cat) => …)`; the chip label `resolveLocalizedText(tag)` stays (it now takes the `{en,zh}` category and localizes); `key={tag.id}` → `key={cat.id}`; `setActiveMarketTag(tag.id)` → `setActiveCategory(cat.id)`; and the "All"/active styling conditions `activeMarketTag === 'all'`/`=== tag.id` → `activeCategory === 'all'`/`=== cat.id`.
- Analytics: the `market_tag_change` event and any `activeMarketTag`/`targetMarketTag` param values (lines 1343-1344, 1365-1366, and the `resultCount`-bearing `reportSkillAction` call near 277-286) → use `activeCategory` / the active category id. Keep the event *name* `market_tag_change` and param *keys* stable for event continuity; only the values change.

- [ ] **Step 8: Run the tests + typecheck**

Run: `npx vitest run src/renderer/services/skill.test.ts && npx tsc --noEmit`
Expected: PASS + clean. (If a `SkillsManager` component test exists and now references `marketTags`/`activeMarketTag`, update it; there is currently no `SkillsManager.test.tsx`, so nothing to update — optionally add a focused one in this step asserting the filter narrows by `category`.)

- [ ] **Step 9: Lint + commit**

Run: `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/renderer/types/skill.ts src/renderer/types/electron.d.ts src/renderer/services/skill.ts src/renderer/components/skills/analytics.ts src/renderer/components/skills/SkillsManager.tsx`

```bash
git add src/renderer/types/skill.ts src/renderer/types/electron.d.ts src/renderer/services/skill.ts src/renderer/components/skills/analytics.ts src/renderer/components/skills/SkillsManager.tsx src/renderer/services/skill.test.ts
git commit -m "feat(desktop): show the enterprise skill catalog filtered by category"
```

---

## Final verification (after all tasks)

Run the full suites once (local-only, do not push):
- `cd enterprise_server && npx vitest run --no-file-parallelism`
- `cd enterprise_server/web && npx vitest run`
- `npx vitest run` (desktop) for the touched files: `src/main/skills/skillManager.test.ts src/main/ipcHandlers/skills/handlers.test.ts src/renderer/services/skill.test.ts`

Then a manual smoke (if the user wants): start `enterprise_server` + the SPA, add a category + a skill (upload a `.zip` with `SKILL.md`), set `allowed_roles`; then run the desktop and confirm the 企业 tab lists it (for a matching role) and installs it.
