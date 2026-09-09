# Enterprise 套件管理 (Kit Management) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a permission-scoped 套件管理 (kit catalog) subsystem to the enterprise server, seed it with 12 vendored expert kits stored locally, and restructure the desktop 专家套件 view so the 市场 tab becomes an enterprise-backed 企业 tab with a new 内置 fallback tab.

**Architecture:** The enterprise server gains a `kit_catalog` subsystem that mirrors the existing `skill_marketplace` subsystem (org-scoped catalog keyed by a natural TEXT `slug`, `scope JSONB` ACL, two-stage zip upload, authed `GET /download/:slug`, per-org idempotent boot seed, and `kit:*` RBAC points). The 12 kits' `.zip` bundles are committed into the repo under `enterprise_server/seeds/kits/`; server init reads them from local disk (no network at startup), validates each with the kit-zip parser, and copies the bytes into the server `stateDir`. The desktop reads `GET /api/kits` (scoped by the caller's department membership) via `enterpriseClient`, installs via an authed `GET /api/kits/download/:slug`, and shows the existing local built-in kits (GenWork 外观定制, computer-use) in a new 内置 tab.

**Tech Stack:** TypeScript, Hono v4, raw `pg` (Postgres), vitest + PGlite (server tests); Electron + React 18 + Redux (desktop); a separate React SPA under `enterprise_server/web/`.

**Spec:** `docs/superpowers/specs/2026-10-07-enterprise-kit-management-design.md`

## Global Constraints

- **Kit zips are FLAT.** A real kit zip bundles many skill folders at the archive root — `engineering/architecture/SKILL.md`, `engineering/code-review/SKILL.md`, … — with **no wrapping kit folder**. (Verified: `engineering.zip` = 10 `*/SKILL.md` entries at depth 1.) Consequence: the kit `slug` is **not derivable from the zip**; it is supplied by the admin at create time (a required form field) and by the seed manifest. This is the one deliberate divergence from `skillZip.ts`, whose single-skill zips carry the slug as the sole top-level dir. `parseKitZip` therefore validates the archive and returns **no slug**.
- Enterprise server code lives under `enterprise_server/` and shares the repo root `node_modules`. Run server tests **per file** (full-suite runs hit sandbox fd/EBADF exhaustion): `cd enterprise_server && npx vitest run tests/<file>`.
- All migrations are **re-run-safe** (the test harness re-runs every SQL file with no ledger check): `CREATE TABLE IF NOT EXISTS`, idempotent `ON CONFLICT ... DO NOTHING`, `DROP TRIGGER/INDEX IF EXISTS` before re-adding, single-quoted plpgsql function bodies (no `$$`) so `splitStatements` keeps them whole.
- Categories are org-scoped TEXT slugs with a **reserved `uncategorized` bucket** seeded by an org-creation trigger (mirrors `skill_marketplace_categories`, migration 038). `kit_catalog.category_id` has **no FK** — category org-scoping is enforced in the route layer, exactly as 038 does for skills.
- All service/route queries carry `org_id` from the JWT (`claims.orgId`); never from a query param. `super_admin` bypasses the RBAC point check and sees every **enabled** row (never disabled) regardless of `scope`.
- New RBAC points require editing **both** `enterprise_server/src/shared/permissionPoints.ts` and the hand-mirror `enterprise_server/web/src/shared/permissions.ts` (no parity test exists).
- `signToken` is **async** (`src/auth/jwt.ts:15`): every test that mints a token must `await signToken(...)`.
- Kit rows are keyed by **`slug`** (the desktop kit `id`, e.g. `engineering`), composite PK `(org_id, slug)`, matching how `skill_marketplace_skills` keys by `skill_id`.
- Touched TypeScript must be ESLint-clean at `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`. Renderer i18n keys need both `zh` and `en`.
- Commits: Conventional Commits, English, **no** `Co-Authored-By` trailer. Do not push to remote. Commit after each task (local only).

**Deliberate deviations from the spec's §4.1 sketch** (the spec's SQL sketch is illustrative and contradicts its own "mirror 038" instruction; follow **038** and this plan, not the sketch):
- **Categories are TEXT slugs, not `BIGSERIAL id` with an FK.** `kit_categories` uses `category_id TEXT` + `PRIMARY KEY (org_id, category_id)` and a localized `name_zh`/`name_en` (like `skill_marketplace_categories` in 038). The spec sketch's `BIGSERIAL id` + `category_id BIGINT REFERENCES kit_categories(id)` does not match 038 and is not used. `kit_catalog.category_id` is a plain `TEXT` with **no FK** (route-enforced, 038 precedent).
- **Identity is `(org_id, slug)`; there is no separate `builtin_slug` column.** The built-in identity *is* the `slug` (stable, e.g. `engineering`); the `is_builtin` flag marks the 12 seeded kits, and idempotency comes from `ON CONFLICT (org_id, slug) DO NOTHING`. The spec sketch's `builtin_slug TEXT` column is dropped.
- **`GET /api/kits` returns a RELATIVE `skills.bundle`** (`/api/kits/download/<slug>`), and the desktop main process absolutizes it against `getEnterpriseServerUrl()` (Task 10). The spec §5.7 says the server returns an absolute URL; the relative form keeps the server host-agnostic and is simpler — the net behavior (authed download) is identical.
- **Re-upload is `POST /api/admin/kits/:slug/zip` with NO slug/name-mismatch check.** The spec sketch's "name-mismatch → 409" is impossible for flat kit zips (the zip carries no name to compare — see Global Constraints); re-upload simply re-validates the archive and overwrites the stored bytes.
- **Enable/disable is folded into `PATCH /:slug`** (`{ enabled }`) rather than separate `/enable`|`/disable` sub-routes, matching how the skill admin route edits `enabled` via its single `PATCH` (the audit still records `KitToggle` when `enabled` changes).

---

## Review Focus

- **Unauthorized caller requests a scoped kit's zip** — `GET /api/kits/download/:slug` must re-check `visibleKit` and return 404 (never the bytes) for a user outside the kit's `scope` (dept/user). *Pinned in Task 7 (download route test).*
- **Kit granted to a parent department: visible to a descendant, hidden from a sibling** — visibility must expand granted `deptIds` to their subtree via `descendantsOf`, exactly like `visibleSkill`. *Pinned in Task 7 (dept-tree test, mirrors `mcpMarketplaceScope.test.ts`).*
- **Vendored zip missing or corrupt at init** — seeding must log and skip that kit (non-fatal); a garbage file must not be seeded; a second run inserts nothing new. *Pinned in Task 3 (missing-file + corrupt-file + idempotency tests).*
- **Admin uploads a kit zip with no `SKILL.md` anywhere, a non-slug `slug`, or a duplicate `slug`** — `parseKitZip` rejects no-skill/traversal/oversized/empty with a distinct code → 400; the create route rejects a bad `slug` → 400 and a duplicate `slug` → 409. *Pinned in Task 2 (`parseKitZip` tests) and Task 5 (duplicate-slug 409 test).*
- **A consumer (non-enterprise) desktop session opens 专家套件** — the 企业 tab shows its connect-to-enterprise empty state while 内置 still lists the local built-in kits; nothing throws and the app is not blocked. *Pinned in Task 11 (manual verification; `fetchEnterpriseKits` returns `[]` on `!success`).*

---

## File Structure

**Server (new):** `seeds/kits/*.zip` (12 vendored), `src/db/migrations/040_kit_catalog.sql`, `src/lib/kitZip.ts` (`parseKitZip`), `src/org/builtinKits.ts` (manifest + seed), `src/models/kitCatalog.ts` (service), `src/routes/kitCatalog.ts` (public: list + download), `src/routes/kitCatalogAdmin.ts` (admin CRUD), and one test file per unit under `tests/`.
**Server (edit):** `src/lib/stateDir.ts` (`kitStoreDir`), `src/shared/permissionPoints.ts` (points/module/roles), `src/shared/enterpriseServerConstants.ts` (`AuditAction`), `src/server.ts` (wire seed + routes).
**SPA:** `web/src/shared/permissions.ts` (mirror), `web/src/api/kitCatalog.ts` (api module), `web/src/pages/kitManage/` (page + components), `web/src/i18n.ts` (nav key), `web/src/App.tsx` (route), `web/src/components/Sidebar.tsx` (nav).
**Desktop (edit):** `src/main/auth/enterpriseClient.ts`, `src/main/ipcHandlers/kits/handlers.ts`, `src/main/preload.ts`, `src/renderer/types/electron.d.ts`, `src/renderer/services/kit.ts`, `src/renderer/services/i18n.ts`, `src/renderer/components/kits/KitsManager.tsx`.

**Task dependency order:** 1 (schema + points + `kitStoreDir`) → 2 (`parseKitZip`) → 3 (seed; consumes 1+2) → 4 (service; consumes 1) → 5 (admin routes; consumes 2,3,4) → 6 (public routes; consumes 1,4) → 7 (wire into server; consumes 3,5,6) → 8 (SPA) → 9 (desktop client) → 10 (desktop IPC) → 11 (desktop renderer). Tasks 5 and 6 are independent of each other (both depend on 4) and can be done in either order.

---

### Task 1: Migration 040 — `kit_catalog` tables + kit RBAC points + `kitStoreDir`

**Files:**
- Create: `enterprise_server/src/db/migrations/040_kit_catalog.sql`
- Modify: `enterprise_server/src/shared/permissionPoints.ts`
- Modify: `enterprise_server/src/shared/enterpriseServerConstants.ts`
- Modify: `enterprise_server/src/lib/stateDir.ts`
- Test: `enterprise_server/tests/db/040_kit_catalog.test.ts`
- Test: `enterprise_server/tests/shared/permissionPoints.test.ts` (append)

**Interfaces:**
- Produces: tables `kit_categories`, `kit_catalog`; `kitStoreDir(kitId: string): string`; `PermissionPoint.KitView/KitCreate/KitEdit/KitToggle/KitDelete`; a `kit` module in `PERMISSION_MODULES`; `AuditAction.KitCreate/KitUpdate/KitToggle/KitDelete/KitCategoryCreate/KitCategoryUpdate/KitCategoryDelete`.

- [ ] **Step 1: Write the failing migration test**

