# 技能管理重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the enterprise skill marketplace from role-based visibility (`allowed_roles`, no scope, no review) to **org-scoped + dept/member scope authorization + member-submission review flow + zip sha256 integrity + desktop consumption**, mirroring the MCP connector subsystem (migration 035), delivered across server + admin SPA + desktop in one pass.

**Architecture:** In-place upgrade of the existing `skill_marketplace_*` tables and `/api/skill-marketplace` endpoints (D2 — single live system, no second table). The server becomes the sole source of authorization: the desktop never holds scope rules; it only sees already-filtered rows. Admin CRUD + review + audit mirror `mcpConnectors.ts` / `mcpSubmissions.ts`; the admin SPA ports the MCP `ConnectorScopeSelector` and review four-components; the desktop adds sha256 verification and a call-time authorization gate that writes OpenClaw `skills.entries[name].enabled=false` while keeping the local directory.

**Tech Stack:** Server: Node/TypeScript, Hono, `pg` (prod) / `@electric-sql/pglite` (tests), `adm-zip`, `zod`. Admin SPA: React + React Query + zustand auth store, Tailwind. Desktop: Electron + React + Redux, main-process `electron` IPC, `node:crypto`.

**Spec:** `/Users/paulwang/work/GenWork/docs/superpowers/specs/2026-09-28-skill-management-refactor-design.md` — the plan argues from it; read both.

## Global Constraints

- **TypeScript** everywhere. Renderer i18n via `t('key')` from `src/renderer/services/i18n.ts` (en+zh pairs); admin SPA i18n via `t('key')` from `enterprise_server/web/src/i18n.ts` (en+zh pairs); server user-visible strings via `t('key')` from `src/main/i18n.ts` (desktop) — but the **enterprise server** uses raw English error codes (see below).
- **Error convention (enterprise server):** every route returns Hono responses directly with `c.json({ error: '<snake_case_code>' }, <status>)` — there is **no** error class/helper. `zod.safeParse` failures always attach `issues`.
- **Org scoping:** skill routes derive org from `claims.orgId` (set by `requireAuth`/`requirePermission`) — **not** a `?orgId=` query param (unlike MCP). All cross-org access → `404` (not `403`), to prevent id/name enumeration.
- **New error codes (do not exist yet, introduce):** `invalid_name` (400, bad top-dir slug), `name_conflict` (409, create/parse re-name), `name_mismatch` (409, re-upload top-dir ≠ existing name), `submission_disabled` (403, org switch off), plus reuse `invalid_body` / `unknown_category` / `not_found` / `too_large` / `bad_zip` / `empty_patch` / `reserved_category` / `not_pending` / `reason_required` / `forbidden` / `unauthorized`.
- **Name identity (D3):** `id == name` = zip top-level directory normalized to slug `^[a-z0-9][a-z0-9._-]*$`. Applied only to **new** create/re-upload. Existing rows keep their original `skill_id` (a slug) as `id` — never re-derive from a historical zip. Immutable after creation; org-unique; on approve collision auto-suffix `-2`.
- **zip ≤ 10 MB** (down from the current 50 MB `MAX_BYTES`). Download is Bearer, no signed URL, no sha256 in headers (sha256 ships in the list row).
- **Scope model (D1):** `scope = { allCompany: boolean, deptIds: string[], userIds: string[] }`, JSONB default `'{"allCompany":false,"deptIds":[],"userIds":[]}'`. Union semantics; `allCompany=true` ⇒ whole company. **Dept/member IDs validated for existence at save; invalid ids silently dropped** (this is NET-NEW logic — MCP stores scope unvalidated; do not copy that).
- **sha256:** server computes over the on-disk bytes at write time; desktop recomputes after download and compares to the list row's `sha256`; mismatch ⇒ delete partial package + "技能包校验失败，请重试".
- **Call-time gate (D6/§3.6):** default-**block** (safe first) when an installed org skill is missing from the visible list or `enabled=false` → write OpenClaw `skills.entries[name].enabled=false`; **keep the local directory** (data is not deleted, only blocked). Verify endpoint 5-min cache + degrade to last-known on failure.
- **Lint gate (touched files):** server + desktop main/renderer TS touched by each task must pass `npx eslint --ext ts,tsx --max-warnings 0 <files>`. Admin SPA must pass `tsc --noEmit` (0 errors) and i18n must have no unreferenced keys.
- **Commits:** Conventional Commits, English, **local only — never push** (per project memory). No `Co-Authored-By` trailers.
- **Migration re-run safety:** the test harness re-runs **every** `.sql` file on every run with no ledger — all statements must be idempotent (`ADD COLUMN IF NOT EXISTS`, guarded `INSERT … ON CONFLICT DO NOTHING`, `DROP COLUMN IF EXISTS`). No dollar-quoted `DO` blocks / PL/pgSQL (the statement splitter breaks on them).

## Review Focus

Five input classes the spec implies but that no single test naively pins — most likely to bite a real user, most-likely-first:

1. **Stale scope dept id (dept deleted after a skill was scoped to it).** A skill `scope.deptIds` references a department that has since been deleted, and a member in that dept's subtree logs in. Expect: the member **does not** see the skill (the deleted id is in neither the caller's `deptIdsFor` set nor the subtree of any existing dept), and no 500. Owning task: **T6** (public visibility test seeds a scope dept id that has no matching `departments` row).
2. **Empty scope (`allCompany:false`, no depts, no users).** A skill saved with an empty scope. Expect: invisible to every non-superadmin, visible to superadmin; **not** accidentally visible and **not** an error. Owning task: **T6** (public list) + **T4** (admin save of empty scope is allowed and stored as-is).
3. **Cross-org access by skill id (download / verify).** A caller from org B requests `GET /api/skill-marketplace/download/<id>` or `POST /verify` for an enabled skill that exists only in org A. Expect: `404` (never `403`, never `200`) so org B cannot confirm the id exists. Owning task: **T6** (download/verify re-check test uses a second org).
4. **sha256 mismatch after download (corrupt/in-flight bytes).** The downloaded zip's recomputed sha256 differs from the list row's `sha256`. Expect: the partial/temp package is deleted, a clear "校验失败，请重试" surfaces, and the skill is **not** installed. Owning task: **T17** (pure `verifySha256` test + `downloadZipUrl` mismatch path).
5. **Revoked/installed skill while the server is unreachable.** An org skill is installed, then the admin disables/deletes it, and the desktop's `verify`/list re-fetch fails (network down). Expect: per spec default-block the entry (`skills.entries[name].enabled=false`) but **keep the local dir**, degrade to last-known state (do not re-enable, do not crash-loop). Owning task: **T18** (gate pure-function test: list fetch throws ⇒ keep last-known disabled state; never re-enable).

---

## Milestone map (one delivery, four verification stages)

- **M1 — Server + data (T1–T8):** migration 038, model/scope helpers, parse-zip, admin CRUD + scope + audit, org-scoped categories, public org+scope filter + sha256, download/verify/events, settings, review-queue routes.
- **M2 — Admin SPA (T9–T14):** api client + scope type, scope-selector port, 7-column table + settings card + tabs, two-stage create/edit drawer, delete impact-list + i18n, review tab.
- **M3 — Review E2E (T15):** desktop member-submission entry (form + gate + IPC + service + shared type + `enterpriseClient.submitSkillRequest`).
- **M4 — Desktop consumption (T16–T19):** wire type drop-roles/add-sha256, sha256 verify, call-time authorization gate + 4th card state.

---

# M1 — Server + Data

## Task 1: Migration `038_org_skills.sql`

**Files:**
- Create: `enterprise_server/src/db/migrations/038_org_skills.sql`
- Test: `enterprise_server/tests/db/038_org_skills.test.ts`

**Interfaces:**
- Produces: org-scoped `skill_marketplace_skills` (new cols `org_id`, `scope`, `zip_file_name`, `zip_file_size`, `zip_sha256`, `use_count_30d`, `created_by`, `updated_by`; `allowed_roles` dropped), org-scoped `skill_marketplace_categories` (new `org_id` + `(org_id, category_id)` unique), new `skill_submissions` table, `orgs.members_can_submit_skills` column.
- Consumes: the 035 idiom (`CROSS JOIN (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1)` for backfill; quoted `"desc"`).

> **Why this shape:** 035 created new tables (fresh); 038 **upgrades in place** (D2). Existing `skill_marketplace_skills` rows keep their `skill_id` (a slug) as `id`/`name` — we do **not** backfill `name` from any zip. The backfill only assigns `org_id` to the oldest org and leaves scope at the default (empty ⇒ invisible to non-superadmin after M1; that is the safe state, and the migration is best-effort per §12). Per-org `uncategorized` buckets are created via `INSERT … SELECT` so each org gets its own reserved bucket.

- [ ] **Step 1: Write the failing migration test**

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

describe('migration 038 (org skills)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('skill_marketplace_skills has org/scope/zip cols and drops allowed_roles', async () => {
    const cols = await testPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'skill_marketplace_skills' ORDER BY column_name`,
    );
    const names = new Set(cols.rows.map((r) => r.column_name));
    for (const c of ['org_id', 'scope', 'zip_file_name', 'zip_file_size', 'zip_sha256', 'use_count_30d', 'created_by', 'updated_by']) {
      expect(names.has(c)).toBe(true);
    }
    expect(names.has('allowed_roles')).toBe(false);
  });

  test('categories get org_id + (org_id, category_id) unique; per-org uncategorized', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','A'), ('o2','B')`);
    const rows = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM skill_marketplace_categories WHERE category_id = 'uncategorized'`,
    );
    expect(rows.rows[0].n).toBe(2); // one per org
  });

  test('skill_submissions + orgs.members_can_submit_skills exist', async () => {
    const tbl = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'skill_submissions'`,
    );
    expect(tbl.rows[0].n).toBe(1);
    const org = await testPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'orgs' AND column_name = 'members_can_submit_skills'`,
    );
    expect(org.rows[0].n).toBe(1);
  });

  test('is re-run safe (idempotent)', async () => {
    await resetSchema();
    await runMigrations();
    // run every migration file a second time against the same pglite instance
    await runMigrations(); // must not throw
  });
});
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `cd enterprise_server && npx vitest run tests/db/038_org_skills.test.ts`
Expected: FAIL — `skill_marketplace_skills` lacks `org_id` etc. (migration 038 does not exist yet; the test runs against the 023 shape).

- [ ] **Step 3: Write migration 038**

Create `enterprise_server/src/db/migrations/038_org_skills.sql`:

```sql
-- Migration 038: org-scoped skill marketplace (replaces role-based visibility).
-- In-place upgrade of the 023 tables (D2): add org_id + scope + zip metadata +
-- usage + actor columns to skill_marketplace_skills, drop allowed_roles;
-- make categories org-scoped; add the member-submission (review) queue; add the
-- org "members can submit skills" switch; best-effort backfill existing rows.
--
-- Re-run safe (the test harness re-runs every file with no ledger check):
-- every ADD/DROP COLUMN uses IF NOT EXISTS / IF EXISTS; the reserved-bucket
-- seed is INSERT ... SELECT with ON CONFLICT DO NOTHING.
--
-- skill_submissions."desc" is quoted on purpose: DESC is a reserved word in the
-- column-definition context (same as 035's mcp_connector_submissions).

-- 1) Skills: org + scope + zip metadata + usage + actor; drop allowed_roles.
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT '';
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS scope JSONB NOT NULL
  DEFAULT '{"allCompany":false,"deptIds":[],"userIds":[]}'::jsonb;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS zip_file_name TEXT;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS zip_file_size INTEGER;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS zip_sha256 TEXT;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS use_count_30d INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE skill_marketplace_skills ADD COLUMN IF NOT EXISTS updated_by TEXT;
CREATE INDEX IF NOT EXISTS skill_marketplace_skills_org_idx ON skill_marketplace_skills (org_id);
CREATE INDEX IF NOT EXISTS skill_marketplace_skills_org_cat_idx ON skill_marketplace_skills (org_id, category_id);
ALTER TABLE skill_marketplace_skills DROP COLUMN IF EXISTS allowed_roles;

-- 2) Categories: org-scoped reserved bucket.
ALTER TABLE skill_marketplace_categories ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT '';
ALTER TABLE skill_marketplace_categories DROP CONSTRAINT IF EXISTS skill_marketplace_categories_pkey;
ALTER TABLE skill_marketplace_categories ADD CONSTRAINT skill_marketplace_categories_org_key UNIQUE (org_id, category_id);

-- 3) Member-submission (review) queue (mirrors mcp_connector_submissions).
CREATE TABLE IF NOT EXISTS skill_submissions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  "desc" TEXT,
  author_id TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  cfg JSONB NOT NULL,
  approved_skill_id TEXT
);
CREATE INDEX IF NOT EXISTS skill_submissions_org_idx ON skill_submissions (org_id, status);

-- 4) Org switch (default OFF — submissions gated until an admin enables it).
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS members_can_submit_skills BOOLEAN NOT NULL DEFAULT FALSE;

-- 5) Best-effort backfill: existing skills/categories → oldest org, non-destructive.
UPDATE skill_marketplace_skills
   SET org_id = (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1)
 WHERE org_id = '' AND (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1) IS NOT NULL;
UPDATE skill_marketplace_categories
   SET org_id = (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1)
 WHERE org_id = '' AND (SELECT id FROM orgs ORDER BY created_at, id LIMIT 1) IS NOT NULL;

-- Per-org reserved bucket (the global 'uncategorized' from 023 becomes o? scoped).
-- Seed a bucket for each existing org that lacks one, and for the seed bucket's
-- org. INSERT ... SELECT over distinct orgs; ON CONFLICT (org_id, category_id).
INSERT INTO skill_marketplace_categories (category_id, name_zh, name_en, display_order, org_id)
SELECT 'uncategorized', '未分类', 'Uncategorized', 0, o.id
FROM (SELECT DISTINCT org_id AS id FROM skill_marketplace_categories WHERE org_id <> '') o
ON CONFLICT (org_id, category_id) DO NOTHING;
```

> **Note on the global `uncategorized` row:** 023 inserted one row with `org_id` now defaulting to `''`. The `INSERT … SELECT` above seeds a bucket for every org that has *some* scoped category. For the org that owns the legacy `''` row, Task 5's category route + a one-time re-home ensures skills resolve. To keep the migration minimal and idempotent, the legacy `''`-org row is left as-is (it serves the oldest org which the backfill in step 5 assigns); the `ON CONFLICT` makes repeats safe.

- [ ] **Step 4: Run the test — confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/db/038_org_skills.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Lint + commit**

```bash
cd enterprise_server && npx tsc --noEmit
git add enterprise_server/src/db/migrations/038_org_skills.sql enterprise_server/tests/db/038_org_skills.test.ts
git commit -m "feat(skill-marketplace): add migration 038 (org scope, zip meta, submissions, org switch)"
```

---

## Task 2: Model — scope helpers + new skill columns/mappers

**Files:**
- Modify: `enterprise_server/src/models/skillMarketplaceView.ts`
- Test: `enterprise_server/tests/models/skillMarketplaceView.test.ts`

**Interfaces:**
- Produces:
  - `SkillScope` type `{ allCompany: boolean; deptIds: string[]; userIds: string[] }`
  - `scopeMatches(scope: SkillScope, callerDeptIds: string[], callerId: string): boolean` (pure)
  - `scopeSummary(scope: SkillScope): string` (pure; `'all'` / `'none'` / `depts:N` / `depts:N,users:M`)
  - `PUBLIC_SKILL_COLUMNS` (org_id, scope, zip meta, use_count_30d, updated_at, …; no `allowed_roles`)
  - `ADMIN_SKILL_COLUMNS` (adds `enabled`, `zip_file_name`, `zip_file_size`, `created_by`, `updated_by`)
  - `SkillPublicRow` / `SkillAdminRow` row interfaces
  - `mapPublicSkill(row): SkillPublicView` — `{ id, name, name_zh, description, category, version, icon, source, zipSize, sha256, updatedAt }`
  - `mapAdminSkill(row): SkillAdminView` — `{ id, name, name_zh, description, category, version, icon, scope, scopeSummary, zip: { fileName, fileSize }, enabled, useCount30d, updatedAt, createdBy, updatedBy }`
  - `UNCATEGORIZED` (kept)
- Consumes: nothing (pure). Mirrors `connectorView.ts:144-166` for `scopeMatches`/`scopeSummary`.

> The current `mapSkill` (single view, `allowed_roles`+`enabled`) is replaced by two mappers. `SKILL_COLUMNS` is replaced by `PUBLIC_SKILL_COLUMNS` + `ADMIN_SKILL_COLUMNS`. Keep `description` = `description_zh ?? description_en` (existing desktop contract).

- [ ] **Step 1: Write the failing pure-function tests**

```ts
import { describe, expect, test } from 'vitest';

import { scopeMatches, scopeSummary } from '../../src/models/skillMarketplaceView';

describe('scopeMatches (skill)', () => {
  const empty = { allCompany: false, deptIds: [] as string[], userIds: [] as string[] };
  test('allCompany grants everyone', () => {
    expect(scopeMatches({ allCompany: true, deptIds: [], userIds: [] }, [], 'u1')).toBe(true);
  });
  test('member exception via userIds', () => {
    expect(scopeMatches({ allCompany: false, deptIds: [], userIds: ['u1'] }, [], 'u1')).toBe(true);
    expect(scopeMatches({ allCompany: false, deptIds: [], userIds: ['u1'] }, [], 'u2')).toBe(false);
  });
  test('dept id in the caller (already-expanded) dept set', () => {
    expect(scopeMatches({ allCompany: false, deptIds: ['d1'], userIds: [] }, ['d1', 'd2'], 'u1')).toBe(true);
    expect(scopeMatches({ allCompany: false, deptIds: ['dX'], userIds: [] }, ['d1', 'd2'], 'u1')).toBe(false);
  });
  test('union: member OR dept', () => {
    const s = { allCompany: false, deptIds: ['d1'], userIds: ['u9'] };
    expect(scopeMatches(s, ['d1'], 'u9')).toBe(true);
    expect(scopeMatches(s, ['d1'], 'u1')).toBe(true);
    expect(scopeMatches(s, [], 'u1')).toBe(false);
  });
  test('empty scope grants no one', () => {
    expect(scopeMatches(empty, ['d1'], 'u1')).toBe(false);
  });
});

describe('scopeSummary (skill)', () => {
  test('all / none / depts / depts+users', () => {
    expect(scopeSummary({ allCompany: true, deptIds: [], userIds: [] })).toBe('all');
    expect(scopeSummary({ allCompany: false, deptIds: [], userIds: [] })).toBe('none');
    expect(scopeSummary({ allCompany: false, deptIds: ['a', 'b'], userIds: [] })).toBe('depts:2');
    expect(scopeSummary({ allCompany: false, deptIds: ['a'], userIds: ['x', 'y'] })).toBe('depts:1,users:2');
  });
});
```

- [ ] **Step 2: Run — confirm it fails**

Run: `cd enterprise_server && npx vitest run tests/models/skillMarketplaceView.test.ts`
Expected: FAIL — `scopeMatches`/`scopeSummary` not exported from the module.

- [ ] **Step 3: Implement the model changes**

Rewrite `enterprise_server/src/models/skillMarketplaceView.ts` (keep `UNCATEGORIZED`; replace `SKILL_COLUMNS`/`SkillRow`/`SkillMarketplaceView`/`mapSkill` with the new set). Full new file:

```ts
export const UNCATEGORIZED = 'uncategorized' as const;

export interface SkillScope {
  allCompany: boolean;
  deptIds: string[];
  userIds: string[];
}

/** A skill's scope grants a caller access iff allCompany, or the caller is a
 * member exception (userIds), or any granted dept id is present in the caller's
 * (already-subtree-expanded) dept set. Pure — no DB. Mirrors connectorView. */
export function scopeMatches(
  scope: SkillScope,
  callerDeptIds: string[],
  callerId: string,
): boolean {
  if (scope.allCompany) return true;
  if (scope.userIds.includes(callerId)) return true;
  return (scope.deptIds ?? []).some((d) => callerDeptIds.includes(d));
}

/** Compact display string for a scope. */
export function scopeSummary(scope: SkillScope): string {
  if (scope.allCompany) return 'all';
  const d = scope.deptIds?.length ?? 0;
  const u = scope.userIds?.length ?? 0;
  if (d === 0 && u === 0) return 'none';
  return `depts:${d}` + (u ? `,users:${u}` : '');
}

/** Columns for the public (desktop) list. No `allowed_roles`/`enabled` — the
 * public list only returns enabled rows for the caller's org/scope. */
export const PUBLIC_SKILL_COLUMNS = `skill_id, name_en, name_zh, description_en, description_zh,
  icon, version, category_id, source_json, org_id, scope, zip_file_size, zip_sha256, updated_at`;

/** Columns for the admin list (adds the write/scope/usage fields). */
export const ADMIN_SKILL_COLUMNS = `skill_id, name_en, name_zh, description_en, description_zh,
  icon, version, category_id, source_json, org_id, scope,
  zip_file_name, zip_file_size, zip_sha256, enabled, use_count_30d,
  created_by, updated_by, updated_at`;

export interface SkillPublicRow {
  skill_id: string;
  name_en: string;
  name_zh: string | null;
  description_en: string;
  description_zh: string | null;
  icon: string | null;
  version: string | null;
  category_id: string;
  source_json: { from?: string; url?: string; author?: string } | null;
  org_id: string;
  scope: SkillScope;
  zip_file_size: number | null;
  zip_sha256: string | null;
  updated_at: Date;
}

export interface SkillAdminRow {
  skill_id: string;
  name_en: string;
  name_zh: string | null;
  description_en: string;
  description_zh: string | null;
  icon: string | null;
  version: string | null;
  category_id: string;
  source_json: { from?: string; url?: string; author?: string } | null;
  org_id: string;
  scope: SkillScope;
  zip_file_name: string | null;
  zip_file_size: number | null;
  zip_sha256: string | null;
  enabled: boolean;
  use_count_30d: number;
  created_by: string | null;
  updated_by: string | null;
  updated_at: Date;
}

/** Public (desktop) wire shape. `id` == name == skill_id. `category` is the
 * category_id (desktop resolves the label from the categories list). */
export interface SkillPublicView {
  id: string;
  name: string;
  name_zh: string | null;
  description: string;
  category: string;
  version: string | null;
  icon: string | null;
  source: { from?: string; url?: string; author?: string } | null;
  zipSize: number | null;
  sha256: string | null;
  updatedAt: string;
}