`enterprise_server/tests/db/040_kit_catalog.test.ts`:
```ts
import { beforeEach, describe, expect, test, vi } from 'vitest';
import '../../helpers/setupEnv';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

async function cols(table: string): Promise<Set<string>> {
  const r = await testPool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

describe('migration 040 kit_catalog', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('kit_catalog has the required columns', async () => {
    const c = await cols('kit_catalog');
    for (const col of ['slug', 'org_id', 'category_id', 'name_en', 'name_zh', 'description_en',
      'description_zh', 'icon_url', 'author', 'version', 'try_asking', 'skill_list', 'scope',
      'enabled', 'is_builtin', 'zip_file_name', 'zip_file_size', 'zip_sha256', 'created_at', 'updated_at']) {
      expect(c.has(col)).toBe(true);
    }
  });

  test('kit_categories has localized names + org scoping + reserved flag', async () => {
    const c = await cols('kit_categories');
    for (const col of ['category_id', 'name_zh', 'name_en', 'display_order', 'org_id', 'is_reserved']) {
      expect(c.has(col)).toBe(true);
    }
  });

  test('org creation seeds the reserved uncategorized bucket', async () => {
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1')`);
    const r = await testPool.query(
      `SELECT category_id, is_reserved FROM kit_categories WHERE org_id = 'o1' AND category_id = 'uncategorized'`);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].is_reserved).toBe(true);
  });

  test('grants kit points to org_admin/super_admin', async () => {
    const r = await testPool.query(
      `SELECT name, permissions FROM roles WHERE name IN ('org_admin','super_admin')`);
    for (const row of r.rows) {
      expect(row.permissions).toContain('kit:view');
      expect(row.permissions).toContain('kit:create');
      expect(row.permissions).toContain('kit:delete');
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/db/040_kit_catalog.test.ts`
Expected: FAIL — `kit_catalog` does not exist / `kit:view` not granted.

- [ ] **Step 3: Write the migration**

`enterprise_server/src/db/migrations/040_kit_catalog.sql`:
```sql
-- Migration 040: org-scoped expert-suite (kit) catalog. Mirrors the 023/038
-- skill_marketplace subsystem: a natural-TEXT-key catalog (keyed by slug),
-- org-scoped TEXT-slug categories with a reserved "uncategorized" bucket,
-- scope JSONB ACL, and zip metadata. category_id has NO FK (route-enforced,
-- matching 038's skill category precedent).
--
-- Re-run safe: CREATE TABLE IF NOT EXISTS; reserved bucket seeded via a
-- single-quoted plpgsql trigger (no dollar-quoting) so splitStatements keeps
-- the whole CREATE FUNCTION as one statement.

CREATE TABLE IF NOT EXISTS kit_categories (
  category_id   TEXT NOT NULL,
  name_zh       TEXT NOT NULL,
  name_en       TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_reserved   BOOLEAN NOT NULL DEFAULT false,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, category_id)
);

CREATE TABLE IF NOT EXISTS kit_catalog (
  slug           TEXT NOT NULL,
  org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  category_id    TEXT,
  name_en        TEXT,
  name_zh        TEXT,
  description_en TEXT,
  description_zh TEXT,
  icon_url       TEXT,
  author         TEXT,
  version        TEXT,
  try_asking     JSONB NOT NULL DEFAULT '[]'::jsonb,
  skill_list     JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope          JSONB NOT NULL DEFAULT '{"allCompany":false,"deptIds":[],"userIds":[]}'::jsonb,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  is_builtin     BOOLEAN NOT NULL DEFAULT false,
  zip_file_name  TEXT,
  zip_file_size  BIGINT,
  zip_sha256     TEXT,
  created_by     TEXT,
  updated_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, slug)
);

CREATE INDEX IF NOT EXISTS kit_catalog_org_id ON kit_catalog (org_id);

-- Per-org reserved bucket (mirror of the 038 skill bucket): seeded at
-- org-creation time; the admin delete path also guarantees it as a fallback.
CREATE OR REPLACE FUNCTION kit_ensure_uncategorized()
  RETURNS trigger
  LANGUAGE plpgsql
  AS 'BEGIN INSERT INTO kit_categories (category_id, name_zh, name_en, display_order, is_reserved, org_id) VALUES (''uncategorized'', ''未分类'', ''Uncategorized'', 0, true, NEW.id) ON CONFLICT (org_id, category_id) DO NOTHING; RETURN NULL; END;';
DROP TRIGGER IF EXISTS trg_kit_org_uncategorized ON orgs;
CREATE TRIGGER trg_kit_org_uncategorized
  AFTER INSERT ON orgs
  FOR EACH ROW
  EXECUTE FUNCTION kit_ensure_uncategorized();

-- Idempotently grant the new kit points to org_admin / super_admin (mirror 037).
UPDATE roles
SET permissions = permissions || '["kit:view","kit:create","kit:edit","kit:toggle","kit:delete"]'::jsonb
WHERE name IN ('org_admin','super_admin')
  AND NOT (permissions @> '["kit:view"]'::jsonb);
```

- [ ] **Step 4: Add the permission points + module + role grants**

In `enterprise_server/src/shared/permissionPoints.ts`:
- Add to the `PermissionPoint` object (after the `Agent*` line, before `SsoView`):
  `KitView: 'kit:view', KitCreate: 'kit:create', KitEdit: 'kit:edit', KitToggle: 'kit:toggle', KitDelete: 'kit:delete',`
- Add a module array next to the other module arrays (after the `agent` array):
  `const kit = [PermissionPoint.KitView, PermissionPoint.KitCreate, PermissionPoint.KitEdit, PermissionPoint.KitToggle, PermissionPoint.KitDelete];`
- Add to `PERMISSION_MODULES` (after the `agent` entry):
  `{ key: 'kit', name: '套件管理', desc: '管理企业专家套件：新增、编辑、删除及启用/禁用与授权范围', points: kit },`
- Add `...kit` to the `orgAdmin` array.
- Add `PermissionPoint.KitView` to the `member` array.

In `enterprise_server/src/shared/enterpriseServerConstants.ts`, add to the `AuditAction` object (after the `SkillCategoryDelete` line):
```ts
  KitCreate: 'kit_create',
  KitUpdate: 'kit_update',
  KitToggle: 'kit_toggle',
  KitDelete: 'kit_delete',
  KitCategoryCreate: 'kit_category_create',
  KitCategoryUpdate: 'kit_category_update',
  KitCategoryDelete: 'kit_category_delete',
```

In `enterprise_server/src/lib/stateDir.ts`, append (uses the existing `join` + `_stateDir`):
```ts
export function kitStoreDir(kitId: string): string {
  return join(_stateDir, 'kit-marketplace', kitId);
}
```

- [ ] **Step 5: Append a permissionPoints assertion**

Append to `enterprise_server/tests/shared/permissionPoints.test.ts` (import `PERMISSION_MODULES` if only `PERMISSION_POINTS` is currently imported):
```ts
test('kit points and module exist', () => {
  expect(PERMISSION_POINTS).toContain('kit:view');
  expect(PERMISSION_POINTS).toContain('kit:delete');
  expect(PERMISSION_MODULES.find((m) => m.key === 'kit')).toBeDefined();
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd enterprise_server && npx vitest run tests/db/040_kit_catalog.test.ts tests/shared/permissionPoints.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/src/db/migrations/040_kit_catalog.sql enterprise_server/src/shared/permissionPoints.ts enterprise_server/src/shared/enterpriseServerConstants.ts enterprise_server/src/lib/stateDir.ts enterprise_server/tests/db/040_kit_catalog.test.ts enterprise_server/tests/shared/permissionPoints.test.ts
git commit -m "feat(enterprise): add kit_catalog schema, RBAC points and kit store dir"
```

---

### Task 2: `parseKitZip` (flat, slug-less)

**Files:**
- Create: `enterprise_server/src/lib/kitZip.ts`
- Test: `enterprise_server/tests/lib/kitZip.test.ts`

**Interfaces:**
- Produces: `parseKitZip(buf: Buffer): { size: number; sha256: string }`; `MAX_KIT_ZIP_BYTES: number`; `class KitZipError extends Error { code: 'empty' | 'too_large' | 'bad_zip' | 'no_skills' }`.
- Returns **no slug** (kit zips are flat — see Global Constraints). The slug is supplied by the caller.

- [ ] **Step 1: Write the failing test**

`enterprise_server/tests/lib/kitZip.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import AdmZip from 'adm-zip';
import { parseKitZip, KitZipError, MAX_KIT_ZIP_BYTES } from '../../src/lib/kitZip';

function zip(entries: Array<[string, string]>): Buffer {
  const z = new AdmZip();
  for (const [name, data] of entries) z.addFile(name, Buffer.from(data));
  return Buffer.from(z.toBuffer());
}

describe('parseKitZip', () => {
  test('accepts a flat multi-skill kit (many SKILL.md at the root)', () => {
    const buf = zip([['architecture/SKILL.md', '# a'], ['code-review/SKILL.md', '# b']]);
    const p = parseKitZip(buf);
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.size).toBeGreaterThan(0);
  });

  test('accepts a single-skill kit', () => {
    const p = parseKitZip(zip([['solo/SKILL.md', '# s']]));
    expect(p.size).toBeGreaterThan(0);
  });

  test('rejects empty', () => {
    expect(() => parseKitZip(Buffer.alloc(0))).toThrow(KitZipError);
  });

  test('rejects over-limit zip', () => {
    expect(() => parseKitZip(Buffer.alloc(MAX_KIT_ZIP_BYTES + 1))).toThrow(KitZipError);
  });

  test('rejects a zip with no SKILL.md anywhere', () => {
    expect(() => parseKitZip(zip([['foo/bar.txt', 'x']]))).toThrow(KitZipError);
  });

  test('rejects path traversal', () => {
    expect(() => parseKitZip(zip([['foo/../../../etc/SKILL.md', 'x']]))).toThrow(KitZipError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/lib/kitZip.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/kitZip'`.

- [ ] **Step 3: Implement `parseKitZip`**

`enterprise_server/src/lib/kitZip.ts`:
```ts
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

/**
 * A kit zip bundles MANY skill folders, each with its own SKILL.md, laid out
 * FLAT at the archive root (e.g. `architecture/SKILL.md`, `code-review/SKILL.md`)
 * with no wrapping kit directory — unlike a single-skill marketplace zip, whose
 * sole top-level dir carries the skill's slug. So we do NOT infer a slug here;
 * the slug is supplied by the caller (admin create form / seed manifest). We
 * only validate: non-empty, under the size cap, parseable, no traversal, and
 * at least one SKILL.md present. Cap is higher than skills because kits are
 * larger.
 */
export const MAX_KIT_ZIP_BYTES = 50 * 1024 * 1024;

export class KitZipError extends Error {
  constructor(public code: 'empty' | 'too_large' | 'bad_zip' | 'no_skills', message: string) {
    super(message);
  }
}

export function parseKitZip(buf: Buffer): { size: number; sha256: string } {
  if (buf.byteLength === 0) throw new KitZipError('empty', 'empty zip');
  if (buf.byteLength > MAX_KIT_ZIP_BYTES) throw new KitZipError('too_large', `zip exceeds ${MAX_KIT_ZIP_BYTES} bytes`);

  let zip: AdmZip;
  try { zip = new AdmZip(buf); } catch { throw new KitZipError('bad_zip', 'unparseable zip'); }

  // Path traversal guard (mirror skillZip.ts).
  for (const e of zip.getEntries()) {
    if (e.entryName.split('/').some((seg) => seg === '..' || seg === '.')) {
      throw new KitZipError('bad_zip', 'zip entry path traversal');
    }
  }

  const hasSkillMd = zip.getEntries().some(
    (e) => !e.isDirectory && e.entryName.split('/').pop() === 'SKILL.md',
  );
  if (!hasSkillMd) throw new KitZipError('no_skills', 'zip contains no SKILL.md');

  return { size: buf.byteLength, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/lib/kitZip.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/lib/kitZip.ts enterprise_server/tests/lib/kitZip.test.ts
git commit -m "feat(enterprise): add flat kit zip parser"
```

---

### Task 3: Vendor the 12 kit zips + `BUILTIN_KITS` manifest + seed

**Files:**
- Create: `enterprise_server/seeds/kits/` (directory, 12 `.zip` files)
- Create: `enterprise_server/src/org/builtinKits.ts`
- Test: `enterprise_server/tests/org/builtinKits.test.ts`

**Interfaces:**
- Consumes: `parseKitZip`/`KitZipError` (Task 2), `kitStoreDir` (Task 1), `pool`.
- Produces: `BUILTIN_KITS: BuiltinKitDef[]`, `BUILTIN_KIT_CATEGORIES: ReadonlyArray<{ category_id: string; name_zh: string; name_en: string }>`, `seedBuiltinKits(orgId: string): Promise<void>`, `seedBuiltinKitsForAllOrgs(): Promise<void>`, `resolveKitsSeedDir(): string`, and type `BuiltinKitDef`.

`BuiltinKitDef` shape (metadata only; bytes are read from the seed dir at runtime, never stored here):
```ts
interface BuiltinKitDef {
  slug: string;            // 'engineering', 'design', ... (desktop kit id)
  category: string;        // built-in category slug (from BUILTIN_KIT_CATEGORIES)
  name_en: string; name_zh: string;
  description_en: string; description_zh: string;
  icon_url: string;
  author: string;          // always 'GenWork'
  version: string;         // verbatim from the store (e.g. '1.2.0')
  try_asking: Array<{ en: string; zh: string }>;
  skill_list: Array<Record<string, unknown>>;   // the store's skills.list verbatim
  seedZipFile: string;     // `${slug}.zip`
}
```

- [ ] **Step 1: Vendor the 12 zips (one-time network fetch — the only step that touches the network, deliberately, to bake the data into the repo)**

Run:
```bash
mkdir -p /Users/paulwang/work/GenWork/enterprise_server/seeds/kits
cd /Users/paulwang/work/GenWork/enterprise_server/seeds/kits
# slug -> Youdao CDN zip hash (from the live kit-store; see /tmp/kit-store.json)
declare -A Z=(
  [engineering]=8201efaf99a7343fbee2e99a9b95b338
  [design]=a3c5595a8a1a57fef82e04d9c5dc37a6
  [operations]=64d6d25557a37c3c0430b38f8e5b3ec3
  [product-management]=07c4ac3964e8c84f25422e5de48be7df
  [human-resources]=0c116a075ea33761d27fb2c2e1da5b1d
  [marketing]=c8183beace5d83ef7340920807dade22
  [finance]=fa6cddf1a1dbeee9834fe2413025fdcf
  [sales]=bfc15adb11af230842d938393ceb02c8
  [data]=82406148b9dbd36efe6334af69c2b9e2
  [customer-support]=052229d934c4043de8711c7fe68fe7c0
  [legal]=31b783a641cc49380782d6b6bcb0766e
  [bio-research]=296d38bbc3a6ccef1e375c50bf26b62c
)
for s in "${!Z[@]}"; do curl -sS --max-time 120 -L -o "$s.zip" "https://ydhardwarebusiness.nosdn.127.net/${Z[$s]}.zip"; done
ls -1 *.zip | wc -l                                   # expect 12
for f in *.zip; do unzip -t "$f" >/dev/null || echo "BAD $f"; done   # expect no BAD lines
```
Expected: 12 files, no `BAD` lines. If any hash is stale (the CDN may rotate hashes), re-derive the 12 hashes from the live store (`/tmp/kit-store.json` → `kits[].skills.bundle` basename) and re-run.

- [ ] **Step 2: Write the failing test**

`enterprise_server/tests/org/builtinKits.test.ts`:
```ts
import { unlinkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import AdmZip from 'adm-zip';
import '../../helpers/setupEnv';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { BUILTIN_KITS, BUILTIN_KIT_CATEGORIES, seedBuiltinKits } from '../../src/org/builtinKits';

/** Write a tiny valid zip named <name> into dir. Bytes are irrelevant to the seed
 * (it only sha256s + copies them), so a 1-SKILL.md fixture satisfies parseKitZip. */
function makeZip(dir: string, name: string): void {
  const z = new AdmZip();
  z.addFile(`${name}/SKILL.md`, Buffer.from('# s\n'));
  z.writeZip(join(dir, name));
}

describe('seedBuiltinKits', () => {
  let seedDir: string;
  let orgId: string;
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    seedDir = mkdtempSync(join(tmpdir(), 'kitseed-'));
    process.env.KITS_SEED_DIR = seedDir;
    for (const k of BUILTIN_KITS) makeZip(seedDir, k.seedZipFile);
    const r = await testPool.query('INSERT INTO orgs(id, name) VALUES ($1,$2)', [`org-${randomUUID().slice(0, 8)}`, 'T']);
    orgId = r.rows[0].id as string;
  });
  afterEach(() => { delete process.env.KITS_SEED_DIR; });

  test('seeds all built-in kits + categories with all-company scope', async () => {
    await seedBuiltinKits(orgId);
    const kits = await testPool.query(
      `SELECT slug, scope, enabled, is_builtin, author FROM kit_catalog WHERE org_id = $1 ORDER BY slug`, [orgId]);
    expect(kits.rowCount).toBe(BUILTIN_KITS.length);
    for (const row of kits.rows) {
      expect(row.enabled).toBe(true);
      expect(row.is_builtin).toBe(true);
      expect(row.author).toBe('GenWork');
      expect(row.scope).toEqual({ allCompany: true, deptIds: [], userIds: [] });
    }
    const cats = await testPool.query(`SELECT category_id FROM kit_categories WHERE org_id = $1`, [orgId]);
    expect(cats.rowCount).toBeGreaterThanOrEqual(BUILTIN_KIT_CATEGORIES.length);
  });

  test('is idempotent: a second run adds nothing', async () => {
    await seedBuiltinKits(orgId);
    await seedBuiltinKits(orgId);
    const r = await testPool.query(`SELECT count(*)::int AS n FROM kit_catalog WHERE org_id = $1`, [orgId]);
    expect(r.rows[0].n).toBe(BUILTIN_KITS.length);
  });

  test('skips a missing and a corrupt seed file without throwing', async () => {
    const missing = BUILTIN_KITS[0].slug;
    const corrupt = BUILTIN_KITS[1].slug;
    unlinkSync(join(seedDir, `${missing}.zip`));          // missing
    writeFileSync(join(seedDir, `${corrupt}.zip`), 'not a zip'); // corrupt on purpose
    await expect(seedBuiltinKits(orgId)).resolves.toBeDefined();
    const absent = await testPool.query(
      `SELECT count(*)::int AS n FROM kit_catalog WHERE org_id = $1 AND slug IN ($2,$3)`, [orgId, missing, corrupt]);
    expect(absent.rows[0].n).toBe(0);
    const total = await testPool.query(`SELECT count(*)::int AS n FROM kit_catalog WHERE org_id = $1`, [orgId]);
    expect(total.rows[0].n).toBe(BUILTIN_KITS.length - 2);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/org/builtinKits.test.ts`
Expected: FAIL — `Cannot find module '../../src/org/builtinKits'`.

- [ ] **Step 4: Generate the `BUILTIN_KITS` manifest (throwaway script — reads the live store, pins `author` to `GenWork`)**

Run from `enterprise_server/`:
```bash
cd /Users/paulwang/work/GenWork/enterprise_server
curl -sS --max-time 60 -o /tmp/kit-store.json \
  'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/kit-store'
node - <<'EOF'
const fs = require('node:fs');
const store = JSON.parse(fs.readFileSync('/tmp/kit-store.json', 'utf8'));
const kits = store.data.value.kits;
const CAT = {
  engineering: 'eng', data: 'eng', design: 'design', 'product-management': 'product',
  operations: 'growth', marketing: 'growth', sales: 'sales-cs', 'customer-support': 'sales-cs',
  'human-resources': 'func', finance: 'func', legal: 'func', 'bio-research': 'func',
};
const rows = kits.map((k) => `  {
    slug: ${JSON.stringify(k.id)},
    category: ${JSON.stringify(CAT[k.id] ?? 'func')},
    name_en: ${JSON.stringify(k.name.en)}, name_zh: ${JSON.stringify(k.name.zh)},
    description_en: ${JSON.stringify(k.description.en)}, description_zh: ${JSON.stringify(k.description.zh)},
    icon_url: ${JSON.stringify(k.icon)},
    author: "GenWork",
    version: ${JSON.stringify(k.version)},
    try_asking: ${JSON.stringify(k.tryAsking)},
    skill_list: ${JSON.stringify(k.skills.list)},
    seedZipFile: ${JSON.stringify(`${k.id}.zip`)},
  },`);
const out = `// Auto-generated from the Youdao kit-store (plan 2026-10-07). Metadata copied
// verbatim; author is pinned to "GenWork" per product decision. Do not hand-edit.
export interface BuiltinKitDef {
  slug: string; category: string;
  name_en: string; name_zh: string; description_en: string; description_zh: string;
  icon_url: string; author: string; version: string;
  try_asking: Array<{ en: string; zh: string }>;
  skill_list: Array<Record<string, unknown>>;
  seedZipFile: string;
}
export const BUILTIN_KIT_CATEGORIES = [
  { category_id: 'eng', name_zh: '工程研发', name_en: 'Engineering' },
  { category_id: 'design', name_zh: '设计', name_en: 'Design' },
  { category_id: 'product', name_zh: '产品', name_en: 'Product' },
  { category_id: 'growth', name_zh: '运营增长', name_en: 'Ops & Growth' },
  { category_id: 'sales-cs', name_zh: '销售客服', name_en: 'Sales & Support' },
  { category_id: 'func', name_zh: '职能支持', name_en: 'Functional' },
] as const;
export const BUILTIN_KITS: BuiltinKitDef[] = [
${rows.join('\n')}
];
`;
fs.mkdirSync('src/org', { recursive: true });
fs.writeFileSync('/tmp/builtinKits.generated.ts', out);
console.log('kits:', kits.length);
EOF
head -5 /tmp/builtinKits.generated.ts     # sanity: type + categories present
grep -c "slug:" /tmp/builtinKits.generated.ts   # expect 12
```

- [ ] **Step 5: Assemble `src/org/builtinKits.ts`**

Paste the generated `BuiltinKitDef` / `BUILTIN_KIT_CATEGORIES` / `BUILTIN_KITS` from `/tmp/builtinKits.generated.ts` into `src/org/builtinKits.ts`, then append the seed logic (imports at top):
```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pool } from '../db/pool';
import { parseKitZip, KitZipError } from '../lib/kitZip';
import { kitStoreDir } from '../lib/stateDir';

/** Resolve the vendored seed dir. Env override wins (tests); default is
 * <cwd>/seeds/kits (the repo location, matching server.ts's web-dist convention). */
export function resolveKitsSeedDir(): string {
  const explicit = process.env.KITS_SEED_DIR;
  return explicit && explicit.trim().length > 0 ? explicit : join(process.cwd(), 'seeds', 'kits');
}

/** Idempotently seed the built-in categories + kits for one org from LOCAL
 * vendored zips (NO network at startup). A missing or unparseable seed file
 * is logged and skipped — seeding is best-effort and must never block boot. */
export async function seedBuiltinKits(orgId: string): Promise<void> {
  const seedDir = resolveKitsSeedDir();

  for (const cat of BUILTIN_KIT_CATEGORIES) {
    await pool.query(
      `INSERT INTO kit_categories (category_id, name_zh, name_en, display_order, org_id)
       VALUES ($1,$2,$3,0,$4) ON CONFLICT (org_id, category_id) DO NOTHING`,
      [cat.category_id, cat.name_zh, cat.name_en, orgId],
    );
  }
  const catRows = await pool.query<{ category_id: string }>(
    'SELECT category_id FROM kit_categories WHERE org_id = $1', [orgId]);
  const catSet = new Set(catRows.rows.map((r) => r.category_id));

  for (const k of BUILTIN_KITS) {
    const zipPath = join(seedDir, k.seedZipFile);
    if (!existsSync(zipPath)) {
      console.error(`[KitSeed] missing vendored seed ${zipPath}; skipping ${k.slug}`);
      continue;
    }
    const buf = readFileSync(zipPath);
    // Validate before persisting: a corrupt/garbage vendored file must be
    // skipped, not seeded (parseKitZip throws on a bad zip).
    let sha: string; let size: number;
    try {
      const parsed = parseKitZip(buf);
      sha = parsed.sha256;
      size = parsed.size;
    } catch (e) {
      console.error(`[KitSeed] invalid vendored seed for ${k.slug}:`, e instanceof KitZipError ? e.code : e);
      continue;
    }
    const storeDir = kitStoreDir(k.slug);
    mkdirSync(storeDir, { recursive: true });
    copyFileSync(zipPath, join(storeDir, 'kit.zip'));
    const scope = JSON.stringify({ allCompany: true, deptIds: [], userIds: [] });
    try {
      await pool.query(
        `INSERT INTO kit_catalog
           (slug, org_id, category_id, name_en, name_zh, description_en, description_zh,
            icon_url, author, version, try_asking, skill_list, scope, enabled, is_builtin,
            zip_file_name, zip_file_size, zip_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,true,true,$14,$15,$16)
         ON CONFLICT (org_id, slug) DO NOTHING`,
        [k.slug, orgId, catSet.has(k.category) ? k.category : null,
         k.name_en, k.name_zh, k.description_en, k.description_zh, k.icon_url, k.author, k.version,
         JSON.stringify(k.try_asking), JSON.stringify(k.skill_list), scope,
         `${k.slug}.zip`, size, sha],
      );
    } catch (e) {
      console.error(`[KitSeed] failed to seed ${k.slug}:`, e);
    }
  }
}

export async function seedBuiltinKitsForAllOrgs(): Promise<void> {
  const r = await pool.query<{ id: string }>('SELECT id FROM orgs');
  for (const org of r.rows) await seedBuiltinKits(org.id);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/org/builtinKits.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add enterprise_server/seeds/kits enterprise_server/src/org/builtinKits.ts enterprise_server/tests/org/builtinKits.test.ts
git commit -m "feat(enterprise): vendor 12 built-in kits and add local seed logic"
```

---

### Task 4: `kitCatalog` service (org-scoped)

**Files:**
- Create: `enterprise_server/src/models/kitCatalog.ts`
- Test: `enterprise_server/tests/models/kitCatalog.test.ts`

**Interfaces:**
- Consumes: `kitStoreDir` (Task 1), `pool`.
- Produces: `kitCatalog` const with `add(orgId, input, createdBy)`, `patch(orgId, slug, fields, updatedBy)`, `setEnabled(orgId, slug, enabled, updatedBy)`, `remove(orgId, slug)`, `list(orgId)`, `listForAdmin(orgId)`, `getBySlug(orgId, slug)`; `type KitScope`; `sanitizeKitScope(scope, orgId)`; `interface KitRow`.

- [ ] **Step 1: Write the failing test**

`enterprise_server/tests/models/kitCatalog.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import '../../helpers/setupEnv';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { kitCatalog } from '../../src/models/kitCatalog';

async function org(): Promise<string> {
  const r = await testPool.query('INSERT INTO orgs(id, name) VALUES ($1,$2)', [`org-${randomUUID().slice(0, 8)}`, 'T']);
  return r.rows[0].id as string;
}
const scope = () => ({ allCompany: true, deptIds: [], userIds: [] });
const zip = { size: 10, sha256: 'x', fileName: 'a.zip' };

describe('kitCatalog service', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('add rejects duplicate slug with a sentinel error', async () => {
    const orgId = await org();
    await kitCatalog.add(orgId, { slug: 'engineering', scope: scope(), zip }, 'tester');
    await expect(
      kitCatalog.add(orgId, { slug: 'engineering', scope: scope(), zip }, 'tester'),
    ).rejects.toThrow('kit_duplicate');
  });

  test('list hides disabled kits; listForAdmin includes them', async () => {
    const orgId = await org();
    await kitCatalog.add(orgId, { slug: 'a', scope: scope(), zip }, 't');
    await kitCatalog.add(orgId, { slug: 'b', scope: scope(), zip }, 't');
    await kitCatalog.setEnabled(orgId, 'b', false, 't');
    expect((await kitCatalog.list(orgId)).map((k) => k.slug)).toEqual(['a']);
    expect((await kitCatalog.listForAdmin(orgId)).map((k) => k.slug).sort()).toEqual(['a', 'b']);
  });

  test('is org-scoped: another org sees nothing', async () => {
    const o1 = await org(); const o2 = await org();
    await kitCatalog.add(o1, { slug: 'a', scope: scope(), zip }, 't');
    expect((await kitCatalog.list(o2)).length).toBe(0);
    expect((await kitCatalog.listForAdmin(o2)).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/models/kitCatalog.test.ts`
Expected: FAIL — `Cannot find module '../../src/models/kitCatalog'`.

- [ ] **Step 3: Implement the service**

`enterprise_server/src/models/kitCatalog.ts`:
```ts
import { rmSync } from 'node:fs';
import { pool } from '../db/pool';
import { kitStoreDir } from '../lib/stateDir';

export type KitScope = { allCompany: boolean; deptIds: string[]; userIds: string[] };

export interface KitRow {
  slug: string;
  org_id: string;
  category_id: string | null;
  name_en: string | null;
  name_zh: string | null;
  description_en: string | null;
  description_zh: string | null;
  icon_url: string | null;
  author: string | null;
  version: string | null;
  try_asking: Array<{ en: string; zh: string }>;
  skill_list: Array<Record<string, unknown>>;
  scope: KitScope;
  enabled: boolean;
  is_builtin: boolean;
  zip_file_name: string | null;
  zip_file_size: number | null;
  zip_sha256: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface KitAddInput {
  slug: string;
  name_en?: string | null; name_zh?: string | null;
  description_en?: string | null; description_zh?: string | null;
  icon_url?: string | null; author?: string | null; version?: string | null;
  category_id?: string | null;
  try_asking?: Array<{ en: string; zh: string }>;
  skill_list?: Array<Record<string, unknown>>;
  scope: KitScope;
  zip: { size: number; sha256: string; fileName: string };
}

export type KitPatchFields = Partial<{
  name_en: string; name_zh: string; description_en: string; description_zh: string;
  icon_url: string; author: string; version: string; category_id: string;
  scope: KitScope; enabled: boolean;
}>;

/** Drop dept/user ids that do not exist in the org; keep allCompany. Mirrors
 * skillMarketplaceAdmin.sanitizeScope. */
export async function sanitizeKitScope(scope: KitScope, orgId: string): Promise<KitScope> {
  const deptR = scope.deptIds.length
    ? await pool.query<{ id: string }>('SELECT id FROM departments WHERE org_id = $1 AND id = ANY($2)', [orgId, scope.deptIds])
    : { rows: [] as { id: string }[] };
  const userR = scope.userIds.length
    ? await pool.query<{ id: string }>('SELECT id FROM users WHERE org_id = $1 AND id = ANY($2)', [orgId, scope.userIds])
    : { rows: [] as { id: string }[] };
  return { allCompany: scope.allCompany, deptIds: deptR.rows.map((r) => r.id), userIds: userR.rows.map((r) => r.id) };
}

export const kitCatalog = {
  async add(orgId: string, input: KitAddInput, createdBy: string): Promise<void> {
    const dup = await pool.query('SELECT 1 FROM kit_catalog WHERE org_id = $1 AND slug = $2', [orgId, input.slug]);
    if ((dup.rowCount ?? 0) > 0) throw new Error('kit_duplicate');
    const scope = await sanitizeKitScope(input.scope, orgId);
    await pool.query(
      `INSERT INTO kit_catalog
         (slug, org_id, category_id, name_en, name_zh, description_en, description_zh,
          icon_url, author, version, try_asking, skill_list, scope, enabled, is_builtin,
          zip_file_name, zip_file_size, zip_sha256, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,TRUE,FALSE,$14,$15,$16,$17,$17)`,
      [input.slug, orgId, input.category_id ?? null, input.name_en ?? null, input.name_zh ?? null,
       input.description_en ?? null, input.description_zh ?? null, input.icon_url ?? null, input.author ?? null,
       input.version ?? null, JSON.stringify(input.try_asking ?? []), JSON.stringify(input.skill_list ?? []),
       JSON.stringify(scope), input.zip.fileName, input.zip.size, input.zip.sha256, createdBy],
    );
  },

  async patch(orgId: string, slug: string, fields: KitPatchFields, updatedBy: string): Promise<boolean> {
    // Mirror the skill admin patch: $1 = slug, $2 = org_id, then dynamic sets,
    // then updated_by appended last.
    const sets: string[] = [];
    const params: unknown[] = [slug, orgId];
    const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (fields.name_en !== undefined) push('name_en', fields.name_en);
    if (fields.name_zh !== undefined) push('name_zh', fields.name_zh);
    if (fields.description_en !== undefined) push('description_en', fields.description_en);
    if (fields.description_zh !== undefined) push('description_zh', fields.description_zh);
    if (fields.icon_url !== undefined) push('icon_url', fields.icon_url);
    if (fields.author !== undefined) push('author', fields.author);
    if (fields.version !== undefined) push('version', fields.version);
    if (fields.category_id !== undefined) push('category_id', fields.category_id);
    if (fields.scope !== undefined) push('scope', JSON.stringify(await sanitizeKitScope(fields.scope, orgId)));
    if (fields.enabled !== undefined) push('enabled', fields.enabled);
    if (sets.length === 0) return false;
    params.push(updatedBy);
    const r = await pool.query(
      `UPDATE kit_catalog SET ${sets.join(', ')}, updated_by = $${params.length}, updated_at = NOW()
       WHERE slug = $1 AND org_id = $2`,
      params);
    return (r.rowCount ?? 0) > 0;
  },

  async setEnabled(orgId: string, slug: string, enabled: boolean, updatedBy: string): Promise<boolean> {
    const r = await pool.query(
      'UPDATE kit_catalog SET enabled = $3, updated_by = $4, updated_at = NOW() WHERE slug = $1 AND org_id = $2',
      [slug, orgId, enabled, updatedBy]);
    return (r.rowCount ?? 0) > 0;
  },

  async remove(orgId: string, slug: string): Promise<boolean> {
    const r = await pool.query('DELETE FROM kit_catalog WHERE slug = $1 AND org_id = $2', [slug, orgId]);
    const removed = (r.rowCount ?? 0) > 0;
    if (removed) rmSync(kitStoreDir(slug), { recursive: true, force: true });
    return removed;
  },

  async list(orgId: string): Promise<KitRow[]> {
    const r = await pool.query<KitRow>(
      'SELECT * FROM kit_catalog WHERE org_id = $1 AND enabled = TRUE ORDER BY updated_at DESC', [orgId]);
    return r.rows;
  },

  async listForAdmin(orgId: string): Promise<KitRow[]> {
    const r = await pool.query<KitRow>(
      'SELECT * FROM kit_catalog WHERE org_id = $1 ORDER BY updated_at DESC', [orgId]);
    return r.rows;
  },

  async getBySlug(orgId: string, slug: string): Promise<KitRow | null> {
    const r = await pool.query<KitRow>('SELECT * FROM kit_catalog WHERE org_id = $1 AND slug = $2', [orgId, slug]);
    return r.rows[0] ?? null;
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/models/kitCatalog.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/models/kitCatalog.ts enterprise_server/tests/models/kitCatalog.test.ts
git commit -m "feat(enterprise): add org-scoped kitCatalog service"
```

---

### Task 5: Admin routes (`/api/admin/kits/*`)

**Files:**
- Create: `enterprise_server/src/routes/kitCatalogAdmin.ts`
- Test: `enterprise_server/tests/routes/kitCatalogAdmin.test.ts`

**Interfaces:**
- Consumes: `kitCatalog` + `sanitizeKitScope` (Task 4), `parseKitZip`/`KitZipError` (Task 2), `kitStoreDir` (Task 1), `requireAuth`/`requirePermission` (`../auth/middleware`), `PermissionPoint as PP`, `auditStore`, `AuditAction`, `zod`.
- Produces: exported `kitCatalogAdminRoutes: Hono`.

Endpoint set (mirrors `skillMarketplaceAdmin.ts`; `slug` is **caller-supplied** because kit zips are flat — `parse-zip` returns no slug):
- `GET /api/admin/kits` — `PP.KitView` → array of admin kit rows (incl. disabled).
- `GET /api/admin/kits/categories` — `PP.KitView` → categories.
- `POST /api/admin/kits/parse-zip` — `PP.KitCreate`, `parseKitZip(rawBody)`, stage bytes under `kitStoreDir('__tmp_' + tempToken)/kit.zip`, return `{ size, sha256, tempToken }`.
- `POST /api/admin/kits` — `PP.KitCreate`, body `{ tempToken, slug, nameEn?, nameZh?, descriptionEn?, descriptionZh?, icon?, author?, version?, category_id, tryAsking?, skillList?, scope }`; `slug` validated by `SLUG_RE` (zod); `category_id` must exist (else 400 `unknown_category`); re-parse staged zip; `kitCatalog.add` (catch `kit_duplicate` → 409 `slug_conflict`); move staged zip to `kitStoreDir(slug)/kit.zip`; `auditStore.write(KitCreate)`; return `{ slug }`.
- `PATCH /api/admin/kits/:slug` — `PP.KitEdit`, dynamic patch (metadata + `scope` + `enabled`); 404 if not found; audit `KitUpdate` (and `KitToggle` when `enabled` changes).
- `POST /api/admin/kits/:slug/zip` — `PP.KitEdit`, `parseKitZip` the new upload (400 on error), overwrite `kitStoreDir(slug)/kit.zip`, update `zip_*` columns; 404 if not found. (No slug-mismatch check — flat zips carry no slug.)
- `DELETE /api/admin/kits/:slug` — `PP.KitDelete` → `kitCatalog.remove`; 404 if not found.
- `POST /api/admin/kits/categories` — `PP.KitEdit`, `{ name_zh, name_en, display_order? }` → server slug `name_en.toLowerCase().replace(/\s+/g, '-')`; dup → 409.
- `PUT /api/admin/kits/categories/:categoryId` — `PP.KitEdit`, rename; 409 `reserved_category` for `uncategorized`.
- `DELETE /api/admin/kits/categories/:categoryId` — `PP.KitEdit`; 409 if reserved; re-home the org's kits in the category to `uncategorized` (ensuring the bucket exists) then delete.

- [ ] **Step 1: Write the failing route test**

`enterprise_server/tests/routes/kitCatalogAdmin.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import AdmZip from 'adm-zip';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import '../../helpers/setupEnv';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { signToken } from '../../src/auth/jwt';
import { kitCatalogAdminRoutes } from '../../src/routes/kitCatalogAdmin';
import { kitStoreDir } from '../../src/lib/stateDir';
import { join } from 'node:path';

const app = new Hono();
app.route('/', kitCatalogAdminRoutes);

const CT = { 'content-type': 'application/json' };
const zipBuf = (): Buffer => { const z = new AdmZip(); z.addFile('s1/SKILL.md', Buffer.from('# a')); return Buffer.from(z.toBuffer()); };

describe('kitCatalogAdminRoutes', () => {
  let orgId: string; let superToken: string;
  beforeEach(async () => {
    await resetSchema(); await runMigrations();
    const r = await testPool.query('INSERT INTO orgs(id, name) VALUES ($1,$2)', [`org-${randomUUID().slice(0, 8)}`, 'T']);
    orgId = r.rows[0].id as string;
    superToken = await signToken({ sub: 'admin', orgId, roles: ['super_admin'] });
  });
  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });

  test('401 without a token', async () => {
    expect((await app.request('/api/admin/kits')).status).toBe(401);
  });

  test('super_admin can list (empty) and create a category', async () => {
    const list = await app.request('/api/admin/kits', { headers: auth(superToken) });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    const res = await app.request('/api/admin/kits/categories', {
      method: 'POST', headers: { ...auth(superToken), ...CT },
      body: JSON.stringify({ name_zh: '工程', name_en: 'Engineering' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { category_id: string }).category_id).toBe('engineering');
  });

  test('create a kit via parse-zip + commit; duplicate slug -> 409', async () => {
    await app.request('/api/admin/kits/categories', {
      method: 'POST', headers: { ...auth(superToken), ...CT },
      body: JSON.stringify({ name_zh: '工程', name_en: 'Engineering' }),
    });
    // parse-zip stages the zip and returns a tempToken (NO slug — flat zip).
    const parse = await app.request('/api/admin/kits/parse-zip', {
      method: 'POST', headers: { ...auth(superToken), 'content-type': 'application/octet-stream' },
      body: zipBuf().toString('binary'),
    });
    const p = (await parse.json()) as { size: number; tempToken: string };
    expect(parse.status).toBe(200);
    // Each create consumes (and then deletes) its staged zip, so the duplicate
    // check only runs when we hand it a FRESHLY staged zip. Hence commit takes
    // its own tempToken.
    const commit = (tempToken: string, slug: string) => app.request('/api/admin/kits', {
      method: 'POST', headers: { ...auth(superToken), ...CT },
      body: JSON.stringify({ tempToken, slug, name_en: 'Engineering', name_zh: '工程', category_id: 'engineering', scope: { allCompany: true, deptIds: [], userIds: [] } }),
    });
    let res = await commit(p.tempToken, 'engineering');
    expect(res.status).toBe(200);
    expect(existsSync(join(kitStoreDir('engineering'), 'kit.zip'))).toBe(true);
    const list = await app.request('/api/admin/kits', { headers: auth(superToken) });
    expect((await list.json()) as unknown[]).toHaveLength(1);

    // A second create with the same slug, on a fresh staged zip -> 409 slug_conflict.
    const parse2 = await app.request('/api/admin/kits/parse-zip', {
      method: 'POST', headers: { ...auth(superToken), 'content-type': 'application/octet-stream' },
      body: zipBuf().toString('binary'),
    });
    const p2 = (await parse2.json()) as { tempToken: string };
    res = await commit(p2.tempToken, 'engineering');
    expect(res.status).toBe(409);
  });

  test('rejects a zip with no SKILL.md (400, not 413)', async () => {
    const z = new AdmZip(); z.addFile('only/readme.txt', Buffer.from('x'));
    const res = await app.request('/api/admin/kits/parse-zip', {
      method: 'POST', headers: { ...auth(superToken), 'content-type': 'application/octet-stream' },
      body: Buffer.from(z.toBuffer()).toString('binary'),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/kitCatalogAdmin.test.ts`
Expected: FAIL — `Cannot find module '../../src/routes/kitCatalogAdmin'`.

- [ ] **Step 3: Implement the routes**

Write `enterprise_server/src/routes/kitCatalogAdmin.ts` by mirroring `src/routes/skillMarketplaceAdmin.ts` line-for-line, substituting:
- Table `skill_marketplace_skills` → `kit_catalog`; key column `skill_id` → `slug`; the zip-derived `name` → the **caller-supplied `slug`** (add `slug` to the create zod schema; `parse-zip` returns `{ size, sha256, tempToken }` — **no** `name`).
- `parseSkillZip`/`SkillZipError` → `parseKitZip`/`KitZipError` (import from `../lib/kitZip`); `zipErrorStatus` maps `too_large` → 413, else 400.
- `skillStoreDir` → `kitStoreDir`; stored file `skill.zip` → `kit.zip`.
- `PP.Skill*` → `PP.Kit*`; `AuditAction.Skill*` → `AuditAction.Kit*`.
- `sanitizeScope` → `sanitizeKitScope` (import from `../models/kitCatalog`); the `source_json` author field → the plain `author` column; `categoryExists` targets `kit_categories`; `UNCATEGORIZED` → a local `const UNCATEGORIZED = 'uncategorized' as const` (or import from a shared module if one exists).
- Create route: read staged `kitStoreDir('__tmp_' + b.tempToken)/kit.zip`, `parseKitZip` it (400 on `KitZipError`), validate `category_id` via `categoryExists`, then `await kitCatalog.add(claims.orgId, { slug: b.slug, name_en: b.nameEn ?? null, name_zh: b.nameZh ?? null, description_en: b.descriptionEn ?? null, description_zh: b.descriptionZh ?? null, icon_url: b.icon ?? null, author: b.author ?? null, version: b.version ?? null, category_id: b.category_id, try_asking: b.tryAsking ?? [], skill_list: b.skillList ?? [], scope: b.scope, zip: { size: parsed.size, sha256: parsed.sha256, fileName: b.slug + '.zip' } }, claims.sub)` inside try/catch (on `e.message === 'kit_duplicate'` → `c.json({ error: 'slug_conflict' }, 409)`), then move the staged zip into `kitStoreDir(b.slug)/kit.zip`, and `auditStore.write(KitCreate)`.
- The PATCH param ordering, re-home-on-category-delete, and reserved-`uncategorized` guards carry over unchanged (targeting `kit_catalog` / `kit_categories`).
- The `GET /api/admin/kits` list maps each `KitRow` to the **`KitAdmin`** wire shape (defined in Task 8's `web/src/api/kitCatalog.ts`) so the SPA and this route agree field-for-field. Emit a local `mapAdminKit(row: KitRow)` returning:
```ts
{
  id: row.slug,
  name_en: row.name_en, name_zh: row.name_zh,
  description_en: row.description_en, description_zh: row.description_zh,
  icon: row.icon_url, author: row.author, version: row.version,
  category: row.category_id,
  tryAsking: row.try_asking,
  skillList: row.skill_list,
  scope: row.scope,
  scopeSummary: scopeSummary(row.scope),      // import scopeSummary from '../models/skillMarketplaceView' — returns 'all' | 'none' | 'depts:N[,users:M]'
  zip: { fileName: row.zip_file_name, fileSize: row.zip_file_size },
  enabled: row.enabled,
  isBuiltin: row.is_builtin,
  updatedAt: row.updated_at,
}
```
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/kitCatalogAdmin.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/kitCatalogAdmin.ts enterprise_server/tests/routes/kitCatalogAdmin.test.ts
git commit -m "feat(enterprise): add admin kit catalog routes with RBAC"
```

---

### Task 6: Public routes (`/api/kits` + `/api/kits/download/:slug`)

**Files:**
- Create: `enterprise_server/src/routes/kitCatalog.ts`
- Test: `enterprise_server/tests/routes/kitCatalogPublic.test.ts`

**Interfaces:**
- Consumes: `kitCatalog` + `KitRow` (Task 4), `descendantsOf`/`scopeApi` (`../auth/scopeResolver`), `kitStoreDir` (Task 1), `Role` (`../shared/enterpriseServerConstants`), `requireAuth`, `pool`.
- Produces: exported `kitCatalogRoutes: Hono`.

The public `GET /api/kits` returns `{ kits: [...] }` reshaped to the desktop `MarketplaceKit` contract, with `skills.bundle = '/api/kits/download/<slug>'` (a **relative** path — the desktop main process absolutizes it, so the renderer/IPC stay host-agnostic). Visibility is the same algorithm as `visibleSkill`.

- [ ] **Step 1: Write the failing route test**

`enterprise_server/tests/routes/kitCatalogPublic.test.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import '../../helpers/setupEnv';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { signToken } from '../../src/auth/jwt';
import { kitCatalogRoutes } from '../../src/routes/kitCatalog';
import { kitStoreDir } from '../../src/lib/stateDir';

const app = new Hono();
app.route('/', kitCatalogRoutes);

/** Insert a kit row directly (kit_catalog has no FK to users/departments). */
async function mkKit(slug: string, scope: object, enabled = true): Promise<void> {
  await testPool.query(
    `INSERT INTO kit_catalog (slug, org_id, name_en, name_zh, description_en, description_zh, scope, enabled, try_asking, skill_list)
     VALUES ($1, 'o1', $2, $2, 'D', 'D', $3, $4, '[]', '[]')`,
    [slug, JSON.stringify(scope), enabled],
  );
}

/** Minimal org + dept tree + users + memberships (mirror mcpMarketplaceScope.test.ts).
 *   rd -> /rd (parent); fe -> /rd/fe (child); sales -> /sales (sibling). */
async function seed(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1')`);
  await testPool.query(
    `INSERT INTO departments(id, org_id, name, parent_id, path) VALUES
       ('rd', 'o1', '研发', NULL, '/rd'),
       ('fe', 'o1', '前端', 'rd', '/rd/fe'),
       ('sales', 'o1', '销售', NULL, '/sales')`);
  await testPool.query(
    `INSERT INTO users(id, org_id, username, password_hash, display_name) VALUES
       ('u2', 'o1', 'u2', 'x', 'U2'),
       ('u3', 'o1', 'u3', 'x', 'U3'),
       ('admin', 'o1', 'admin', 'x', 'Admin')`);
  await testPool.query(
    `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES
       ('u2', 'fe', true),
       ('u3', 'sales', true)`);
  await mkKit('all', { allCompany: true, deptIds: [], userIds: [] });
  await mkKit('rdkit', { allCompany: false, deptIds: ['rd'], userIds: [] });     // granted to PARENT rd
  await mkKit('saleskit', { allCompany: false, deptIds: ['sales'], userIds: [] }); // sibling
  await mkKit('off', { allCompany: true, deptIds: [], userIds: [] }, false);   // disabled
}

const tok = (sub: string, roles: string[] = ['member']) => signToken({ sub, orgId: 'o1', roles });
async function list(sub: string, roles: string[] = ['member']): Promise<{ kits: Array<{ id: string }> }> {
  const res = await app.request('/api/kits', { headers: { authorization: `Bearer ${await tok(sub, roles)}` } });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ kits: Array<{ id: string }> }>;
}

describe('kitCatalogRoutes (scope-based)', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); await seed(); });

  test('returns 401 without a token', async () => {
    expect((await app.request('/api/kits')).status).toBe(401);
  });

  test('a member in fe (under rd) sees the all-company + subtree-granted kits, not the sibling or disabled', async () => {
    const ids = (await list('u2')).kits.map((k) => k.id).sort();
    expect(ids).toEqual(['all', 'rdkit']);   // not saleskit (sibling), not off (disabled)
  });

  test('a member in sales sees all + saleskit, NOT the rd-subtree kit', async () => {
    const ids = (await list('u3')).kits.map((k) => k.id).sort();
    expect(ids).toEqual(['all', 'saleskit']);
  });

  test('super_admin sees every ENABLED kit regardless of scope, never the disabled one', async () => {
    const ids = (await list('admin', ['super_admin'])).kits.map((k) => k.id).sort();
    expect(ids).toEqual(['all', 'rdkit', 'saleskit']);
  });

  test('an all-company kit is downloadable and the wire bundle path is relative', async () => {
    const dir = kitStoreDir('all');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'kit.zip'), 'ZIPBYTES');
    const dl = await app.request('/api/kits/download/all', { headers: { authorization: `Bearer ${await tok('u2')}` } });
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('ZIPBYTES');
    const body = (await (await app.request('/api/kits', { headers: { authorization: `Bearer ${await tok('u2')}` } })).json()) as
      { kits: Array<{ id: string; skills: { bundle: string } }> };
    expect(body.kits.find((k) => k.id === 'all')!.skills.bundle).toBe('/api/kits/download/all');
  });

  test('a dept-scoped kit is NOT downloadable by an out-of-scope member (404)', async () => {
    const dl = await app.request('/api/kits/download/saleskit', { headers: { authorization: `Bearer ${await tok('u2')}` } });
    expect(dl.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/kitCatalogPublic.test.ts`
Expected: FAIL — `Cannot find module '../../src/routes/kitCatalog'`.

- [ ] **Step 3: Implement the public routes**

Write `enterprise_server/src/routes/kitCatalog.ts` by mirroring `src/routes/skillMarketplace.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { descendantsOf, scopeApi } from '../auth/scopeResolver';
import { pool } from '../db/pool';
import { kitStoreDir } from '../lib/stateDir';
import type { KitRow } from '../models/kitCatalog';
import { Role } from '../shared/enterpriseServerConstants';

/** Reshape a DB row to the desktop MarketplaceKit wire shape. `skills.bundle`
 * is a RELATIVE path — the desktop main process absolutizes it against
 * ENTERPRISE_SERVER_URL before downloading (and installs authed). */
function mapPublicKit(row: KitRow) {
  return {
    id: row.slug,
    name: { en: row.name_en ?? '', zh: row.name_zh ?? '' },
    description: { en: row.description_en ?? '', zh: row.description_zh ?? '' },
    icon: row.icon_url ?? undefined,
    author: row.author ?? undefined,
    version: row.version ?? undefined,
    tryAsking: row.try_asking,
    skills: { bundle: `/api/kits/download/${row.slug}`, list: row.skill_list },
  };
}

/** Shared visibility re-check for download: the row must exist in the caller's
 * org, be enabled, and the caller be a super_admin, or the scope grant applies
 * (allCompany ∨ userIds ∋ sub ∨ caller depts ∩ descendantsOf(granted deptIds)).
 * Org only ever comes from the JWT. */
async function visibleKit(slug: string, orgId: string, sub: string, roles: string[]): Promise<KitRow | null> {
  const r = await pool.query<KitRow>(
    'SELECT * FROM kit_catalog WHERE slug = $1 AND org_id = $2 AND enabled = TRUE', [slug, orgId]);
  const row = r.rows[0];
  if (!row) return null;
  if (roles.includes(Role.SuperAdmin)) return row;
  if (row.scope?.allCompany) return row;
  if ((row.scope?.userIds ?? []).includes(sub)) return row;
  const callerDepts = await scopeApi.deptIdsFor(orgId, sub);
  const deptRows = await pool.query<{ id: string; path: string }>(
    `SELECT id, path FROM departments WHERE org_id = $1`, [orgId]);
  const deptPath = new Map(deptRows.rows.map((x) => [x.id, x.path]));
  const grantedSubtree = descendantsOf(row.scope?.deptIds ?? [], deptPath);
  return callerDepts.some((d) => grantedSubtree.has(d)) ? row : null;
}

export const kitCatalogRoutes = new Hono();
kitCatalogRoutes.use('/api/kits/*', requireAuth);

kitCatalogRoutes.get('/api/kits', async (c) => {
  const claims = c.get('claims');
  const orgId = claims.orgId;
  const isSuperAdmin = (claims.roles ?? []).includes(Role.SuperAdmin);
  const callerDepts = isSuperAdmin ? [] : await scopeApi.deptIdsFor(orgId, claims.sub);
  const callerSet = new Set(callerDepts);
  const deptRows = await pool.query<{ id: string; path: string }>(
    `SELECT id, path FROM departments WHERE org_id = $1`, [orgId]);
  const deptPath = new Map(deptRows.rows.map((r) => [r.id, r.path]));

  const r = await pool.query<KitRow>(
    `SELECT * FROM kit_catalog WHERE org_id = $1 AND enabled = TRUE ORDER BY updated_at DESC`, [orgId]);

  const visible = r.rows.filter((row) => {
    if (isSuperAdmin) return true;
    if (row.scope?.allCompany) return true;
    if ((row.scope?.userIds ?? []).includes(claims.sub)) return true;
    const grantedSubtree = descendantsOf(row.scope?.deptIds ?? [], deptPath);
    for (const d of callerSet) if (grantedSubtree.has(d)) return true;
    return false;
  });

  return c.json({ kits: visible.map(mapPublicKit) });
});

kitCatalogRoutes.get('/api/kits/download/:slug', async (c) => {
  const slug = c.req.param('slug');
  const claims = c.get('claims');

  const row = await visibleKit(slug, claims.orgId, claims.sub, claims.roles ?? []);
  if (!row) return c.json({ error: 'not_found' }, 404);

  const file = join(kitStoreDir(slug), 'kit.zip');
  let buf: Buffer<ArrayBuffer>;
  try {
    buf = await readFile(file);
  } catch {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.body(buf, 200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${slug}.zip"`,
  });
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/kitCatalogPublic.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add enterprise_server/src/routes/kitCatalog.ts enterprise_server/tests/routes/kitCatalogPublic.test.ts
git commit -m "feat(enterprise): add public scoped kit list and download routes"
```

---

### Task 7: Wire seed + routes into the server entry

**Files:**
- Modify: `enterprise_server/src/server.ts`

**Interfaces:**
- Consumes: `seedBuiltinKitsForAllOrgs` (Task 3), `kitCatalogRoutes` (Task 6), `kitCatalogAdminRoutes` (Task 5).

- [ ] **Step 1: Add imports**

In `enterprise_server/src/server.ts`, add to the import block:
```ts
import { seedBuiltinKitsForAllOrgs } from './org/builtinKits';
import { kitCatalogRoutes } from './routes/kitCatalog';
import { kitCatalogAdminRoutes } from './routes/kitCatalogAdmin';
```

- [ ] **Step 2: Wire the seed (after the provider seed) and the two routes**

In the startup block (next to `seedBuiltinProvidersForAllOrgs()`), add:
```ts
  await seedBuiltinKitsForAllOrgs();
```
In `buildApp()`, add the two route mounts alongside the skill ones (`/api/kits` and `/api/admin/kits` do not overlap other patterns):
```ts
  app.route('/', kitCatalogRoutes);
  app.route('/', kitCatalogAdminRoutes);
```

- [ ] **Step 3: Type-check the server**

Run: `cd enterprise_server && npx tsc --noEmit`
Expected: no **new** errors (pre-existing legacy errors, if any, must not increase — diff against a `git stash` baseline if unsure).

- [ ] **Step 4: Commit**

```bash
git add enterprise_server/src/server.ts
git commit -m "feat(enterprise): wire kit seed and routes into server startup"
```

---

### Task 8: SPA — permission mirror, api module, 套件管理 page

**Files:**
- Modify: `enterprise_server/web/src/shared/permissions.ts`
- Create: `enterprise_server/web/src/api/kitCatalog.ts`
- Create: `enterprise_server/web/src/pages/kitManage/` (page + components)
- Modify: `enterprise_server/web/src/i18n.ts` (nav key)
- Modify: `enterprise_server/web/src/App.tsx` (route)
- Modify: `enterprise_server/web/src/components/Sidebar.tsx` (nav item)

**Interfaces:**
- Consumes: `apiClient` (`web/src/api/client.ts` — `get/post/patch/put/delete/postRaw(path, BodyInit, headers)`), `useQuery`, `Switch`, `t`, `PermissionPoint.Kit*`; existing `SkillManagePage.tsx` + `pages/skillManage/*` as the mirror template.
- Produces: `kitCatalogApi`, `KitManagePage`, and the `/config/kits` route + nav.

- [ ] **Step 1: Mirror the permission points**

In `enterprise_server/web/src/shared/permissions.ts`, add to the `PermissionPoint` object (matching the server exactly):
```ts
  KitView: 'kit:view', KitCreate: 'kit:create', KitEdit: 'kit:edit', KitToggle: 'kit:toggle', KitDelete: 'kit:delete',
```
and the module array + `PERMISSION_MODULES` entry:
```ts
const kit = [PermissionPoint.KitView, PermissionPoint.KitCreate, PermissionPoint.KitEdit, PermissionPoint.KitToggle, PermissionPoint.KitDelete];
// in PERMISSION_MODULES:
{ key: 'kit', name: '套件管理', desc: '管理企业专家套件：新增、编辑、删除及启用/禁用与授权范围', points: kit },
```

- [ ] **Step 2: Create the api module**

`enterprise_server/web/src/api/kitCatalog.ts`, mirroring `web/src/api/skillMarketplace.ts` (fields adapted to the kit catalog):
```ts
import { apiClient } from './client';

export interface KitCategory { id: string; name_zh: string; name_en: string; display_order?: number; }
export interface KitScope { allCompany: boolean; deptIds: string[]; userIds: string[]; }
export interface KitAdmin {
  id: string; // == slug
  name_en: string | null; name_zh: string | null;
  description_en: string | null; description_zh: string | null;
  icon: string | null; author: string | null; version: string | null; category: string | null;
  tryAsking: Array<{ en: string; zh: string }>;
  skillList: Array<Record<string, unknown>>;
  scope: KitScope; scopeSummary: string;
  zip: { fileName: string | null; fileSize: number | null };
  enabled: boolean; isBuiltin: boolean;
  updatedAt: string;
}

export const kitCatalogApi = {
  listKits: () => apiClient.get<KitAdmin[]>('/api/admin/kits'),
  parseZip: (file: File) =>
    apiClient.postRaw<{ size: number; sha256: string; tempToken: string }>(
      '/api/admin/kits/parse-zip', file, { 'content-type': 'application/zip' }),
  createKit: (input: { tempToken: string; slug: string; nameEn?: string; nameZh?: string; descriptionEn?: string; descriptionZh?: string; icon?: string; author?: string; version?: string; category_id: string; tryAsking?: Array<{ en: string; zh: string }>; skillList?: Array<Record<string, unknown>>; scope: KitScope }) =>
    apiClient.post<{ slug: string }>('/api/admin/kits', input),
  updateKit: (slug: string, patch: { nameEn?: string; nameZh?: string; descriptionEn?: string; descriptionZh?: string; icon?: string; author?: string; version?: string; category_id?: string; scope?: KitScope; enabled?: boolean }) =>
    apiClient.patch<void>(`/api/admin/kits/${slug}`, patch),
  uploadZip: (slug: string, file: File) =>
    apiClient.postRaw<{ status: string }>(`/api/admin/kits/${slug}/zip`, file, { 'content-type': 'application/zip' }),
  deleteKit: (slug: string) => apiClient.delete<void>(`/api/admin/kits/${slug}`),
  listCategories: () => apiClient.get<KitCategory[]>('/api/admin/kits/categories'),
  createCategory: (input: { name_zh: string; name_en: string; display_order?: number }) =>
    apiClient.post<{ category_id: string }>('/api/admin/kits/categories', input),
  updateCategory: (id: string, input: { name_zh?: string; name_en?: string }) =>
    apiClient.put<void>(`/api/admin/kits/categories/${id}`, input),
  deleteCategory: (id: string) => apiClient.delete<void>(`/api/admin/kits/categories/${id}`),
};
```
**Wire-shape note:** the admin `list` (Task 5) must emit exactly these `KitAdmin` fields (`name_en`, `name_zh`, `description_*`, `icon`, `author`, `tryAsking`, `skillList`, `scope`, `scopeSummary`, `zip`, `enabled`, `isBuiltin`, `updatedAt`, `id = slug`). If a field name drifts between Task 5's `mapAdminKit` and this module, reconcile them here and there so the two agree.

- [ ] **Step 3: Add the nav i18n key**

In `enterprise_server/web/src/i18n.ts`, add next to `nav.skill` (en block ~line 148, zh block ~line 1258):
- en: `'nav.kit': 'Kit management',`
- zh: `'nav.kit': '套件管理',`

- [ ] **Step 4: Add the route**

In `enterprise_server/web/src/App.tsx`, import `KitManagePage` and add next to the `/config/skill` route:
```tsx
          <Route
            path="/config/kits"
            element={
              <AuthGuard requires="org_admin">
                <Shell><KitManagePage /></Shell>
              </AuthGuard>
            }
          />
```

- [ ] **Step 5: Add the nav item**

In `enterprise_server/web/src/components/Sidebar.tsx`, add next to the `to: '/config/skill'` entry (line ~37) and import a suitable icon (e.g. `Boxes` from `lucide-react`, the same library that provides `Sparkles`/`Bot`):
```tsx
  { to: '/config/kits', label: t('nav.kit'), icon: <Boxes />, section: 'config', requires: 'org_admin' },
```

- [ ] **Step 6: Build the page**

Create `enterprise_server/web/src/pages/kitManage/KitManagePage.tsx` (and `KitDrawer.tsx`, `KitScopeSelector.tsx` if the drawer grows) by mirroring `web/src/pages/SkillManagePage.tsx` + `pages/skillManage/*`, swapping the resource to kits via `kitCatalogApi`:
- `useQuery(['kits'], kitCatalogApi.listKits)` + `useQuery(['kitCategories'], kitCatalogApi.listCategories)`.
- Category sidebar + card grid: icon from `icon`, `name_zh`/`name_en`, `version`, an `官方`-style tag when `author` is set, description, skill count = `skillList.length`, `scopeSummary`, and an enable `Switch` that `kitCatalogApi.updateKit(slug, { enabled })`.
- Detail/authorize drawer: basic-info fields + a scope editor (reuse the `skillManage` dept-tree picker + member-exception list) + zip re-upload (`kitCatalogApi.uploadZip`).
- Create flow: two-stage — `kitCatalogApi.parseZip(file)` → capture `tempToken` → `kitCatalogApi.createKit({ tempToken, slug, nameEn, nameZh, descriptionEn, descriptionZh, icon, author, version, category_id, tryAsking, skillList, scope })`. The `slug` is a **required** form field (kit zips are flat, so it is not inferred from the upload).
- Gate create/edit/delete/enable actions on `PermissionPoint.Kit*` via `useAuth`.
- Drop the skill review-queue and org-settings pieces (kits have no member-submission flow).

- [ ] **Step 7: Build the SPA**

Run: `cd enterprise_server/web && npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add enterprise_server/web/src/shared/permissions.ts enterprise_server/web/src/api/kitCatalog.ts enterprise_server/web/src/pages/kitManage enterprise_server/web/src/i18n.ts enterprise_server/web/src/App.tsx enterprise_server/web/src/components/Sidebar.tsx
git commit -m "feat(enterprise-spa): add 套件管理 admin page and API module"
```

---

### Task 9: Desktop enterprise client — kit list + authed download

**Files:**
- Modify: `src/main/auth/enterpriseClient.ts`

**Interfaces:**
- Consumes: module-internal `baseUrl` + `tokenProvider` (direct `fetch`, matching the sibling `listEnterprise*` methods) and `loginGate` (already imported at the top of the file).
- Produces: `enterpriseClient.listEnterpriseKits(): Promise<{ kits: EnterpriseKit[] }>`, `enterpriseClient.downloadEnterpriseKit(path: string): Promise<Buffer>`, and `interface EnterpriseKit`.

- [ ] **Step 1: Add `listEnterpriseKits` + `downloadEnterpriseKit` + `EnterpriseKit`**

In `src/main/auth/enterpriseClient.ts`, add the interface (near the other `Enterprise*` interfaces) and two methods to the `enterpriseClient` object (mirroring `listEnterpriseMcps` — direct `fetch`, explicit inline return type; `downloadEnterpriseKit` is the first **binary** method, so it reads `arrayBuffer` instead of `json`):
```ts
export interface EnterpriseKit {
  id: string;
  name: { en: string; zh: string };
  description: { en: string; zh: string };
  icon?: string;
  author?: string;
  version?: string;
  tryAsking?: Array<{ en: string; zh: string }>;
  skills: { bundle: string; list: Array<Record<string, unknown>> };
}
```
Inside the object (e.g. after `listEnterpriseAgents`):
```ts
  /**
   * List the enterprise kit catalog scoped to the caller's role/scope.
   * Mirrors `listEnterpriseMcps`: direct fetch with the org JWT. The server
   * returns a relative `skills.bundle` path (`/api/kits/download/<slug>`); the
   * desktop main process absolutizes + installs it authed (kits:install).
   */
  async listEnterpriseKits(): Promise<{ kits: EnterpriseKit[] }> {
    const url = `${baseUrl}/api/kits`;
    const token = tokenProvider();
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    if (token) headers.set('authorization', `Bearer ${token}`);
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      throw new Error(`network: ${(e as Error).message}`);
    }
    if (res.status === 401) {
      loginGate.lock();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      throw new Error(`enterprise-kit-marketplace fetch failed: HTTP ${res.status}`);
    }
    return res.json() as Promise<{ kits: EnterpriseKit[] }>;
  },

  /**
   * Download an enterprise kit's zip with the org JWT (binary). `path` is the
   * relative server path, e.g. `/api/kits/download/engineering`. Returns the raw
   * bytes so kits:install can write them to a temp file.
   */
  async downloadEnterpriseKit(path: string): Promise<Buffer> {
    const url = `${baseUrl}${path}`;
    const token = tokenProvider();
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      throw new Error(`network: ${(e as Error).message}`);
    }
    if (res.status === 401) {
      loginGate.lock();
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error(`http ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
```

- [ ] **Step 2: Lint**

Run: `cd /Users/paulwang/work/GenWork && npx eslint --ext ts --max-warnings 0 src/main/auth/enterpriseClient.ts`
Expected: no errors/warnings.

- [ ] **Step 3: Commit**

```bash
git add src/main/auth/enterpriseClient.ts
git commit -m "feat(desktop): add enterprise kit list + authed download client"
```

---

### Task 10: Desktop kit IPC — enterprise fetch + authed install download

**Files:**
- Modify: `src/main/ipcHandlers/kits/handlers.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/electron.d.ts`

**Interfaces:**
- Consumes: `enterpriseClient.listEnterpriseKits` / `downloadEnterpriseKit` (Task 9), `loginGate.requireEnterprise()` (`../../auth/loginGate`), `getEnterpriseServerUrl()` (`../../libs/endpoints`), the existing `downloadBuffer` (kept for non-enterprise bundles).
- Produces: IPC channel `kits:fetchEnterpriseStore` (preload `kits.fetchEnterpriseStore()`), and an authed install path for enterprise bundles.

- [ ] **Step 1: Add the `kits:fetchEnterpriseStore` handler**

In `src/main/ipcHandlers/kits/handlers.ts`, add imports (matching how `mcp/handlers.ts` imports them):
```ts
import { enterpriseClient } from '../../auth/enterpriseClient';
import { loginGate } from '../../auth/loginGate';
import { getEnterpriseServerUrl } from '../../libs/endpoints';
```
Then inside `registerKitHandlers(...)`, add (mirroring `mcp/handlers.ts`'s `FetchEnterpriseMarketplace`); `data` is the **array** of kits with the relative `bundle` absolutized so `kits:install` can recognize + auth-download enterprise bundles:
```ts
  ipcMain.handle('kits:fetchEnterpriseStore', async () => {
    try {
      loginGate.requireEnterprise();
      const { kits } = await enterpriseClient.listEnterpriseKits();
      const base = getEnterpriseServerUrl();
      const data = kits.map((kit) => ({
        ...kit,
        skills: { ...kit.skills, bundle: `${base}/api/kits/download/${kit.id}` },
      }));
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch enterprise kits',
      };
    }
  });
```
(Note: unlike `kits:fetchStore` — which returns `data` as a JSON **string** — this returns `data` as a parsed array. The renderer task accounts for that.)

- [ ] **Step 2: Make the install download authed for enterprise bundles**

In the `kits:install` handler, replace the generic `const buffer = await downloadBuffer(bundleUrl);` (line ~294) with a branch that uses the authed client only for enterprise bundles (the computer-use / skin-pack intercepts above it stay unchanged):
```ts
      let buffer: Buffer;
      const entBase = (() => { try { return getEnterpriseServerUrl(); } catch { return ''; } })();
      const isEnterpriseBundle = entBase !== '' && bundleUrl.startsWith(`${entBase}/api/kits/download/`);
      buffer = isEnterpriseBundle
        ? await enterpriseClient.downloadEnterpriseKit(bundleUrl.slice(entBase.length))
        : await downloadBuffer(bundleUrl);
```
All downstream use of `buffer` (the computer-use size/sha checks, temp-file write) is unchanged.

- [ ] **Step 3: Expose the new channel in preload + types**

In `src/main/preload.ts`, inside the `kits` block (near `fetchStore` at line ~201), add:
```ts
    fetchEnterpriseStore: () => ipcRenderer.invoke('kits:fetchEnterpriseStore'),
```
In `src/renderer/types/electron.d.ts`, inside the `kits` interface (near `fetchStore` at line ~662), add:
```ts
    fetchEnterpriseStore: () => Promise<{ success: boolean; data?: unknown; error?: string }>;
```

- [ ] **Step 4: Compile Electron + lint**

Run: `cd /Users/paulwang/work/GenWork && npm run compile:electron && npx eslint --ext ts --max-warnings 0 src/main/ipcHandlers/kits/handlers.ts src/main/preload.ts src/renderer/types/electron.d.ts`
Expected: compile succeeds, no lint issues.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipcHandlers/kits/handlers.ts src/main/preload.ts src/renderer/types/electron.d.ts
git commit -m "feat(desktop): fetch enterprise kits and authed kit download"
```

---

### Task 11: Desktop renderer — 企业 / 内置 / 已安装 tabs + i18n

**Files:**
- Modify: `src/renderer/services/kit.ts`
- Modify: `src/renderer/services/i18n.ts`
- Modify: `src/renderer/components/kits/KitsManager.tsx`

**Interfaces:**
- Consumes: `window.electron.kits.fetchEnterpriseStore()` (Task 10), existing `kitService.fetchMarketplaceKits()` (the built-in/local source — the offline `kits:fetchStore` response: GenWork 外观定制 + computer-use), i18n keys.
- Produces: `kitService.fetchEnterpriseKits(): Promise<MarketplaceKit[]>` and the 3-tab UI.

- [ ] **Step 1: Add `fetchEnterpriseKits` to the kit service**

In `src/renderer/services/kit.ts`, add a cache field + method. **Important data-shape difference from `fetchMarketplaceKits`:** the enterprise IPC returns `data` as an **array** of kits (Task 10), whereas the built-in `kits:fetchStore` returns `data` as a JSON **string** that `loadMarketplaceKits` parses as `JSON.parse(result.data).data.value.kits`. So read the array directly:
```ts
  private enterpriseCache: MarketplaceKit[] | null = null;

  async fetchEnterpriseKits(): Promise<MarketplaceKit[]> {
    if (this.enterpriseCache) return this.enterpriseCache;
    try {
      const result = await window.electron.kits.fetchEnterpriseStore();
      if (!result.success || !result.data) {
        // Not enterprise-logged-in (or fetch failed): the 企业 tab shows its
        // "connect to enterprise" empty state; 内置 still works.
        console.warn('[KitService] Failed to fetch enterprise kits:', result.error);
        return [];
      }
      const kits = result.data as MarketplaceKit[];
      this.enterpriseCache = kits;
      return kits;
    } catch (error) {
      console.error('[KitService] Error loading enterprise kits:', error);
      return [];
    }
  }
```
and add `this.enterpriseCache = null;` to `clearCache()`.

- [ ] **Step 2: Add i18n keys**

In `src/renderer/services/i18n.ts`, zh block (near `kitMarketplace` line ~2257):
- Change `kitMarketplace: '市场'` → `kitMarketplace: '企业'`.
- Add `kitBuiltInTab: '内置'` and `kitEnterpriseEmpty: '连接企业后可用'`.
- Reword `kitInstalledEmpty: '暂未安装套件，去市场逛逛吧'` (line ~2273) → `kitInstalledEmpty: '暂未安装套件，去企业或内置逛逛吧'`.
In the en block (near line ~6080):
- Change `kitMarketplace: 'Marketplace'` → `kitMarketplace: 'Enterprise'`.
- Add `kitBuiltInTab: 'Built-in'` and `kitEnterpriseEmpty: 'Available once connected to your enterprise'`.
- Reword `kitInstalledEmpty` (line ~6096) → `'No kits installed yet. Explore Enterprise or Built-in to get started.'`

- [ ] **Step 3: Restructure `KitsManager.tsx` to three tabs**

In `src/renderer/components/kits/KitsManager.tsx`:
1. Extend the tab enum (lines 33-36) — add `BuiltIn`:
```ts
const KitTab = {
  Marketplace: 'marketplace',
  BuiltIn: 'built_in',
  Installed: 'installed',
} as const;
```
2. Add two lists in state (after the existing single `kits` state, ~line 167):
```ts
  const [enterpriseKits, setEnterpriseKits] = useState<MarketplaceKit[]>([]);
  const [builtInKits, setBuiltInKits] = useState<MarketplaceKit[]>([]);
```
3. Rewrite `loadData` (lines 179-194) to fetch all three sources in parallel; the combined list feeds `kits` (so `installedCount` and all detail/uninstall logic keep working):
```ts
  const loadData = useCallback(async () => {
    setIsLoading(true);
    const [ent, built, installed] = await Promise.all([
      kitService.fetchEnterpriseKits(),
      kitService.fetchMarketplaceKits(), // built-in/local source (外观定制 + computer-use)
      kitService.getInstalledKits(),
    ]);
    setEnterpriseKits(ent);
    setBuiltInKits(built);
    const combined = [...ent, ...built];
    setKits(combined);
    setInstalledKits(installed);
    dispatch(setMarketplaceKits(combined));
    dispatch(setInstalledKitsAction(installed));
    setIsLoading(false);
  }, [dispatch]);
```
4. In `filteredKits` (lines 201-217), pick the base list by active tab (the existing search filter below it is unchanged):
```ts
  const filteredKits = useMemo(() => {
    const base = activeTab === KitTab.BuiltIn
      ? builtInKits
      : activeTab === KitTab.Marketplace
        ? enterpriseKits
        : kits;
    let results = base;
    if (activeTab === KitTab.Installed) {
      results = results.filter((kit) => !!installedKits[kit.id]);
    }
    if (searchQuery.trim()) {
      /* ...unchanged search filter operating on `results`... */
    }
    return results;
  }, [kits, enterpriseKits, builtInKits, installedKits, activeTab, searchQuery]);
```
5. Add a middle 内置 tab button between the 企业 and 已安装 buttons (lines 741-768), reusing the same styling, `onClick={() => handleTabChange(KitTab.BuiltIn)}`, active styling `activeTab === KitTab.BuiltIn`, label `i18nService.t('kitBuiltInTab')`.
6. Empty-state (lines 789-822): choose the empty message by tab — `kitEnterpriseEmpty` for `KitTab.Marketplace`, `kitEmpty` for `KitTab.BuiltIn`, `kitInstalledEmpty` for `KitTab.Installed`.

- [ ] **Step 4: Run kit tests + lint**

Run: `cd /Users/paulwang/work/GenWork && npm test -- kits && npx eslint --ext ts,tsx --max-warnings 0 src/renderer/components/kits/KitsManager.tsx src/renderer/services/kit.ts src/renderer/services/i18n.ts`
Expected: existing kit tests pass (the built-in path is preserved, so `skinPackKitLifecycle.test.ts` is unaffected); no lint issues.

- [ ] **Step 5: Manual verification**

Run `npm run electron:dev`. In 专家套件:
- Tab labels read **企业 | 内置 | 已安装**.
- 企业 lists the org's authorized kits (the 12 all-company built-ins) from the enterprise server.
- 内置 still shows GenWork 外观定制 (and computer-use on Windows).
- Installing an 企业 kit downloads via the authed path and appears in 已安装.
- A non-enterprise (consumer) session shows the 企业 tab empty with `kitEnterpriseEmpty` while 内置 still works.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/services/kit.ts src/renderer/services/i18n.ts src/renderer/components/kits/KitsManager.tsx
git commit -m "feat(desktop): enterprise + built-in kit tabs"
```

---

## Verification summary

- **Server:** per-file vitest — `tests/db/040_kit_catalog.test.ts`, `tests/shared/permissionPoints.test.ts`, `tests/lib/kitZip.test.ts`, `tests/org/builtinKits.test.ts`, `tests/models/kitCatalog.test.ts`, `tests/routes/kitCatalogAdmin.test.ts`, `tests/routes/kitCatalogPublic.test.ts`; `npx tsc --noEmit`; `npm run build` in `web/`.
- **Desktop:** `npm test -- kits`, `npm run compile:electron`, `npx eslint --max-warnings 0` on touched TS/TSX, and manual `electron:dev` validation of the three-tab flow + authed install.
- **Review Focus coverage:** unauthorized download 404 (Task 6), dept-subtree visibility parent→descendant vs sibling (Task 6), missing/corrupt seed tolerance + idempotent reseed (Task 3), no-`SKILL.md`/bad-slug/duplicate-slug rejection (Task 2 + Task 5), consumer-mode 企业 empty state while 内置 works (Task 11 manual).