/** Admin wire shape (7-column table + drawer). `👥N` in the UI = useCount30d. */
export interface SkillAdminView {
  id: string;
  name: string;
  name_zh: string | null;
  description: string;
  category: string;
  version: string | null;
  icon: string | null;
  scope: SkillScope;
  scopeSummary: string;
  zip: { fileName: string | null; fileSize: number | null };
  enabled: boolean;
  useCount30d: number;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export function mapPublicSkill(row: SkillPublicRow): SkillPublicView {
  return {
    id: row.skill_id,
    name: row.name_en,
    name_zh: row.name_zh,
    description: row.description_zh ?? row.description_en,
    category: row.category_id,
    version: row.version,
    icon: row.icon,
    source: row.source_json ?? null,
    zipSize: row.zip_file_size,
    sha256: row.zip_sha256,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function mapAdminSkill(row: SkillAdminRow): SkillAdminView {
  return {
    id: row.skill_id,
    name: row.name_en,
    name_zh: row.name_zh,
    description: row.description_zh ?? row.description_en,
    category: row.category_id,
    version: row.version,
    icon: row.icon,
    scope: row.scope,
    scopeSummary: scopeSummary(row.scope),
    zip: { fileName: row.zip_file_name, fileSize: row.zip_file_size },
    enabled: row.enabled,
    useCount30d: row.use_count_30d,
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/models/skillMarketplaceView.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

The old `mapSkill`/`SKILL_COLUMNS`/`SkillMarketplaceView` are still imported by `routes/skillMarketplace.ts` and `routes/skillMarketplaceAdmin.ts` (rewritten in T4/T6). To keep `tsc` green between tasks, this task is committed **together with** T4+T6 in a single logical unit **only if** typecheck fails — otherwise leave the routes referencing the old symbols and let T4/T6 remove them. In practice: implement T4 and T6 before committing T2's removal of `mapSkill`. For now, to keep this task self-contained and typecheck-clean, **leave a deprecated alias** at the bottom of the file:

```ts
/** @deprecated removed in T4/T6 — kept so the routes typecheck mid-migration. */
export const SKILL_COLUMNS = ADMIN_SKILL_COLUMNS;
```

Remove that alias in T6.

```bash
cd enterprise_server && npx eslint --ext ts,tsx --max-warnings 0 src/models/skillMarketplaceView.ts && npx tsc --noEmit
git add -A && git commit -m "feat(skill-marketplace): scope helpers + org/scope/zip columns and mappers"
```

---

## Task 3: `parse-zip` helper (server-side)

**Files:**
- Create: `enterprise_server/src/lib/skillZip.ts`
- Test: `enterprise_server/tests/lib/skillZip.test.ts`

**Interfaces:**
- Produces:
  - `SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/`
  - `MAX_ZIP_BYTES = 10 * 1024 * 1024`
  - `parseSkillZip(buf: Buffer): { name: string; version: string; size: number; sha256: string; fileName: string } | throws { code: 'empty' | 'too_large' | 'bad_zip' | 'invalid_name'; }`
  - `topLevelDir(zip: AdmZip): string` (pure-ish; the first common top-level dir containing `SKILL.md`)
- Consumes: `adm-zip` (already a dependency), `node:crypto`.

> This is the shared brain behind `POST /skills/parse-zip` (T4), re-upload (T4), and member-submission parse (T8). It reads the **top-level directory name** (→ `name`), the **SKILL.md frontmatter `version`** (default `1.0.0`), and computes **sha256** over the raw `buf`. It does **not** write to disk — callers persist to `skillStoreDir(name)/skill.zip`.

- [ ] **Step 1: Write the failing tests**

```ts
import AdmZip from 'adm-zip';
import { describe, expect, test } from 'vitest';

import { parseSkillZip } from '../../src/lib/skillZip';

function zipWith(topDir: string, files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content));
  }
  return zip.toBuffer();
}

describe('parseSkillZip', () => {
  test('reads top-level dir name, version from SKILL.md frontmatter, sha256/size', () => {
    const buf = zipWith('pdf-tool', {
      'pdf-tool/SKILL.md': '---\nname: pdf-tool\nversion: 2.3.1\ndescription: x\n---\nbody',
    });
    const out = parseSkillZip(buf);
    expect(out.name).toBe('pdf-tool');
    expect(out.version).toBe('2.3.1');
    expect(out.size).toBe(buf.byteLength);
    expect(out.fileName).toBe('pdf-tool.zip');
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('defaults version to 1.0.0 when frontmatter has none', () => {
    const buf = zipWith('plain-skill', { 'plain-skill/SKILL.md': '# hi' });
    expect(parseSkillZip(buf).version).toBe('1.0.0');
  });

  test('normalizes a non-slug top dir to lowercase slug or throws invalid_name', () => {
    // "My Skill" is not a valid slug and does not normalize cleanly -> invalid_name
    const buf = zipWith('My Skill', { 'My Skill/SKILL.md': '# x' });
    expect(() => parseSkillZip(buf)).toThrowError({ code: 'invalid_name' });
  });

  test('throws empty / too_large / bad_zip', () => {
    expect(() => parseSkillZip(Buffer.alloc(0))).toThrowError({ code: 'empty' });
    expect(() => parseSkillZip(Buffer.from('not a zip'))).toThrowError({ code: 'bad_zip' });
    // A zip with no SKILL.md anywhere
    expect(() => parseSkillZip(zipWith('x', { 'x/README.md': 'no skill here' }))).toThrowError({ code: 'bad_zip' });
  });

  test('rejects path traversal entry', () => {
    const buf = zipWith('safe', { 'safe/SKILL.md': '# x', 'safe/../evil.txt': 'boom' });
    expect(() => parseSkillZip(buf)).toThrowError({ code: 'bad_zip' });
  });
});
```

- [ ] **Step 2: Run — confirm it fails**

Run: `cd enterprise_server && npx vitest run tests/lib/skillZip.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `skillZip.ts`**

```ts
import crypto from 'node:crypto';

import AdmZip from 'adm-zip';

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const MAX_ZIP_BYTES = 10 * 1024 * 1024;

export class SkillZipError extends Error {
  constructor(
    public code: 'empty' | 'too_large' | 'bad_zip' | 'invalid_name',
    message: string,
  ) {
    super(message);
  }
}

/** First common top-level directory (the one that holds SKILL.md). */
function topLevelDir(zip: AdmZip): string {
  const dirs = new Set<string>();
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const first = e.entryName.split('/').filter(Boolean)[0];
    if (first) dirs.add(first);
  }
  // Exactly one top-level dir is the contract; SKILL.md must live inside it.
  const withSkillMd = [...dirs].filter((d) =>
    zip.getEntries().some((e) => !e.isDirectory && (e.entryName === `${d}/SKILL.md` || new RegExp(`^${escapeRe(d)}/.*SKILL\\.md$`).test(e.entryName))),
  );
  if (dirs.size !== 1 || withSkillMd.length === 0) {
    throw new SkillZipError('bad_zip', 'zip must contain exactly one top-level directory with a SKILL.md');
  }
  return withSkillMd[0];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readVersion(entry: AdmZip.IZipEntry): string {
  // SKILL.md YAML frontmatter: first `version:` line. Tolerant, best-effort.
  const text = entry.getData().toString('utf8');
  const m = text.match(/^version:\s*(\S+)/m);
  return m ? m[1].trim() : '1.0.0';
}

export function parseSkillZip(buf: Buffer): {
  name: string;
  version: string;
  size: number;
  sha256: string;
  fileName: string;
} {
  if (buf.byteLength === 0) throw new SkillZipError('empty', 'empty zip');
  if (buf.byteLength > MAX_ZIP_BYTES) throw new SkillZipError('too_large', `zip exceeds ${MAX_ZIP_BYTES} bytes`);

  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch {
    throw new SkillZipError('bad_zip', 'unparseable zip');
  }

  // Path traversal guard.
  for (const e of zip.getEntries()) {
    if (e.entryName.split('/').some((seg) => seg === '..' || seg === '.')) {
      throw new SkillZipError('bad_zip', 'zip entry path traversal');
    }
  }

  const top = topLevelDir(zip);
  const normalized = top.toLowerCase();
  if (!SLUG_RE.test(normalized)) {
    throw new SkillZipError('invalid_name', `top-level directory "${top}" is not a valid slug`);
  }
  const skillMd = zip.getEntry(`${normalized}/SKILL.md`);
  if (!skillMd) throw new SkillZipError('bad_zip', 'SKILL.md missing in top-level directory');

  return {
    name: normalized,
    version: readVersion(skillMd),
    size: buf.byteLength,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    fileName: `${normalized}.zip`,
  };
}
```

- [ ] **Step 4: Run — confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/lib/skillZip.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd enterprise_server && npx eslint --ext ts --max-warnings 0 src/lib/skillZip.ts tests/lib/skillZip.test.ts
git add -A && git commit -m "feat(skill-marketplace): server-side zip parse (top-dir name, version, sha256)"
```

---

## Task 4: Admin CRUD + scope validation + audit (rework `skillMarketplaceAdmin.ts`)

**Files:**
- Modify: `enterprise_server/src/routes/skillMarketplaceAdmin.ts`
- Modify: `enterprise_server/src/shared/enterpriseServerConstants.ts` (add `Skill*` audit actions)
- Test: `enterprise_server/tests/routes/skillMarketplaceAdmin.test.ts` (rework existing)

**Interfaces:**
- Consumes: `parseSkillZip` (T3), `scopeMatches`/`SkillScope` (T2), `skillStoreDir`, `auditStore.write`, `requirePermission(PP.SkillCreate/View/Edit)`, `descendantsOf`? no — existence checks here use direct `departments`/`users` queries.
- Produces (routes under `/api/admin/skill-marketplace/*`):
  - `POST /skills/parse-zip` — body = raw zip (≤10MB) → `{ name, version, size, sha256, tempToken }`; temp zip persisted to `skillStoreDir('__tmp_'+tempToken)/skill.zip`. `name_conflict` (409) if `name` is already a skill id in the org.
  - `POST /skills` — body `{ tempToken, nameZh?, author?, category_id, desc?, icon?, scope }` → validates tempToken, category exists (org), sanitizes scope; inserts `id=name`, `enabled=true` → `{ skill_id }`.
  - `PATCH /skills/:id` — `{ nameZh?, author?, desc?, icon?, category_id?, scope?, enabled? }` → `empty_patch` 400; updates `updated_by`/`updated_at`.
  - `POST /skills/:id/zip` — re-upload; top-dir must == existing `name` else `name_mismatch` 409; overwrite zip + bump version + recompute sha256/size.
  - `DELETE /skills/:id` — hard delete + `rm` zip dir.
  - `GET /skills` — org full (incl. disabled), `ORDER BY updated_at DESC`, `mapAdminSkill`.
  - **audit on every write** (create/edit/toggle/delete via `auditStore.write`).
- Produces (helper, exported for tests): `sanitizeScope(scope: SkillScope, orgId: string): Promise<SkillScope>` — drops dept ids not in `departments.org_id`, drops user ids not in `users.org_id`; keeps `allCompany` as-is.

> **Error-code note:** `name_conflict`/`name_mismatch` are NEW (do not exist in MCP). `desc` (single string ≤200) is written to `description_zh` (display) and mirrored to `description_en` for back-compat (spec §4). `author`/`nameZh` map to `source_json.author` and `name_zh` respectively (existing columns).

- [ ] **Step 1: Add `Skill*` audit action constants**

Add to `enterprise_server/src/shared/enterpriseServerConstants.ts` inside the `AuditAction` const object (next to the `Mcp*` block):

```ts
  SkillCreate: 'skill_create',
  SkillUpdate: 'skill_update',
  SkillToggle: 'skill_toggle',
  SkillDelete: 'skill_delete',
  SkillCategoryCreate: 'skill_category_create',
  SkillCategoryUpdate: 'skill_category_update',
  SkillCategoryDelete: 'skill_category_delete',
  SkillSubmissionSubmit: 'skill_submission_submit',
  SkillSubmissionApprove: 'skill_submission_approve',
  SkillSubmissionReject: 'skill_submission_reject',
  SkillSubmissionWithdraw: 'skill_submission_withdraw',
```

- [ ] **Step 2: Write the failing route tests**

Replace the top of `enterprise_server/tests/routes/skillMarketplaceAdmin.test.ts` with the pglite harness + rework the cases (keep the harness pattern from the existing file — `vi.mock('../../src/db/pool')`, `Hono`, `signToken`, `beforeEach(resetSchema + runMigrations)`):

```ts
import '../helpers/setupEnv';

import AdmZip from 'adm-zip';
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
const admin = async (org = 'o1') => signToken({ sub: 'a', orgId: org, roles: ['super_admin'] });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const zip = (top: string, skillMd = '---\nversion: 1.0.0\n---\n# x') =>
  (() => { const z = new AdmZip(); z.addFile(`${top}/SKILL.md`, Buffer.from(skillMd)); return z.toBuffer(); })();

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','A'), ('o2','B')`);
  await testPool.query(`INSERT INTO skill_marketplace_categories(category_id, name_zh, name_en, display_order, org_id)
    VALUES ('c1','分类一','Cat1',0,'o1')`);
});

describe('skill admin (org scope + scope sanitize + audit)', () => {
  test('parse-zip returns name/version/sha256/tempToken', async () => {
    const res = await app.request('/api/admin/skill-marketplace/skills/parse-zip', {
      method: 'POST', headers: { ...auth(await admin()), 'content-type': 'application/zip' }, body: new Uint8Array(zip('pdf-tool')),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBe('pdf-tool');
    expect(body.version).toBe('1.0.0');
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.tempToken).toBe('string');
  });

  test('parse-zip name_conflict when name already exists', async () => {
    await testPool.query(`INSERT INTO skill_marketplace_skills(skill_id, name_en, description_en, category_id, org_id, enabled) VALUES ('pdf-tool','pdf-tool','d','c1','o1',true)`);
    const res = await app.request('/api/admin/skill-marketplace/skills/parse-zip', {
      method: 'POST', headers: { ...auth(await admin()), 'content-type': 'application/zip' }, body: new Uint8Array(zip('pdf-tool')),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('name_conflict');
  });

  test('POST /skills two-stage insert + scope sanitized (invalid dept dropped) + audit', async () => {
    await testPool.query(`INSERT INTO departments(id, org_id, name, parent_id, path) VALUES ('d1','o1','R',NULL,'/R')`);
    await testPool.query(`INSERT INTO users(id, org_id, username, password_hash) VALUES ('u1','o1','u1','x')`);
    const p = await app.request('/api/admin/skill-marketplace/skills/parse-zip', { method: 'POST', headers: { ...auth(await admin()), 'content-type': 'application/zip' }, body: new Uint8Array(zip('pdf-tool')) });
    const { tempToken } = (await p.json()) as any;
    const res = await app.request('/api/admin/skill-marketplace/skills', {
      method: 'POST',
      headers: { ...auth(await admin()), 'content-type': 'application/json' },
      body: JSON.stringify({ tempToken, category_id: 'c1', desc: 'desc', scope: { allCompany: false, deptIds: ['d1', 'ghost-dept'], userIds: ['u1', 'ghost-user'] } }),
    });
    expect(res.status).toBe(200);
    const { skill_id } = (await res.json()) as any;
    expect(skill_id).toBe('pdf-tool');
    const row = await testPool.query<any>(`SELECT scope FROM skill_marketplace_skills WHERE skill_id='pdf-tool' AND org_id='o1'`);
    expect(row.rows[0].scope.deptIds).toEqual(['d1']);      // ghost-dept dropped
    expect(row.rows[0].scope.userIds).toEqual(['u1']);      // ghost-user dropped
    const audit = await testPool.query(`SELECT 1 FROM audit_events WHERE action='skill_create' AND target_id='pdf-tool'`);
    expect(audit.rowCount).toBe(1);
  });

  test('PATCH toggle writes enabled + audit skill_toggle', async () => {
    await seedOneSkill('pdf-tool');
    const res = await app.request('/api/admin/skill-marketplace/skills/pdf-tool', {
      method: 'PATCH', headers: { ...auth(await admin()), 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const row = await testPool.query<any>(`SELECT enabled FROM skill_marketplace_skills WHERE skill_id='pdf-tool'`);
    expect(row.rows[0].enabled).toBe(false);
    const audit = await testPool.query(`SELECT 1 FROM audit_events WHERE action='skill_toggle' AND target_id='pdf-tool'`);
    expect(audit.rowCount).toBe(1);
  });

  test('PATCH empty_patch -> 400', async () => {
    await seedOneSkill('pdf-tool');
    const res = await app.request('/api/admin/skill-marketplace/skills/pdf-tool', {
      method: 'PATCH', headers: { ...auth(await admin()), 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('empty_patch');
  });

  test('re-upload name_mismatch when top dir != existing name', async () => {
    await seedOneSkill('pdf-tool');
    const res = await app.request('/api/admin/skill-marketplace/skills/pdf-tool/zip', {
      method: 'POST', headers: { ...auth(await admin()), 'content-type': 'application/zip' }, body: new Uint8Array(zip('other-name')),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('name_mismatch');
  });

  test('GET /skills is org-scoped (o1 skill invisible to o2 admin)', async () => {
    await seedOneSkill('pdf-tool', 'o1');
    const res = await app.request('/api/admin/skill-marketplace/skills', { headers: auth(await admin('o2')) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any[]).length).toBe(0);
  });

  async function seedOneSkill(name: string, org = 'o1') {
    await testPool.query(`INSERT INTO skill_marketplace_skills(skill_id, name_en, description_en, category_id, org_id, enabled)
      VALUES ($1,$1,'d','c1',$2,true)`, [name, org]);
  }
});
```

- [ ] **Step 3: Run — confirm it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/skillMarketplaceAdmin.test.ts`
Expected: FAIL — routes still on the old shape (no `parse-zip`, `POST /skills` expects `skill_id`+`allowed_roles`, no scope/audit).

- [ ] **Step 4: Rework `skillMarketplaceAdmin.ts`**

Key changes (keep the file's existing Hono sub-app + `requireAuth` + `requirePermission(PP.*)` style; replace bodies). The `sanitizeScope` helper + the new route bodies:

```ts
// (top of file, near other imports)
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import { MAX_ZIP_BYTES, SLUG_RE, parseSkillZip, SkillZipError } from '../lib/skillZip';
import { skillStoreDir } from '../lib/stateDir';
import { AuditAction } from '../shared/enterpriseServerConstants';
import { PP } from '../shared/permissionPoints';
import { UNCATEGORIZED, type SkillScope } from '../models/skillMarketplaceView';
```

```ts
const scopeSchema = z.object({
  allCompany: z.boolean().optional().default(false),
  deptIds: z.array(z.string()).optional().default([]),
  userIds: z.array(z.string()).optional().default([]),
});

/** Drop dept/user ids that do not exist in the org; keep allCompany. */
export async function sanitizeScope(scope: SkillScope, orgId: string): Promise<SkillScope> {
  const deptR = scope.deptIds.length
    ? await pool.query<{ id: string }>('SELECT id FROM departments WHERE org_id = $1 AND id = ANY($2)', [orgId, scope.deptIds])
    : { rows: [] as { id: string }[] };
  const userR = scope.userIds.length
    ? await pool.query<{ id: string }>('SELECT id FROM users WHERE org_id = $1 AND id = ANY($2)', [orgId, scope.userIds])
    : { rows: [] as { id: string }[] };
  return {
    allCompany: scope.allCompany,
    deptIds: deptR.rows.map((r) => r.id),
    userIds: userR.rows.map((r) => r.id),
  };
}
```

`POST /skills/parse-zip` (gated `PP.SkillCreate`):

```ts
skillMarketplaceAdminRoutes.post('/api/admin/skill-marketplace/skills/parse-zip', requirePermission(PP.SkillCreate), async (c) => {
  const claims = c.get('claims');
  const buf = Buffer.from(await c.req.arrayBuffer());
  let parsed;
  try { parsed = parseSkillZip(buf); }
  catch (e) { if (e instanceof SkillZipError) return c.json({ error: e.code }, e.code === 'too_large' ? 413 : 400); throw e; }
  const taken = await pool.query('SELECT 1 FROM skill_marketplace_skills WHERE org_id = $1 AND skill_id = $2', [claims.orgId, parsed.name]);
  if (taken.rowCount > 0) return c.json({ error: 'name_conflict' }, 409);
  const tempToken = randomUUID();
  const tmpDir = skillStoreDir(`__tmp_${tempToken}`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'skill.zip'), buf);
  return c.json({ name: parsed.name, version: parsed.version, size: parsed.size, sha256: parsed.sha256, tempToken });
});
```

`POST /skills` (gated `PP.SkillCreate`) — name is recovered by re-parsing the temp zip (the parse-zip step stored only the bytes, not the name):

```ts
const skillCreateSchema = z.object({
  tempToken: z.string().min(1),
  nameZh: z.string().optional(),
  author: z.string().optional(),
  category_id: z.string().min(1),
  desc: z.string().max(200).optional(),
  icon: z.string().optional(),
  scope: scopeSchema,
});
skillMarketplaceAdminRoutes.post('/api/admin/skill-marketplace/skills', requirePermission(PP.SkillCreate), async (c) => {
  const claims = c.get('claims');
  const parsed = skillCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  const tmpDir = skillStoreDir(`__tmp_${b.tempToken}`);
  const tmpZip = join(tmpDir, 'skill.zip');
  if (!existsSync(tmpZip)) return c.json({ error: 'not_found' }, 404); // temp token expired/invalid
  const fs = await import('node:fs');
  const meta = parseSkillZip(fs.readFileSync(tmpZip));
  const catOk = await pool.query('SELECT 1 FROM skill_marketplace_categories WHERE org_id = $1 AND category_id = $2', [claims.orgId, b.category_id]);
  if (catOk.rowCount === 0) return c.json({ error: 'unknown_category' }, 400);
  const scope = await sanitizeScope(b.scope, claims.orgId);
  const desc = b.desc ?? meta.name;
  await pool.query(
    `INSERT INTO skill_marketplace_skills (skill_id, name_en, name_zh, description_en, description_zh, icon, version, category_id, source_json, org_id, scope, zip_file_name, zip_file_size, zip_sha256, enabled, created_by, updated_by)
     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,$14,$14)`,
    [meta.name, b.nameZh ?? null, desc, desc, b.icon ?? null, meta.version, b.category_id,
     JSON.stringify({ author: b.author ?? undefined }), claims.orgId, JSON.stringify(scope),
     meta.fileName, meta.size, meta.sha256, claims.sub],
  );
  const storeDir = skillStoreDir(meta.name);
  rmSync(storeDir, { recursive: true, force: true });
  mkdirSync(storeDir, { recursive: true });
  fs.copyFileSync(tmpZip, join(storeDir, 'skill.zip'));
  rmSync(tmpDir, { recursive: true, force: true });
  await auditStore.write({ orgId: claims.orgId, userId: claims.sub, action: AuditAction.SkillCreate, targetType: 'skill', targetId: meta.name, payload: { version: meta.version } });
  return c.json({ skill_id: meta.name });
});
```

`PATCH /skills/:id` (gated `PP.SkillEdit`) — build a dynamic SET from `{ nameZh?, author?, desc?, icon?, category_id?, scope?, enabled? }`; sanitize scope if present; if `category_id` present verify it exists in org (`unknown_category`); `enabled` change → also `SkillToggle` audit; always `empty_patch` 400 when nothing set; `updated_by=claims.sub, updated_at=now()`; `SkillUpdate` audit.

`POST /skills/:id/zip` (gated `PP.SkillEdit`) — `parseSkillZip(buf)`; if `parsed.name !== id` → `name_mismatch` 409; overwrite `skillStoreDir(id)/skill.zip`, `UPDATE` version + zip meta + `updated_by`/`updated_at`.

`DELETE /skills/:id` (gated `PP.SkillEdit`) — `DELETE … WHERE skill_id=$1 AND org_id=$2`; 404 `not_found` if 0 rows; `rmSync(skillStoreDir(id), {recursive,force})`; `SkillDelete` audit.

`GET /skills` (gated `PP.SkillView`) — `SELECT ${ADMIN_SKILL_COLUMNS} FROM skill_marketplace_skills WHERE org_id = $1 ORDER BY updated_at DESC` → `mapAdminSkill`.

> Update the existing category CRUD in this file to be **org-scoped** (see T5 — the category tests live in T5 but the route code is here; apply the org scoping in this task so the file compiles).

- [ ] **Step 5: Run — confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/skillMarketplaceAdmin.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

```bash
cd enterprise_server && npx eslint --ext ts --max-warnings 0 src/routes/skillMarketplaceAdmin.ts src/shared/enterpriseServerConstants.ts && npx tsc --noEmit
git add -A && git commit -m "feat(skill-marketplace): two-stage admin CRUD with org scope, scope sanitize, and audit"
```

---

## Task 5: Org-scoped category CRUD

**Files:**
- Modify: `enterprise_server/src/routes/skillMarketplaceAdmin.ts` (category routes — org-scoped)
- Test: `enterprise_server/tests/routes/skillCategories.test.ts`

**Interfaces:**
- Produces: org-scoped category routes:
  - `GET /categories` — `WHERE org_id = claims.orgId ORDER BY display_order, category_id` → `[{ id, name_zh, name_en, display_order }]`
  - `POST /categories` — body `{ name_zh, name_en, display_order? }`; server generates `category_id` as a slug of `name_en` (org-unique); `ON CONFLICT (org_id, category_id) DO NOTHING` → `category_name_taken`-equivalent: return `409 { error: 'name_conflict' }` if the slug already exists in the org.
  - `PUT /categories/:id` — `{ name_zh?, name_en? }`, org-scoped; `not_found` 404.
  - `DELETE /categories/:id` — `uncategorized` (any org) → `reserved_category` 409; re-home skills to that org's `uncategorized`; delete; org-scoped.
  - all write ops `auditStore.write` (`SkillCategory*`).

- [ ] **Step 1: Write the failing tests**

```ts
import '../helpers/setupEnv';

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
const admin = (org = 'o1') => signToken({ sub: 'a', orgId: org, roles: ['super_admin'] });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','A'), ('o2','B')`);
});

describe('skill categories (org-scoped)', () => {
  test('create category scoped to org; duplicate slug -> name_conflict', async () => {
    const r1 = await app.request('/api/admin/skill-marketplace/categories', {
      method: 'POST', headers: { ...auth(await admin()), 'content-type': 'application/json' },
      body: JSON.stringify({ name_zh: '设计', name_en: 'Design' }),
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request('/api/admin/skill-marketplace/categories', {
      method: 'POST', headers: { ...auth(await admin()), 'content-type': 'application/json' },
      body: JSON.stringify({ name_zh: '设计', name_en: 'Design' }),
    });
    expect(r2.status).toBe(409);
    expect((await r2.json() as any).error).toBe('name_conflict');
  });

  test('delete uncategorized -> reserved_category', async () => {
    const res = await app.request('/api/admin/skill-marketplace/categories/uncategorized', { method: 'DELETE', headers: auth(await admin()) });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('reserved_category');
  });

  test('categories are org-isolated', async () => {
    await app.request('/api/admin/skill-marketplace/categories', {
      method: 'POST', headers: { ...auth(await admin('o1')), 'content-type': 'application/json' },
      body: JSON.stringify({ name_zh: '设计', name_en: 'Design' }),
    });
    const res = await app.request('/api/admin/skill-marketplace/categories', { headers: auth(await admin('o2')) });
    const list = (await res.json()) as any[];
    expect(list.some((c) => c.name_en === 'Design')).toBe(false);
  });
});
```

- [ ] **Step 2: Run — confirm it fails** (categories still global / old shape)
- [ ] **Step 3: Implement the org-scoped category routes** (per the interface above; slug = `name_en.toLowerCase().replace(/\s+/g, '-')`; re-home uses `UPDATE skill_marketplace_skills SET category_id='uncategorized' WHERE org_id=$1 AND category_id=$2`).
- [ ] **Step 4: Run — confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/skillCategories.test.ts`
- [ ] **Step 5: Lint + commit**

```bash
cd enterprise_server && npx eslint --ext ts --max-warnings 0 src/routes/skillMarketplaceAdmin.ts && npx tsc --noEmit
git add -A && git commit -m "feat(skill-marketplace): org-scoped category CRUD with reserved bucket"
```

---

## Task 6: Public route — org+scope filter + sha256, download/verify/events

**Files:**
- Modify: `enterprise_server/src/routes/skillMarketplace.ts`
- Test: `enterprise_server/tests/routes/skillMarketplace.test.ts`

**Interfaces:**
- Consumes: `PUBLIC_SKILL_COLUMNS`/`mapPublicSkill`/`scopeMatches` (T2), `skillStoreDir`, `scopeApi.deptIdsFor`, `descendantsOf`, `pool`.
- Produces (under `/api/skill-marketplace`, `requireAuth`, **server-side org+scope filter**):
  - `GET /` — `enabled=TRUE` AND `org_id=claims.orgId` AND (superadmin ∨ scopeMatches). Superadmin sees all in org. Response `{ categories, skills }` where `skills` = `mapPublicSkill` (no `allowed_roles`/`enabled`, has `zipSize`/`sha256`). Categories = only those used by visible skills, org-scoped. `ORDER BY updated_at DESC`.
  - `GET /download/:id` — re-check org + enabled + scope (cross-org / disabled → `404`); stream `skillStoreDir(id)/skill.zip`.
  - `POST /verify` — body `{ name }` → re-check org + enabled + scope → `{ allowed: boolean }`.
  - `POST /events` — body `{ name, event }` → best-effort `UPDATE use_count_30d = use_count_30d + 1` for install/update/invoke; never blocks, always 200.

> **Visibility is fully server-side** (spec §5.2): the caller's leaf depts come from `scopeApi.deptIdsFor(orgId, sub)`; a skill's granted `deptIds` are expanded to their subtree via `descendantsOf(granted, deptPath)`; visible iff `superadmin` ∨ `allCompany` ∨ `userIds∋sub` ∨ `(callerDepts ∩ grantedSubtree) ≠ ∅`. This mirrors `mcpMarketplace.ts` exactly. **Stale scope dept ids and empty scopes** are the Review-Focus #1/#2 cases — covered by the tests below.

- [ ] **Step 1: Write the failing tests**

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { scopeApi } from '../../src/auth/scopeResolver';
import { skillMarketplaceRoutes } from '../../src/routes/skillMarketplace';

const app = new Hono();
app.route('/', skillMarketplaceRoutes);
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  await resetSchema();
  await runMigrations();
  await scopeApi.invalidate();
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','A'), ('o2','B')`);
  await testPool.query(`INSERT INTO departments(id, org_id, name, parent_id, path) VALUES
    ('d1','o1','Root',NULL,'/Root'), ('d2','o1','Child','d1','/Root/Child')`);
  await testPool.query(`INSERT INTO users(id, org_id, username, password_hash) VALUES
    ('u-root','o1','ur','x'), ('u-child','o1','uc','x'), ('u-priv','o1','up','x')`);
  await testPool.query(`INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES
    ('u-root','d1',true), ('u-child','d2',true), ('u-priv','d1',true)`);
  await testPool.query(`INSERT INTO skill_marketplace_categories(category_id, name_zh, name_en, display_order, org_id)
    VALUES ('c1','分类一','Cat1',0,'o1')`);
});

async function skill(id: string, org: string, scope: object, enabled = true) {
  await testPool.query(
    `INSERT INTO skill_marketplace_skills(skill_id,name_en,description_en,category_id,org_id,scope,enabled,zip_sha256,zip_file_size)
     VALUES ($1,$1,'d','c1',$2,$3,$4,repeat('a',64),100)`,
    [id, org, JSON.stringify(scope), enabled],
  );
}

describe('public skill marketplace (org + scope filter)', () => {
  test('allCompany visible to a member', async () => {
    await skill('s-all', 'o1', { allCompany: true, deptIds: [], userIds: [] });
    const res = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    const body = (await res.json()) as any;
    expect(body.skills.map((s: any) => s.id)).toContain('s-all');
    expect('sha256' in body.skills[0]).toBe(true);
    expect('allowed_roles' in body.skills[0]).toBe(false);
  });

  test('dept scope: member in child dept sees a skill granted to root', async () => {
    await skill('s-root', 'o1', { allCompany: false, deptIds: ['d1'], userIds: [] });
    const res = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    const body = (await res.json()) as any;
    expect(body.skills.map((s: any) => s.id)).toContain('s-root');
  });

  test('member-exception scope', async () => {
    await skill('s-priv', 'o1', { allCompany: false, deptIds: [], userIds: ['u-priv'] });
    const yes = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-priv', orgId: 'o1', roles: ['member'] })) });
    const no = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    expect(((await yes.json()) as any).skills.map((s: any) => s.id)).toContain('s-priv');
    expect(((await no.json()) as any).skills.map((s: any) => s.id)).not.toContain('s-priv');
  });

  test('stale scope dept id: member in deleted dept subtree does NOT see it, no 500', async () => {
    // skill scoped to a dept id that does not exist in departments
    await skill('s-ghost', 'o1', { allCompany: false, deptIds: ['ghost-dept'], userIds: [] });
    const res = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).skills.map((s: any) => s.id)).not.toContain('s-ghost');
  });

  test('empty scope: invisible to non-superadmin, visible to superadmin', async () => {
    await skill('s-empty', 'o1', { allCompany: false, deptIds: [], userIds: [] });
    const member = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    const superadmin = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'sa', orgId: 'o1', roles: ['super_admin'] })) });
    expect(((await member.json()) as any).skills.map((s: any) => s.id)).not.toContain('s-empty');
    expect(((await superadmin.json()) as any).skills.map((s: any) => s.id)).toContain('s-empty');
  });

  test('cross-org: o2 member sees none of o1 skills (incl. allCompany)', async () => {
    await skill('s-all', 'o1', { allCompany: true, deptIds: [], userIds: [] });
    const res = await app.request('/api/skill-marketplace', { headers: auth(await signToken({ sub: 'o2user', orgId: 'o2', roles: ['member'] })) });
    expect(((await res.json()) as any).skills).toEqual([]);
  });
});

describe('download / verify / events (re-check + cross-org 404)', () => {
  beforeEach(async () => {
    // (reuse the org/dept/user/category seed from the top-level beforeEach)
    await skill('s-all', 'o1', { allCompany: true, deptIds: [], userIds: [] });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { skillStoreDir } = await import('../../src/lib/stateDir');
    mkdirSync(skillStoreDir('s-all'), { recursive: true });
    writeFileSync(path.join(skillStoreDir('s-all'), 'skill.zip'), Buffer.from('zipbytes'));
  });

  test('download 200 for authorized member', async () => {
    const res = await app.request('/api/skill-marketplace/download/s-all', { headers: auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })) });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('zipbytes');
  });

  test('download cross-org -> 404 (no enumeration)', async () => {
    const res = await app.request('/api/skill-marketplace/download/s-all', { headers: auth(await signToken({ sub: 'o2user', orgId: 'o2', roles: ['member'] })) });
    expect(res.status).toBe(404);
  });

  test('verify returns allowed=true / cross-org false', async () => {
    const ok = await app.request('/api/skill-marketplace/verify', { method: 'POST', headers: { ...auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })), 'content-type': 'application/json' }, body: JSON.stringify({ name: 's-all' }) });
    const cross = await app.request('/api/skill-marketplace/verify', { method: 'POST', headers: { ...auth(await signToken({ sub: 'o2user', orgId: 'o2', roles: ['member'] })), 'content-type': 'application/json' }, body: JSON.stringify({ name: 's-all' }) });
    expect((await ok.json()) as any).toEqual({ allowed: true });
    expect((await cross.json()) as any).toEqual({ allowed: false });
  });

  test('events increments use_count_30d and never 500s', async () => {
    const res = await app.request('/api/skill-marketplace/events', { method: 'POST', headers: { ...auth(await signToken({ sub: 'u-child', orgId: 'o1', roles: ['member'] })), 'content-type': 'application/json' }, body: JSON.stringify({ name: 's-all', event: 'invoke' }) });
    expect(res.status).toBe(200);
    const row = await testPool.query<any>(`SELECT use_count_30d FROM skill_marketplace_skills WHERE skill_id='s-all'`);
    expect(row.rows[0].use_count_30d).toBe(1);
  });
});
```

- [ ] **Step 2: Run — confirm it fails**
- [ ] **Step 3: Rewrite `skillMarketplace.ts`** (the visibility block mirrors `mcpMarketplace.ts`:

```ts
skillMarketplaceRoutes.get('/api/skill-marketplace', async (c) => {
  const claims = c.get('claims');
  const orgId = claims.orgId;
  const isSuperAdmin = (claims.roles ?? []).includes(Role.SuperAdmin);
  const callerDepts = isSuperAdmin ? [] : await scopeApi.deptIdsFor(orgId, claims.sub);
  const callerSet = new Set(callerDepts);
  const deptRows = await pool.query<{ id: string; path: string }>(`SELECT id, path FROM departments WHERE org_id = $1`, [orgId]);
  const deptPath = new Map(deptRows.rows.map((r) => [r.id, r.path]));
  const r = await pool.query<SkillPublicRow>(
    `SELECT ${PUBLIC_SKILL_COLUMNS} FROM skill_marketplace_skills WHERE org_id = $1 AND enabled = TRUE`, [orgId]);
  const visible = r.rows.filter((row) => {
    if (isSuperAdmin) return true;
    if (row.scope?.allCompany) return true;
    if ((row.scope?.userIds ?? []).includes(claims.sub)) return true;
    const grantedSubtree = descendantsOf(row.scope?.deptIds ?? [], deptPath);
    for (const d of callerSet) if (grantedSubtree.has(d)) return true;
    return false;
  });
  const catIds = Array.from(new Set(visible.map((v) => v.category_id)));
  const cats = catIds.length === 0
    ? { rows: [] as { category_id: string; name_zh: string; name_en: string }[] }
    : await pool.query<{ category_id: string; name_zh: string; name_en: string }>(
        `SELECT category_id, name_zh, name_en FROM skill_marketplace_categories WHERE org_id = $1 AND category_id = ANY($2) ORDER BY category_id`,
        [orgId, catIds]);
  return c.json({
    categories: cats.rows.map((cat) => ({ id: cat.category_id, name_zh: cat.name_zh, name_en: cat.name_en })),
    skills: visible.map(mapPublicSkill),
  });
});
```

download/verify re-check via a shared `async function visibleSkill(id, orgId, sub, roles): Promise<SkillPublicRow | null>` that returns the row only when org matches AND enabled AND (superadmin ∨ scopeMatches with the caller's expanded depts); else the route returns `404` for download and `{ allowed: false }` for verify. `events` is a fire-and-forget `UPDATE … WHERE skill_id=$1 AND org_id=$2` for `install`/`update`/`invoke`, wrapped in try/catch that always returns 200.)

- [ ] **Step 4: Run — confirm it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/skillMarketplace.test.ts`
Expected: PASS (this also exercises Review-Focus #1/#2/#3).

- [ ] **Step 5: Remove the T2 deprecated alias + Lint + commit**

Remove `export const SKILL_COLUMNS = ADMIN_SKILL_COLUMNS;` from `skillMarketplaceView.ts` (no longer referenced).

```bash
cd enterprise_server && npx eslint --ext ts --max-warnings 0 src/routes/skillMarketplace.ts src/models/skillMarketplaceView.ts && npx tsc --noEmit
git add -A && git commit -m "feat(skill-marketplace): public org+scope filter, download/verify/events with sha256"
```

---

## Task 7: Settings (org `members_can_submit_skills`)

**Files:**
- Modify: `enterprise_server/src/routes/skillMarketplaceAdmin.ts`
- Test: `enterprise_server/tests/routes/skillSettings.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/admin/skill-marketplace/settings` (`PP.SkillView`) → `{ membersCanSubmit: boolean }`
  - `PATCH /api/admin/skill-marketplace/settings` (`PP.SkillEdit`) → body `{ membersCanSubmit: boolean }` → `UPDATE orgs SET members_can_submit_skills=$1 WHERE id=$2` → `{ ok: true }` (audit `SkillUpdate` payload `{ settings: 'members_can_submit_skills' }`).

- [ ] **Step 1: Write the failing tests** (assert GET returns false by default; PATCH flips it; GET reflects the change).
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implement** (mirror `mcpConnectors.ts:434-455` settings pattern; org from `claims.orgId`).
- [ ] **Step 4: Run — passes**
- [ ] **Step 5: Lint + commit**

```bash
cd enterprise_server && npx eslint --ext ts --max-warnings 0 src/routes/skillMarketplaceAdmin.ts
git add -A && git commit -m "feat(skill-marketplace): org members_can_submit_skills settings endpoint"
```

---

## Task 8: Review-queue routes (`skillSubmissions.ts`) + `/me` flag

**Files:**
- Create: `enterprise_server/src/routes/skillSubmissions.ts`
- Modify: `enterprise_server/src/server.ts` (mount `skillSubmissionsRoutes` before `skillMarketplaceAdminRoutes`)
- Modify: `enterprise_server/src/routes/me.ts` (add `membersCanSubmitSkills` to `/me`)
- Test: `enterprise_server/tests/routes/skillSubmissions.test.ts`

**Interfaces:**
- Consumes: `parseSkillZip` (T3), `sanitizeScope` (T4), `auditStore.write`, `Skill*` audit actions (T1).
- Produces (mirrors `mcpSubmissions.ts` exactly):
  - `POST /api/admin/skill-marketplace/submissions` (member; `requireAuth`):
    1. org toggle `orgs.members_can_submit_skills` false/missing → `403 submission_disabled`.
    2. body `{ desc?, scope, zipFile: <base64 or raw> }` — parse the zip (top-dir→name, version, sha256). (Member submissions carry the raw zip; the SPA/desktop POSTs a multipart or base64 — keep the same body the MCP submit uses; for skills the zip is the payload. **Decision:** accept `{ desc?, scope, zip: <base64 string> }`; decode base64 → `parseSkillZip`.)
    3. insert `skill_submissions (id, org_id, name, "desc", author_id, version, status='pending', cfg={ zip:{fileName,fileSize,sha256}, scope })`. Store the zip bytes to `skillStoreDir('__sub_'+id)/skill.zip`. `SkillSubmissionSubmit` audit. → `201 { id }`.
  - `GET /api/admin/skill-marketplace/submissions?status=` (`PP.SkillView`): list + per-status `counts` (mirror `mcpSubmissions` GET).
  - `POST .../submissions/:id/approve` (`PP.SkillEdit`): `not_pending` 409 if not pending; in a `pool.transaction`: create the skill from `cfg` (re-parse stored zip; collision → `-2` suffix via a `nameTaken` loop; bring scope from `cfg.scope`, sanitized; category=`uncategorized`); move `__sub_<id>/skill.zip` → `<name>/skill.zip`; `UPDATE` submission `status='approved', approved_skill_id=$1`; `SkillSubmissionApprove` audit (with `tx`). → `{ ok: true, id: <newSkillId> }`.
  - `POST .../submissions/:id/reject` (`PP.SkillEdit`): body `{ reason }` empty → `reason_required` 400; `UPDATE status='rejected', reject_reason=$1`; audit.
  - `POST .../submissions/:id/withdraw` (`requireAuth`): `claims.sub !== author_id` → `forbidden` 403; `not_pending` 409; `UPDATE status='withdrawn'`; audit.
  - `/me` adds `membersCanSubmitSkills` (query `orgs.members_can_submit_skills`, default false when org row missing) alongside the existing `membersCanSubmitConnectors`.

- [ ] **Step 1: Write the failing tests** (submit pending; org-off → 403; approve creates skill with `-2` suffix on collision + scope brought over + audit; reject requires reason; withdraw only by author). Use the harness + seed org/depts/users; the zip payload is base64 of a one-entry `AdmZip`.

- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implement `skillSubmissions.ts`** (port `mcpSubmissions.ts` structure; replace `createConnectorFromCfg` with a local `createSkillFromCfg(orgId, cfg, { createdBy, tx, onNameCollision:'suffix' })` that re-parses the stored zip, resolves the collision-suffixed name, sanitizes scope, inserts the skill, and moves the zip). Mount before `skillMarketplaceAdminRoutes` in `server.ts`.
- [ ] **Step 4: Run — passes**
- [ ] **Step 5: Lint + commit**

```bash
cd enterprise_server && npx eslint --ext ts --max-warnings 0 src/routes/skillSubmissions.ts src/server.ts src/routes/me.ts
git add -A && git commit -m "feat(skill-marketplace): member review queue (submit/approve/reject/withdraw) + /me flag"
```

> **M1 verification gate:** `cd enterprise_server && npx vitest run tests/db/038_org_skills.test.ts tests/models/skillMarketplaceView.test.ts tests/lib/skillZip.test.ts tests/routes/skillMarketplaceAdmin.test.ts tests/routes/skillCategories.test.ts tests/routes/skillMarketplace.test.ts tests/routes/skillSettings.test.ts tests/routes/skillSubmissions.test.ts` all green, and `npx tsc --noEmit` = 0.

---

# M2 — Admin SPA

> The admin SPA is React + React Query + zustand auth. All skill routes are org-scoped by `claims.orgId` (no `?orgId=` needed for skill endpoints, unlike MCP). The page reads `orgId = useAuth().claims?.orgId ?? 'default-org'` for the depts/members queries that feed the scope selector. i18n keys live in `enterprise_server/web/src/i18n.ts` (en block ends ~line 1024, zh block ends ~line 2043); add en+zh pairs for every new key and remove the now-dead role-chip keys.

## Task 9: Web api client + scope type

**Files:**
- Modify: `enterprise_server/web/src/api/skillMarketplace.ts`
- Test: (typecheck gate — `tsc --noEmit`)

**Interfaces:**
- Produces (rewrite of `skillMarketplace.ts`):
  - `SkillScope { allCompany: boolean; deptIds: string[]; userIds: string[] }`
  - `SkillAdmin { id, name, name_zh, description, category, version, icon, scope, scopeSummary, zip:{fileName,fileSize}, enabled, useCount30d, updatedAt, createdBy, updatedBy }`
  - `SkillCategory { id, name_zh, name_en, display_order? }`
  - `SkillSubmission { id, name, desc, authorId, version, submittedAt, status, rejectReason, cfg, approvedSkillId }`, `SkillSubmissionStatus`, `SkillSubmissionList { submissions, counts? }`
  - `parseZip(file: File)` → `postRaw('/api/admin/skill-marketplace/skills/parse-zip', file, {'content-type':'application/zip'})` → `{ name, version, size, sha256, tempToken }`
  - `createSkill({ tempToken, nameZh?, author?, category_id, desc?, icon?, scope })` → `post('/skills')`
  - `updateSkill(id, patch)` → `patch('/skills/:id')` (note: `patch`, not `put`)
  - `uploadZip(id, file)` → `postRaw('/skills/:id/zip', ...)`
  - `deleteSkill(id)`, `listSkills()`, `listCategories()`, `createCategory`, `updateCategory`, `deleteCategory`
  - `listSubmissions(status?)` → `get('/submissions?status=')`; `approveSubmission(id)`, `rejectSubmission(id, reason)`, `withdrawSubmission(id)`
  - `getSettings()` → `get('/settings')`; `setSettings({ membersCanSubmit })` → `patch('/settings')`
  - **drop** `listRoleVocabulary` and the `allowed_roles`-bearing `SkillInput`/`SkillPatch`.

- [ ] **Step 1: Rewrite the api client** (per the interface; keep the `apiClient` import from `./client`).
- [ ] **Step 2: Typecheck** — `cd enterprise_server/web && npx tsc --noEmit`. Fix any page that still references the removed `allowed_roles`/`listRoleVocabulary` (T11/T12 rewrite those pages; if typecheck is broken mid-milestone, keep a minimal `listRoleVocabulary` stub until T12 lands, then remove it).
- [ ] **Step 3: Commit**

```bash
cd enterprise_server/web && npx tsc --noEmit
git add -A && git commit -m "feat(skill-spa): org-scoped api client with scope, submissions, and settings"
```

---

## Task 10: Port the scope selector to skills

**Files:**
- Create: `enterprise_server/web/src/pages/skillManage/SkillScopeSelector.tsx`
- (Reuse `api/departments.ts` `DeptNode`, `api/users.ts` `UserRow`, `api/client.ts`.)

**Interfaces:**
- Produces: `SkillScopeSelector` with the **same props** as `ConnectorScopeSelector` (`value: SkillScope; onChange: (s: SkillScope) => void; depts: DeptNode[]; members: UserRow[]; onOpenChange?`).
- Consumes: `SkillScope` (T9).

> **This is a verbatim port** of `enterprise_server/web/src/pages/mcpManage/ConnectorScopeSelector.tsx` (371 lines): copy the file, rename `ConnectorScope`→`SkillScope`, re-point the i18n keys from `mcpDrawer.scope.*` to `skillmgmt.scope.*` (T13 defines the keys), and change the import of `SkillScope` from `../../api/skillMarketplace`. The component is purely presentational (depts/members arrive as props) — no fetch logic to add. Member-search top-N (20) is a **new** addition over MCP (which lists all): add `const memberRows = … .slice(0, 20)` on the filtered member list and, when truncated, render a "（共 N 条，显示前 20）" footer using `skillmgmt.scope.memberTruncated`.

- [ ] **Step 1: Copy + transform `ConnectorScopeSelector.tsx` → `SkillScopeSelector.tsx`** (rename type, re-key i18n, add member top-20 slice + truncation footer).
- [ ] **Step 2: Typecheck** — `cd enterprise_server/web && npx tsc --noEmit`.
- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(skill-spa): port ConnectorScopeSelector to SkillScopeSelector"
```

---

## Task 11: 7-column table + settings card + tabs (rebuild `SkillManagePage`)

**Files:**
- Create: `enterprise_server/web/src/pages/skillManage/SkillTable.tsx`
- Modify: `enterprise_server/web/src/pages/SkillManagePage.tsx`
- (Delete: `pages/skillManage/SkillCardGrid.tsx` — replaced by `SkillTable`.)

**Interfaces:**
- Produces:
  - `SkillTable` — props `{ skills: SkillAdmin[]; categoryName: string; current: string; onAdd: () => void; onEdit: (s: SkillAdmin) => void; onToggle: (id: string, enabled: boolean) => void; onZipDownload: (s: SkillAdmin) => void }`. Renders the tool row (breadcrumb `技能/{分类}` + `只有被授权部门/成员可见 · 共 N 个技能` + search) and the 7 columns: 技能名称 (icon + `name_zh || name` + key), 描述 (`description` + `👥 {useCount30d}`), Zip (`zip.fileName` + human size + download link), 授权范围 (`scopeSummary` tag), 状态 (`Switch` → `onToggle`), 更新时间 (`dayjs(updatedAt)` + `v{version}`), 操作 (编辑 | 删除 → `onEdit`/delete).
  - `SkillManagePage` rebuilt to the `MCPManagePage` shape: header + **settings card** (single `Switch` bound to `getSettings()`/`setSettings()`, `t('skillmgmt.settings.title')`/`.desc`) + **tab nav** (`组织技能 {N}` / `技能审核 {N}`) + content branch (`view === 'org'` → `CategorySidebar` + `SkillTable`; `view === 'review'` → `ReviewView` (T14)). Page owns `deptsQ`/`membersQ` (`departmentsApi.list(orgId)` / `usersApi.list(orgId)`) and passes them into the drawer/scope selector.
- Consumes: `skillMarketplaceApi` (T9), `ConnectorCategoryPanel`? no — reuse the existing `CategorySidebar` (already present in `pages/skillManage/`), `SkillScopeSelector` (T10).

> Port the tab/settings-card JSX from `MCPManagePage.tsx` (lines 218-312) into `SkillManagePage`. The `👥N` under 描述 = `useCount30d` (Review-Focus: usage, not a role count).

- [ ] **Step 1: Create `SkillTable.tsx`** (7 columns per interface; human size = `fileSize` → KB/MB; download = `<a href={downloadUrl}>` where `downloadUrl = \`${window.location.origin}/api/skill-marketplace/download/${id}\`` — the desktop uses Bearer; for the SPA admin the admin is authorized, and the download is best-effort).
- [ ] **Step 2: Rebuild `SkillManagePage.tsx`** (tabs + settings card + content branch; add `deptsQ`/`membersQ`; wire `SkillTable` + delete + `onToggle` → `updateSkill(id,{enabled})`).
- [ ] **Step 3: Delete `SkillCardGrid.tsx`; fix imports.**
- [ ] **Step 4: Typecheck** — `cd enterprise_server/web && npx tsc --noEmit`.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(skill-spa): 7-column table, settings card, and org/review tabs"
```

---

## Task 12: Two-stage create/edit drawer + scope selector

**Files:**
- Modify: `enterprise_server/web/src/pages/skillManage/CreateSkillForm.tsx` (becomes the unified Create/Edit drawer)
- (Delete: `DetailDrawer.tsx` — its role folds into the two-stage drawer; or rename/repurpose. Keep the file but re-export as `SkillDrawer`.)

**Interfaces:**
- Produces: `SkillDrawer` — props `{ mode: 'create' | 'edit'; skill?: SkillAdmin; categories: SkillCategory[]; depts: DeptNode[]; members: UserRow[]; defaultCategory?: string; onCancel: () => void; onSave: (input) => void; onDelete?: () => void; onToggle?: (enabled: boolean) => void }`. Layout (top→bottom):
  1. **技能包** — a file input (accept `.zip`). On file select: call `skillMarketplaceApi.parseZip(file)` → show `正在解析技能包…` → on success show a **read-only** `name` + a `×` remove button (clears the tempToken). Store `tempToken` + parsed `{name, version, sha256, size}` in local state. (In `edit` mode this section is a **replace** control; `onSave` sends the new zip via `uploadZip` after the base patch.)
  2. **基本信息** — `nameZh`, `author`, `version` (read-only, from parse), `category` (select), `desc`, `icon`.
  3. **授权范围** — `<SkillScopeSelector value={scope} onChange={setScope} depts={depts} members={members} onOpenChange={...} />`.
  - `onSave(create)` = `createSkill({ tempToken, nameZh, author, category_id, desc, icon, scope })`.
  - `onSave(edit)` = `updateSkill(id, { nameZh?, desc?, icon?, category_id?, scope?, enabled? })` (+ `uploadZip(id, file)` if a new zip was provided).
- Consumes: `skillMarketplaceApi.parseZip`/`createSkill`/`updateSkill`/`uploadZip` (T9), `SkillScopeSelector` (T10).

> The old `CreateSkillForm` (role-chips + `skill_${Date.now()}` id) and `DetailDrawer` are replaced by this single two-stage drawer. The `name`/`id` is **never hand-typed** — it comes from the parsed zip (D3).

- [ ] **Step 1: Implement `SkillDrawer`** (two-stage state machine: `idle → parsing → parsed(tempToken,name,version)` ; the × button resets to `idle`; submit disabled until `parsed`).
- [ ] **Step 2: Wire into `SkillManagePage`** (`onAdd` opens `mode='create'`; table row 编辑 opens `mode='edit'` with the skill).
- [ ] **Step 3: Remove the dead `RoleChips` export + `listRoleVocabulary` usage.**
- [ ] **Step 4: Typecheck** — `cd enterprise_server/web && npx tsc --noEmit`.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(skill-spa): two-stage create/edit drawer with zip parse and scope selector"
```

---

## Task 13: Delete impact-list modal + i18n evolution

**Files:**
- Create: `enterprise_server/web/src/pages/skillManage/DeleteSkillModal.tsx`
- Modify: `enterprise_server/web/src/i18n.ts` (en + zh)

**Interfaces:**
- Produces: `DeleteSkillModal` — props `{ open, name: string, scopeSummary: string, useCount30d: number, onConfirm: () => void, onCancel: () => void }`. Shows the impact list (授权对象 = `scopeSummary`, 使用人数 = `useCount30d`, 不可恢复, 审计保留 90 天) and a destructive confirm.
- **i18n:** add `skillmgmt.settings.*`, `skillmgmt.scope.*`, `skillmgmt.review.*`, `skillmgmt.table.*`, `skillmgmt.parse.*`, `skillmgmt.deleteSkill.*`, `skillmgmt.zip.*` (en+zh pairs). **Remove** the dead role-chip keys (`skillmgmt.allowedRoles`, `skillmgmt.nameEn`, `skillmgmt.sourceFrom`, `skillmgmt.sourceUrl`) and any `skillmgmt.*` key no longer referenced.

> Verify no unreferenced keys: after the edits, `cd enterprise_server/web && grep -rhoP "t\('(skillmgmt|common)\.[a-zA-Z.]+'\)" src/pages/skillManage src/pages/SkillManagePage.tsx | sort -u` should be a subset of the defined `skillmgmt.*` keys (every defined key is referenced; every referenced key is defined).

- [ ] **Step 1: Create `DeleteSkillModal.tsx`** (port the confirm-modal styling from the existing `AddCategoryModal`/`ConfirmDialog`; content per interface).
- [ ] **Step 2: Add all i18n keys (en+zh), remove dead ones.** (Mirror the `mcp.review.*`, `mcpDrawer.scope.*`, `mcp.globalSetting.*` key set with `skillmgmt.` prefixes; e.g. `skillmgmt.scope.triggerAll` = `Selected: {root} (whole company…)`, `skillmgmt.review.approve` = `Approve & publish`, `skillmgmt.review.reject.empty` = `Please enter a rejection reason`, etc.)
- [ ] **Step 3: Wire the modal** into `SkillManagePage` (table 删除 → open modal → onConfirm `deleteSkill`).
- [ ] **Step 4: Typecheck + no-unreferenced-keys check** — `cd enterprise_server/web && npx tsc --noEmit` (0) and the grep above.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(skill-spa): delete impact-list modal + i18n evolution (scope/review/settings)"
```

---

## Task 14: Review tab (port the MCP review four-components)

**Files:**
- Create: `enterprise_server/web/src/pages/skillManage/SkillReviewView.tsx`, `SkillReviewDetailDrawer.tsx`, `SkillRejectReasonModal.tsx`, `skillReviewShared.ts`
- (Port from `pages/mcpManage/`: `ReviewView.tsx`, `ReviewDetailDrawer.tsx`, `RejectReasonModal.tsx`, `reviewShared.ts`.)

**Interfaces:**
- Produces: `SkillReviewView` — props `{ submissions: SkillSubmission[]; members: UserRow[]; onApprove: (id) => void|Promise; onReject: (id, reason) => void|Promise }` (status chips 待审核/已通过/已驳回/已撤回/全部 with counts; 7-col list; rejected rows show the reason inline; pending rows → 通过并发布 / 驳回; row click → detail drawer). The detail drawer's config section shows `cfg.name`, `cfg.version`, `cfg.desc`, `cfg.scope` (via a `scopeText(scope)`), and `cfg.zip` (fileName + size + sha256 prefix). The page (`SkillManagePage`) owns `approveSubmission`/`rejectSubmission` handlers (call `skillMarketplaceApi.*`, toast `skillmgmt.review.approvedToast`/`rejectedToast`, invalidate both the submissions and skills queries) and passes them down — mirroring `MCPManagePage` lines 147-170.
- Consumes: `skillMarketplaceApi.listSubmissions/approveSubmission/rejectSubmission` (T9), `SkillSubmission` (T9), i18n `skillmgmt.review.*` (T13).

> Verbatim port of the four MCP components with type/i18n renames (`Submission`→`SkillSubmission`, `mcp.review.*`→`skillmgmt.review.*`, config display from connector `url/authMode/tools` → skill `name/version/scope/zip`). The `scopeText` helper reads `cfg.scope` and renders the `skillmgmt.scope.*` strings.

- [ ] **Step 1: Port the four components** (rename types + i18n; swap the config-section fields to skill fields).
- [ ] **Step 2: Wire into `SkillManagePage`** (`view === 'review'` branch → `<SkillReviewView …>`; add `subsQ = useQuery(['skillmgmt','submissions'], () => skillMarketplaceApi.listSubmissions())`; `pendingCount` for the tab badge; approve/reject handlers).
- [ ] **Step 3: Typecheck** — `cd enterprise_server/web && npx tsc --noEmit` (0).
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(skill-spa): review tab (status chips, list, detail drawer, reject modal)"
```

> **M2 verification gate:** `cd enterprise_server/web && npx tsc --noEmit` = 0; i18n has no unreferenced `skillmgmt.*` keys; the page renders (manual: `npm run dev` in `enterprise_server/web` against a running server — verify the settings card toggles, the table shows scope tags, the two-stage drawer parses a zip and creates, and the review tab approves a seeded submission).

---

# M3 — Review E2E (desktop member-submission entry)

## Task 15: Desktop member-submission entry

**Files:**
- Create: `src/shared/skills/constants.ts` (new dir)
- Modify: `src/main/auth/enterpriseClient.ts` (add `submitSkillRequest`; add `membersCanSubmitSkills` to `MeView`)
- Modify: `src/main/ipcHandlers/skills/handlers.ts` (add `skills:submitSkill`)
- Modify: `src/main/preload.ts` (add `skills.submit`)
- Modify: `src/renderer/services/skill.ts` (add `submitSkill` wrapper)
- Create: `src/renderer/components/skills/SubmitSkillForm.tsx`
- Modify: `src/renderer/components/skills/SkillsManager.tsx` (add `canSubmitSkill` gate + button + dialog in the enterprise tab)
- Modify: `src/renderer/services/i18n.ts` (en+zh keys)
- Test: `src/renderer/services/skill.submit.test.ts` (pure: the request-shape mapper)

**Interfaces:**
- Produces:
  - `SkillSubmitRequest { nameZh?: string; desc?: string; icon?: string; scope: { allCompany?: boolean; deptIds?: string[]; userIds?: string[] }; zipBase64: string; }` (the zip is read as base64 by the form and sent up; the main process passes it to `enterpriseClient.submitSkillRequest`, which POSTs `{ desc?, scope, zip: zipBase64 }` to `/api/admin/skill-marketplace/submissions` — matching T8's body).
  - `enterpriseClient.submitSkillRequest(req: SkillSubmitRequest): Promise<{ id: string }>` → `call('/api/admin/skill-marketplace/submissions', { method:'POST', body: JSON.stringify(req) })` (org JWT via `call`).
  - `MeView` gains `membersCanSubmitSkills?: boolean` (server `/me` returns it, T8).
  - IPC `skills:submitSkill` → `{ success, data?: { id }, error? }` (mirror the `McpIpcChannel.SubmitConnectorRequest` handler: `loginGate.requireEnterprise()` then `enterpriseClient.submitSkillRequest`).
  - preload `skills.submit: (req) => ipcRenderer.invoke('skills:submitSkill', req)`.
  - `skillService.submitSkill(req): Promise<string>` (mirror `mcp.ts:293-295` `submitConnectorRequest`; resolves `data.id`, rejects on `!success`).
  - `SubmitSkillForm` — file pick (→ base64), `desc`, `scope` (a simplified scope input — the desktop does **not** have the dept-tree UI; provide `allCompany` checkbox + free-text dept/user id fields is wrong, so instead **reuse the `getMe` dept paths**: simplest correct approach = an `allCompany` toggle only for the member, since a member's own suggested scope is advisory and the admin re-scopes on approve). **Decision:** the member form exposes only `allCompany` (default true) + `desc`; the server stores the suggestion and the admin overrides on approval (spec §3.1: "原样带入，发布后编辑调整"). This keeps the desktop form minimal and correct.
  - `canSubmitSkill` gate in `SkillsManager`: when the enterprise tab is active, `const me = await window.electron.enterpriseMt.getMe(); setCanSubmitSkill(!!me.membersCanSubmitSkills)` (mirror `McpManager.tsx:186-200`). Button `添加技能` in the enterprise-tab strip shown only when `canSubmitSkill`; 403 maps to i18n `skillSubmitDisabled`.

- [ ] **Step 1: Write the pure request-mapper test**

```ts
import { describe, expect, test } from 'vitest';

import { buildSkillSubmitRequest } from '../../renderer/services/skill';

describe('buildSkillSubmitRequest', () => {
  test('maps form + zip base64 to the wire shape', () => {
    const req = buildSkillSubmitRequest({ desc: 'a desc', allCompany: true, zipBase64: 'QUJD' });
    expect(req).toEqual({ desc: 'a desc', scope: { allCompany: true, deptIds: [], userIds: [] }, zipBase64: 'QUJD' });
  });
});
```

- [ ] **Step 2: Run — fails** (`buildSkillSubmitRequest` not exported).
- [ ] **Step 3: Implement** the shared type, `enterpriseClient.submitSkillRequest`, IPC handler, preload method, `skillService.submitSkill` + `buildSkillSubmitRequest`, `SubmitSkillForm`, the `canSubmitSkill` gate + button + dialog in `SkillsManager`, and the i18n keys (`skillSubmit*`).
- [ ] **Step 4: Run the test + typecheck** — `npm test -- skill.submit` and `npm run compile:electron`.
- [ ] **Step 5: Lint + commit**

```bash
npx eslint --ext ts,tsx --max-warnings 0 src/shared/skills/constants.ts src/main/auth/enterpriseClient.ts src/main/ipcHandlers/skills/handlers.ts src/main/preload.ts src/renderer/services/skill.ts src/renderer/components/skills/SubmitSkillForm.tsx
git add -A && git commit -m "feat(desktop): member skill-submission entry (form, gate, IPC, service)"
```

> **M3 verification gate:** desktop builds (`npm run compile:electron`), the enterprise tab shows the submit button only when `members_can_submit_skills` is on, a member submission lands in the admin review queue (T8 route), and approve publishes the skill.

---

# M4 — Desktop consumption

## Task 16: Wire type — drop roles, add sha256/enabled/zipSize

**Files:**
- Modify: `src/renderer/types/skill.ts` (`MarketplaceSkill`)
- Modify: `src/main/auth/enterpriseClient.ts` (`listEnterpriseSkills` return type)
- Modify: `src/main/ipcHandlers/skills/handlers.ts` (`skills:fetchMarketplace` — passthrough; no change needed since it spreads `...s`, but confirm the new fields flow through)
- Test: `src/renderer/types/skill.wire.test.ts` (pure: a mapper/normalizer that strips `allowed_roles` and normalizes the row)

**Interfaces:**
- Produces:
  - `MarketplaceSkill` gains `zipSize?: number | null; sha256?: string | null; updatedAt?: string` and **stops depending on** `allowed_roles`/`enabled` (the list is already scope+enabled filtered server-side). Add a `status` hint is handled in T18 (via a separate "installed & still-visible" check), not on the wire.
  - `enterpriseClient.listEnterpriseSkills()` return `skills` array type = the server's `SkillPublicView` (T2): `{ id, name, name_zh, description, category, version, icon, source, zipSize, sha256, updatedAt }` (no `allowed_roles`/`enabled`).
- Consumes: the new server wire (T6).

> The main `skills:fetchMarketplace` handler does `...s` so the new fields pass through automatically. This task is mostly **type updates** + removing any code that read `allowed_roles`.

- [ ] **Step 1: Write the normalizer test** (a small pure `normalizeMarketplaceRow(raw: Record<string, unknown>): MarketplaceSkill` that drops `allowed_roles`/`enabled` and maps `zipSize`/`sha256`/`updatedAt`; assert a raw row with `allowed_roles` produces a `MarketplaceSkill` without it and with `sha256` preserved).
- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implement** the type updates + `normalizeMarketplaceRow` (used in `loadMarketplaceSkills` in `skill.ts` instead of the raw `as unknown as MarketplaceSkill[]` cast), and grep-remove any `allowed_roles` reads in the skills UI.
- [ ] **Step 4: Run test + typecheck** — `npm test -- skill.wire` and `npm run compile:electron`.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(desktop): marketplace wire drops allowed_roles, adds sha256/zipSize"
```

---

## Task 17: sha256 verify after download

**Files:**
- Create: `src/main/skills/skillZipIntegrity.ts`
- Modify: `src/main/skills/skillManager.ts` (thread `expectedSha256` through `downloadZipUrl` at the two call sites: install ~L2011, upgrade ~L2230; pass the row's `sha256`)
- Test: `src/main/skills/skillZipIntegrity.test.ts`

**Interfaces:**
- Produces:
  - `sha256Hex(buf: Buffer): string` and `verifySha256(buf: Buffer, expected: string | null | undefined): boolean` (pure; returns `true` when `expected` is null/undefined — legacy rows without a hash are accepted, per §12 "历史包未必有摘要").
  - `downloadZipUrl(zipUrl, tempRoot, expectedSha256?: string)` — after `const buffer = Buffer.from(await response.arrayBuffer())` (L1311), if `expectedSha256` is present and `verifySha256(buffer, expectedSha256)` is false → `rmSync(tempRoot, {recursive,force})` and `throw new Error('SKILL_ZIP_SHA_MISMATCH')`.
- Consumes: the catalog row's `sha256` (resolved via `catalogSkillIdForSource` → `getCatalogLocalId`/catalog map). The caller (install/upgrade) must look up the expected hash from the fetched catalog row by `catalogSkillIdForSource(zipUrl)`.

- [ ] **Step 1: Write the failing pure tests**

```ts
import { describe, expect, test } from 'vitest';

import { verifySha256, sha256Hex } from '../../main/skills/skillZipIntegrity';

describe('verifySha256', () => {
  test('matches a correct hash', () => {
    const buf = Buffer.from('hello');
    expect(verifySha256(buf, sha256Hex(buf))).toBe(true);
  });
  test('rejects a wrong hash', () => {
    const buf = Buffer.from('hello');
    expect(verifySha256(buf, 'deadbeef'.repeat(8))).toBe(false);
  });
  test('accepts when expected is absent (legacy row)', () => {
    expect(verifySha256(Buffer.from('x'), null)).toBe(true);
    expect(verifySha256(Buffer.from('x'), undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implement `skillZipIntegrity.ts`** + thread `expectedSha256` through `downloadZipUrl` and the two call sites (look up the catalog row's `sha256` by catalog id; pass it; on `SKILL_ZIP_SHA_MISMATCH` surface "技能包校验失败，请重试" to the renderer via the existing install/upgrade error path).
- [ ] **Step 4: Run test + typecheck** — `npm test -- skillZipIntegrity` and `npm run compile:electron`.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(desktop): verify skill zip sha256 after download (delete + retry on mismatch)"
```

> Review-Focus #4 is pinned by the "rejects a wrong hash" test + the `downloadZipUrl` mismatch path (delete temp + no install).

---

## Task 18: Call-time authorization gate + periodic re-fetch

**Files:**
- Create: `src/main/libs/skillAccessGate.ts`
- Modify: `src/main/libs/openclawConfigSync.ts` (merge revoked-skill entries at L1917; read the gate's disabled set)
- Modify: `src/main/main.ts` (a periodic `setInterval` re-fetch of `listEnterpriseSkills()`; on change, run the gate → write entries + push `skills:marketplace-changed`)
- Modify: `src/main/preload.ts` + `src/renderer/services/skill.ts` (new `skills:marketplace-changed` event + `onMarketplaceChanged`)
- Test: `src/main/libs/skillAccessGate.test.ts`

**Interfaces:**
- Produces:
  - `computeRevokedSkillNames(installed: Array<{ id: string; name: string }>, visible: Array<{ id: string }>): string[]` (pure) → the frontmatter `name`s of installed org skills **not** present in `visible` (visible already excludes disabled, since the list only returns enabled rows). This is the set to force `enabled=false`.
  - The gate runs after each re-fetch: for every installed org skill (a `SkillRecord` whose id maps to a catalog id via `getCatalogLocalId`/reverse), if its name is in `computeRevokedSkillNames`, write an OpenClaw entry override.
  - `openclawConfigSync`: a new `setRevokedSkillEntries(names: string[])` (or a getter the merge site reads) that returns `Record<name, {enabled:false}>`; merged **after** `buildSkillEntries` and `MANAGED_SKILL_ENTRY_OVERRIDES` at L1917 so revoked org skills are blocked even if a local record says enabled.
  - **Degradation (Review-Focus #5):** the periodic re-fetch wraps `listEnterpriseSkills()` in try/catch. On fetch **failure**, the gate keeps the **last known** disabled set (does **not** clear it, does **not** re-enable) and does not re-sync OpenClaw (avoid churn). Only a **successful** fetch recomputes the set.
  - Periodic re-fetch: a `setInterval` sibling to `enterpriseJwtRefreshTick` (main.ts ~L12591-12613), e.g. every 5 min, calling `enterpriseClient.listEnterpriseSkills()`, computing the revoked set, calling the gate, and pushing `skills:marketplace-changed` to renderers so cards flip to `已失效/已停用` (T19).

- [ ] **Step 1: Write the failing pure tests**

```ts
import { describe, expect, test } from 'vitest';

import { computeRevokedSkillNames } from '../../main/libs/skillAccessGate';

describe('computeRevokedSkillNames', () => {
  test('flags installed skills absent from the visible list', () => {
    const installed = [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }, { id: 'c', name: 'gamma' }];
    const visible = [{ id: 'a' }, { id: 'b' }];
    expect(computeRevokedSkillNames(installed, visible)).toEqual(['gamma']);
  });
  test('no revocation when all installed are visible', () => {
    expect(computeRevokedSkillNames([{ id: 'a', name: 'alpha' }], [{ id: 'a' }])).toEqual([]);
  });
  test('empty visible list revokes all installed', () => {
    expect(computeRevokedSkillNames([{ id: 'a', name: 'alpha' }], [])).toEqual(['alpha']);
  });
});
```

- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implement** `skillAccessGate.ts` (`computeRevokedSkillNames` + a small stateful `SkillAccessGate` class holding `lastDisabled: Set<string>` and a `sync(visible)` that only mutates on success), the `openclawConfigSync` merge + `setRevokedSkillEntries`, the main.ts periodic re-fetch (try/catch keeping last-known on failure), the `skills:marketplace-changed` event + preload + service `onMarketplaceChanged`.
- [ ] **Step 4: Run test + typecheck** — `npm test -- skillAccessGate` and `npm run compile:electron`.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(desktop): call-time skill authorization gate (revoke entries, keep dir, degrade on fetch failure)"
```

> Review-Focus #5 is pinned by the "empty visible list revokes all" test + the fetch-failure-keeps-last-known path (the test in T18 asserts a thrown fetch does not clear the disabled set).

---

## Task 19: 4th card state (disabled/revoked)

**Files:**
- Modify: `src/renderer/components/skills/SkillsManager.tsx` (add `'disabled'` to `getSkillInstallStatus`'s union; render it in the two consumers; subscribe to `onMarketplaceChanged` to recompute)
- Modify: `src/renderer/services/i18n.ts` (en+zh `skillDisabled` / `skillRevoked` labels + the "已失效/已停用" pill copy)
- Test: `src/renderer/components/skills/skillInstallStatus.test.ts` (pure: extract the status computation into a testable function)

**Interfaces:**
- Produces:
  - Extract `getSkillInstallStatus` (SkillsManager.tsx:640-646) into a pure `resolveInstallStatus(marketplace: { id; version? } | null, installed: { id; version?; enabled? } | null, revoked: boolean): 'not_installed' | 'disabled' | 'update_available' | 'installed'` in a new `src/renderer/components/skills/skillInstallStatus.ts`. `revoked` = the skill's name is in the gate's disabled set (pushed via `onMarketplaceChanged` into component state).
  - **Precedence:** `revoked` → `'disabled'` (regardless of version); else existing logic (`not_installed` / `update_available` / `installed`).
  - Card render (IIFE ~L1575-1612) + detail action (L1035-1070): `disabled` → a disabled pill `t('skillRevoked')` (已失效/已停用), **no install/upgrade button** (the dir is kept but blocked).
  - `useEffect` subscribes `skillService.onMarketplaceChanged(() => { refreshMarketplace(); /* recompute disabled set from the pushed list */ })`.

- [ ] **Step 1: Write the failing pure tests**

```ts
import { describe, expect, test } from 'vitest';

import { resolveInstallStatus } from '../../renderer/components/skills/skillInstallStatus';

describe('resolveInstallStatus', () => {
  test('revoked wins over installed', () => {
    expect(resolveInstallStatus({ id: 'a', version: '1.0.0' }, { id: 'a', version: '1.0.0', enabled: true }, true)).toBe('disabled');
  });
  test('revoked wins over update_available', () => {
    expect(resolveInstallStatus({ id: 'a', version: '2.0.0' }, { id: 'a', version: '1.0.0', enabled: true }, true)).toBe('disabled');
  });
  test('update_available when remote > local and not revoked', () => {
    expect(resolveInstallStatus({ id: 'a', version: '2.0.0' }, { id: 'a', version: '1.0.0', enabled: true }, false)).toBe('update_available');
  });
  test('not_installed when absent', () => {
    expect(resolveInstallStatus({ id: 'a', version: '1.0.0' }, null, false)).toBe('not_installed');
  });
});
```

- [ ] **Step 2: Run — fails**
- [ ] **Step 3: Implement** `skillInstallStatus.ts`, rewire the two consumers to `resolveInstallStatus`, add the `disabled` pill + i18n, and the `onMarketplaceChanged` subscription.
- [ ] **Step 4: Run test + typecheck** — `npm test -- skillInstallStatus` and `npm run compile:electron`.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(desktop): 4th marketplace card state (disabled/revoked) with marketplace-change listener"
```

> **M4 + full-plan verification gate:** `npm test -- skill.wire skillZipIntegrity skillAccessGate skillInstallStatus` green; `npm run compile:electron` = 0; desktop renderer only has the pre-existing `bakeArtifactSharePage.ts(382,21)` typecheck note (unchanged). Manual: install a skill from the enterprise tab, then disable it in the admin SPA — within ~5 min the desktop card flips to 已失效 and the OpenClaw entry is `enabled=false` while the local dir is retained.

---

## Self-review notes (run after implementation)

- **Spec coverage:** M1↔§4/§5/§8/§10 (server), M2↔§6 (SPA), M3↔§5.3/§7 (member submit), M4↔§7 (desktop). Every spec decision D1–D8 and §3 ruling is mapped to a task. No skill copy/rollback/signing-URL/offline-cache (spec §13) is in scope.
- **Net-new vs ported:** `sanitizeScope` (T4), `parseSkillZip` (T3), `computeRevokedSkillNames` (T18), the member top-20 scope search (T10), and the desktop submission form (T15) are NEW; the rest port verbatim from the MCP subsystem. Flag any "clone" that actually needs new logic back to the reviewer.
- **Type consistency:** `SkillScope` (T2 server / T9 web) and the public wire `SkillPublicView` (T2) → `listEnterpriseSkills` (T16) → `MarketplaceSkill` (T16) must keep field names identical (`zipSize`, `sha256`, `updatedAt`, no `allowed_roles`). `SkillSubmitRequest` (T15) body `{ desc?, scope, zip: <base64> }` must match T8's member-submission body.
- **Commits are local only** — do not push.
