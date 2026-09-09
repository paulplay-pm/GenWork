# Enterprise Release Installers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enterprise admins upload real installer binaries (macOS Apple Silicon `.dmg`, Windows x64 `.exe`) instead of pasting external URLs; the enterprise server stores and serves them (resumable, JWT-gated), and desktop clients download from the server (resumably) and self-install.

**Architecture:** Replace the `app_releases.downloads` (external-URL JSONB) column with `app_releases.installers` (per-platform `{id, fileName, fileSize, sha256}` pointing at server-side files). Add chunked-resumable upload endpoints, a Range-capable JWT download endpoint, and rewrite `/updates/latest` to emit server-relative installer URLs. On the desktop, add `Authorization` + HTTP Range resume to `downloadUpdate`. The admin web swaps three URL text fields for two resumable uploader controls.

**Tech Stack:** Node 24 + TypeScript. `enterprise_server`: Hono, pglite (tests), Zod, `node:fs`/`node:stream`/`node:crypto`. Desktop: Electron main (`session.defaultSession.fetch`), Vitest. Admin web: React + TanStack Query, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-08-enterprise-release-installers-design.md`

## Global Constraints

- Root repo Node `>=24.15.0 <25`. `enterprise_server` is a separate package (own `node_modules`); its tests run **per-file** (`npx vitest run tests/<file>.test.ts`), never the full suite (fd/EBADF limit in sandbox).
- New migration file is `041_*.sql` (current max is `040_kit_catalog.sql`). Migrations are idempotent (`IF NOT EXISTS` / `IF NOT EXISTS`), run in filename order via a `_migrations` ledger.
- **No `Co-Authored-By` trailer** in commits (root AGENTS.md). Conventional Commits, English, e.g. `feat(enterprise): ...`, `feat(desktop): ...`.
- Every touched TS/TSX file must pass `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>` before hand-off.
- i18n: every user-visible string gets **both `zh` and `en`**. Server/admin web keys live in `enterprise_server/web/src/i18n.ts` (`page.versions.*`). Desktop already has `update*` keys; no new desktop UI strings needed.
- No macOS Intel build anywhere (no `macIntel` in `installers`, no Intel upload target).
- Download/installer URLs must end in `.dmg` (macOS) / `.exe` (Windows) — the desktop's Windows URL policy and `pickPlatformUrl` extension checks depend on the extension.
- Desktop tests: colocated `.test.ts` under `src/main/libs/`. Do **not** import `electron-log` in tests; the installer test already mocks `electron` + `child_process`.
- Scope changes tightly. No opportunistic refactors. The `node:http` wrapper change is gated narrowly (see Task 3).

## Review Focus

Five input/failure classes the spec implies but which are easy to get subtly wrong. Each has a pinning test added to the owning task.

1. **Cross-org installer download** — an org-A client requesting org-B's `fileId` must get `403`, never the file. *(Task 3, download route)*
2. **Resume corrupting the installer** — a `206` resume must append to the existing partial and validate the *final full-file* size + sha256; a `200` (Range ignored) must truncate and start fresh. A partial from a *different URL/version* must not be resumed. *(Task 4, `downloadUpdate`)*
3. **Missing/expired JWT on download** — `401` (not `200`, not `404`) so a bad token is indistinguishable from a bad file. *(Task 3, download route)*
4. **Dangling platform URL in the check response** — `/updates/latest` emits a platform key **only** when that platform's installer exists; a release with only `windowsX64` must omit `macArm` so Intel/other clients safely see "no update". *(Task 1, updates route + test)*
5. **Upload integrity/ordering** — out-of-order chunk (`index > totalAccepted`) → `400 bad_order`; a `complete` whose assembled size ≠ declared `expectedSize` → `400 size_mismatch`. *(Task 2, upload route)*

## File Structure

**Server (`enterprise_server/`):**
- `src/db/migrations/041_app_release_installers.sql` — drop `downloads`, add `installers`.
- `src/models/appRelease.ts` — `installers` types + methods; new `getInstallerMeta(fileId)`.
- `src/lib/stateDir.ts` — `releaseInstallerDir()`, `releaseInstallerFile(fileId, ext)`, `releaseInstallerUploadDir(uploadId)`.
- `src/routes/releaseInstallerUploads.ts` — new: `init` / `chunks/:index` / `complete`.
- `src/routes/releaseDownloads.ts` — new: Range-capable JWT download.
- `src/routes/updates.ts` — rewrite to map `installers` → URLs.
- `src/routes/admin/releases.ts` — create/patch accept `installers`; `set-latest` guards `no_installer`.
- `src/server.ts` — register new routes; stream `accept-ranges` responses.

**Desktop (`src/`):**
- `src/main/libs/appUpdateInstaller.ts` — `buildDownloadPaths()`; `downloadUpdate` auth + Range resume.
- `src/main/libs/appUpdateCoordinator.ts` — pass JWT to `downloadUpdate`.

**Admin web (`enterprise_server/web/`):**
- `src/i18n.ts` — `page.versions.*` installer keys (en + zh).
- `src/api/releases.ts` — `installers` types.
- `src/api/releaseInstallers.ts` — new: chunked-resumable upload client.
- `src/pages/VersionsPage.tsx` — two uploader controls replace three URL fields.

**Tests:**
- `enterprise_server/tests/models/appRelease.test.ts` (modify)
- `enterprise_server/tests/routes/adminReleases.test.ts` (modify)
- `enterprise_server/tests/routes/updates.test.ts` (modify)
- `enterprise_server/tests/routes/releaseInstallerUploads.test.ts` (new)
- `enterprise_server/tests/routes/releaseDownloads.test.ts` (new)
- `src/main/libs/appUpdateInstaller.test.ts` (modify)
- `enterprise_server/web/tests/api/releases.test.ts` (modify)
- `enterprise_server/web/tests/api/releaseInstallers.test.ts` (new)
- `enterprise_server/web/tests/pages/VersionsPage.test.tsx` (modify)

---

## Task 1: Server data layer — replace `downloads` with `installers`

This is the foundational change: the migration, the model, the admin route schema, and the `/updates/latest` rewrite, plus updates to the three server test files that still reference `downloads`. After this task the server compiles and its tests pass, with `installers` metadata flowing through (files aren't uploaded yet — that's Task 2).

**Files:**
- Create: `enterprise_server/src/db/migrations/041_app_release_installers.sql`
- Modify: `enterprise_server/src/models/appRelease.ts`
- Modify: `enterprise_server/src/routes/admin/releases.ts`
- Modify: `enterprise_server/src/routes/updates.ts`
- Modify: `enterprise_server/tests/models/appRelease.test.ts`
- Modify: `enterprise_server/tests/routes/adminReleases.test.ts`
- Modify: `enterprise_server/tests/routes/updates.test.ts`

**Interfaces:**
- Produces: `appRelease.add(orgId, { version, published_at?, change_log, installers })`, `appRelease.update(id, { change_log?, installers?, enabled? })`, `appRelease.getInstallerMeta(fileId): Promise<{ orgId, fileName, fileSize, sha256 } | null>`, `ReleaseInstaller`, `ReleaseInstallers` (exported). `installers` shape: `{ macArm?: ReleaseInstaller; windowsX64?: ReleaseInstaller }` where `ReleaseInstaller = { id: string; fileName: string; fileSize: number; sha256: string }`.
- Consumes: `app_releases` table with `installers` JSONB column.

- [ ] **Step 1: Write the failing migration + updated model tests**

Create `enterprise_server/src/db/migrations/041_app_release_installers.sql`:

```sql
-- Migration 041: replace external-URL downloads with server-side installers.
-- Admins now upload installer binaries to the enterprise server; the
-- `downloads` column (pasted external URLs) is removed and replaced by
-- `installers`, which stores per-platform metadata (no macOS Intel).
--
-- Backward-compat note: rows created before this migration keep
-- `installers = '{}'` (default), so previously-published versions have no
-- installer until re-uploaded; /updates/latest then omits their platform URLs
-- and clients treat them as "no update" (safe).

ALTER TABLE app_releases DROP COLUMN IF EXISTS downloads;
ALTER TABLE app_releases ADD COLUMN IF NOT EXISTS installers JSONB NOT NULL DEFAULT '{}'::jsonb;
```

Replace the entire contents of `enterprise_server/tests/models/appRelease.test.ts` with:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { appRelease, type ReleaseInstallers } from '../../src/models/appRelease';

async function seedOrg(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
}

const installers: ReleaseInstallers = {
  macArm: { id: 'file-mac', fileName: 'GenWork.dmg', fileSize: 10, sha256: 'mac-sha' },
  windowsX64: { id: 'file-win', fileName: 'GenWork.exe', fileSize: 20, sha256: 'win-sha' },
};

async function makeRelease(
  version: string,
  opts: { isLatest?: boolean; enabled?: boolean; installers?: ReleaseInstallers } = {},
): Promise<string> {
  const { id } = await appRelease.add('o1', {
    version,
    change_log: { zh: { title: `t-zh ${version}`, content: ['c-zh'] }, en: { title: `t-en ${version}`, content: ['c-en'] } },
    installers: opts.installers ?? installers,
  });
  if (opts.enabled === false) await appRelease.update(id, { enabled: false });
  if (opts.isLatest === true) await appRelease.setLatest(id);
  return id;
}

describe('models/appRelease (installers)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await seedOrg();
  });

  test('add stores installers and listForAdmin returns them', async () => {
    await makeRelease('1.0.0');
    const list = await appRelease.listForAdmin('o1');
    expect(list[0].installers).toEqual(installers);
    expect(list[0]).not.toHaveProperty('downloads');
  });

  test('add rejects duplicate (orgId, version)', async () => {
    await makeRelease('1.0.0');
    await expect(makeRelease('1.0.0')).rejects.toThrow(/duplicate|unique|conflict/i);
  });

  test('update replaces installers', async () => {
    const id = await makeRelease('1.0.0');
    await appRelease.update(id, { installers: { windowsX64: { id: 'w', fileName: 'a.exe', fileSize: 5, sha256: 's' } } });
    const list = await appRelease.listForAdmin('o1');
    expect(list[0].installers).toEqual({ windowsX64: { id: 'w', fileName: 'a.exe', fileSize: 5, sha256: 's' } });
  });

  test('getLatestEnabled is org-scoped', async () => {
    await makeRelease('1.0.0', { isLatest: true });
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','O2')`);
    expect(await appRelease.getLatestEnabled('o2')).toBeNull();
  });

  test('setLatest rejects a release with no installer (no_installer)', async () => {
    const id = await appRelease.add('o1', { version: '1.0.0', change_log: {}, installers: {} });
    await expect(appRelease.setLatest(id)).rejects.toThrow('no_installer');
  });

  test('getInstallerMeta resolves a fileId to owner + metadata', async () => {
    await makeRelease('1.0.0');
    const meta = await appRelease.getInstallerMeta('file-win');
    expect(meta).toEqual({ orgId: 'o1', fileName: 'GenWork.exe', fileSize: 20, sha256: 'win-sha' });
    expect(await appRelease.getInstallerMeta('missing')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the model tests to verify they fail**

Run: `cd enterprise_server && npx vitest run tests/models/appRelease.test.ts`
Expected: FAIL — `installers` not stored / `getInstallerMeta` not a function / `add` still writes `downloads` (which no longer exists → SQL error).

- [ ] **Step 3: Rewrite `appRelease.ts` for `installers`**

Replace the entire contents of `enterprise_server/src/models/appRelease.ts` with:

```ts
import { pool } from '../db/pool';

export interface ReleaseChangelog {
  zh?: { title: string; content: string[] };
  en?: { title: string; content: string[] };
}

export interface ReleaseInstaller {
  id: string;
  fileName: string;
  fileSize: number;
  sha256: string;
}

export interface ReleaseInstallers {
  macArm?: ReleaseInstaller;
  windowsX64?: ReleaseInstaller;
}

export interface ReleaseView {
  id: string;
  version: string;
  published_at: string;
  change_log: ReleaseChangelog;
  installers: ReleaseInstallers;
  enabled: boolean;
  is_latest: boolean;
}

const SELECT_COLS = `id, version, published_at, change_log, installers, enabled, is_latest`;

export const appRelease = {
  async listForAdmin(orgId: string): Promise<ReleaseView[]> {
    const r = await pool.query<ReleaseView>(
      `SELECT ${SELECT_COLS} FROM app_releases
       WHERE org_id = $1
       ORDER BY published_at DESC, created_at DESC`,
      [orgId],
    );
    return r.rows;
  },

  async getLatestEnabled(orgId: string): Promise<ReleaseView | null> {
    const r = await pool.query<ReleaseView>(
      `SELECT ${SELECT_COLS} FROM app_releases
       WHERE org_id = $1 AND is_latest = true AND enabled = true
       LIMIT 1`,
      [orgId],
    );
    return r.rowCount === 0 ? null : r.rows[0];
  },

  async add(
    orgId: string,
    input: {
      version: string;
      published_at?: string;
      change_log: ReleaseChangelog;
      installers: ReleaseInstallers;
    },
  ): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO app_releases
         (id, org_id, version, published_at, change_log, installers)
       VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6)`,
      [
        id,
        orgId,
        input.version,
        input.published_at ?? null,
        JSON.stringify(input.change_log ?? {}),
        JSON.stringify(input.installers ?? {}),
      ],
    );
    return { id };
  },

  async update(
    id: string,
    patch: {
      change_log?: ReleaseChangelog;
      installers?: ReleaseInstallers;
      enabled?: boolean;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.change_log !== undefined) {
      sets.push(`change_log = $${i++}`);
      vals.push(JSON.stringify(patch.change_log));
    }
    if (patch.installers !== undefined) {
      sets.push(`installers = $${i++}`);
      vals.push(JSON.stringify(patch.installers));
    }
    if (patch.enabled !== undefined) {
      sets.push(`enabled = $${i++}`);
      vals.push(patch.enabled);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await pool.query(`UPDATE app_releases SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  },

  async setLatest(id: string): Promise<void> {
    await pool.query('BEGIN');
    try {
      const r = await pool.query<{ org_id: string; enabled: boolean; installers: ReleaseInstallers }>(
        `SELECT org_id, enabled, installers FROM app_releases WHERE id = $1`,
        [id],
      );
      if (r.rowCount === 0) throw new Error('not_found');
      const row = r.rows[0];
      if (!row.enabled) throw new Error('disabled');
      const hasInstaller = !!(row.installers.macArm || row.installers.windowsX64);
      if (!hasInstaller) throw new Error('no_installer');
      await pool.query(`UPDATE app_releases SET is_latest = false WHERE org_id = $1`, [row.org_id]);
      await pool.query(`UPDATE app_releases SET is_latest = true WHERE id = $1`, [id]);
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
  },

  /**
   * Resolve an installer fileId (the on-disk file name stem) to the release
   * that owns it, returning the owner org + file metadata. Null if no release
   * references the fileId. Used by the download route for the cross-org guard.
   */
  async getInstallerMeta(
    fileId: string,
  ): Promise<{ orgId: string; fileName: string; fileSize: number; sha256: string } | null> {
    const r = await pool.query<{ org_id: string; installers: ReleaseInstallers }>(
      `SELECT org_id, installers FROM app_releases
       WHERE installers->'macArm'->>'id' = $1
          OR installers->'windowsX64'->>'id' = $1
       LIMIT 1`,
      [fileId],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    // Both platforms can be present on a release; pick the one that actually
    // owns this fileId, not just the first present platform.
    const meta =
      row.installers.macArm?.id === fileId
        ? row.installers.macArm
        : row.installers.windowsX64?.id === fileId
          ? row.installers.windowsX64
          : null;
    if (!meta) return null;
    return { orgId: row.org_id, fileName: meta.fileName, fileSize: meta.fileSize, sha256: meta.sha256 };
  },

  async remove(id: string): Promise<void> {
    await pool.query(`DELETE FROM app_releases WHERE id = $1`, [id]);
  },
};
```

- [ ] **Step 4: Run the model tests to verify they pass**

Run: `cd enterprise_server && npx vitest run tests/models/appRelease.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Update the admin route to accept `installers` and guard `set-latest`**

In `enterprise_server/src/routes/admin/releases.ts`:

Replace the imports (top) — change the `appRelease` import line to also bring the type, and drop the now-unused `httpUrl`/`downloadsSchema`. Find:

```ts
import { appRelease, type ReleaseChangelog, type ReleaseDownloads } from '../../models/appRelease';
```
Replace with:
```ts
import { appRelease, type ReleaseChangelog, type ReleaseInstallers } from '../../models/appRelease';
```

Delete these two schema blocks (the `httpUrl` const and the `downloadsSchema` const):

```ts
const httpUrl = z
  .string()
  .min(1)
  .refine((v) => /^https?:\/\/\S+/.test(v), { message: 'invalid url' });

const changeLogSchema = z
```
Replace the leading `const httpUrl = z ... const changeLogSchema = z` region so only `changeLogSchema` remains (i.e. remove `httpUrl` and `downloadsSchema`). Concretely, delete:
- the whole `const httpUrl = z.string()...` block, and
- the whole `const downloadsSchema = z.object({ macIntel... }).default({});` block.

After the `changeLogSchema` block, add the installer schema:

```ts
const installerSchema = z.object({
  id: z.string().min(1),
  fileName: z.string().min(1),
  fileSize: z.number().int().positive(),
  sha256: z.string().min(1),
});

const installersSchema = z
  .object({
    macArm: installerSchema.optional(),
    windowsX64: installerSchema.optional(),
  })
  .default({});
```

In `createSchema`, replace `downloads: downloadsSchema,` with `installers: installersSchema,`.
In `patchSchema`, replace `downloads: downloadsSchema.optional(),` with `installers: installersSchema.optional(),`.

In the `POST /admin/releases` handler, replace:
```ts
      downloads: body.downloads as ReleaseDownloads,
```
with:
```ts
      installers: body.installers as ReleaseInstallers,
```

In the `PATCH /admin/releases/:id` handler, replace:
```ts
    downloads: body.downloads as ReleaseDownloads | undefined,
```
with:
```ts
    installers: body.installers as ReleaseInstallers | undefined,
```

In the `set-latest` handler, add the `no_installer` case. Find:
```ts
    if (msg === 'not_found') return httpError(404, 'not_found');
    if (msg === 'disabled') return httpError(422, 'release_disabled');
    return httpError(500, msg);
```
Replace with:
```ts
    if (msg === 'not_found') return httpError(404, 'not_found');
    if (msg === 'disabled') return httpError(422, 'release_disabled');
    if (msg === 'no_installer') return httpError(422, 'no_installer');
    return httpError(500, msg);
```

- [ ] **Step 6: Update `adminReleases.test.ts` fixtures**

`enterprise_server/tests/routes/adminReleases.test.ts` has **6** test bodies, each with a line that starts (after its leading whitespace) with `downloads: {`: five are
```ts
        downloads: { macArm: { url: 'https://cdn.example.com/a.dmg' } },
```
and one (the "POST rejects invalid URL" test) is
```ts
        downloads: { macArm: { url: 'not-a-url' } },
```

For each of the 6, replace the entire `downloads:` line (preserving its indentation) with:

```ts
        installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
```

This leaves the "POST rejects invalid URL with 422" test sending a *valid* installer, which would now succeed — so change that test to a malformed installer. Find:

```ts
  test('POST rejects invalid URL with 422', async () => {
```
and the body it sends, and change it so the `installers` value is invalid (empty `id`), and rename the test:

```ts
  test('POST rejects malformed installer with 422', async () => {
    const { tokAdmin } = await seed();
    const a = buildApp();
    const r = await a.request('/admin/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokAdmin}` },
      body: JSON.stringify({
        orgId: 'o1',
        version: '1.0.0',
        changeLog: {},
        installers: { macArm: { id: '', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
      }),
    });
    expect(r.status).toBe(422);
  });
```

- [ ] **Step 7: Rewrite the `/updates/latest` route to use `installers`**

Replace the entire contents of `enterprise_server/src/routes/updates.ts` with:

```ts
import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { appRelease } from '../models/appRelease';

export const updatesRoutes = new Hono();
updatesRoutes.use('/updates/latest', requireAuth);

updatesRoutes.get('/updates/latest', async (c) => {
  const claims = c.get('claims');
  const release = await appRelease.getLatestEnabled(claims.orgId);
  if (!release) {
    return c.json({ latest: false });
  }
  const origin = new URL(c.req.url).origin;
  // A platform key is emitted only when that platform has an installer; the
  // desktop's pickPlatformUrl returns null for absent platforms → "no update".
  const installers = release.installers ?? {};
  const toEntry = (raw: { title?: unknown; content?: unknown } | undefined) => ({
    title: typeof raw?.title === 'string' ? raw.title : '',
    content: Array.isArray(raw?.content) ? raw.content.filter((x) => typeof x === 'string') : [],
  });
  return c.json({
    latest: true,
    version: release.version,
    date: new Date(release.published_at).toISOString(),
    changeLog: {
      zh: toEntry((release.change_log as Record<string, { title?: string; content?: string[] }>).zh),
      en: toEntry((release.change_log as Record<string, { title?: string; content?: string[] }>).en),
    },
    ...(installers.macArm
      ? { macArm: { url: `${origin}/downloads/app-releases/${installers.macArm.id}.dmg` } }
      : {}),
    ...(installers.windowsX64
      ? { windowsX64: { url: `${origin}/downloads/app-releases/${installers.windowsX64.id}.exe` } }
      : {}),
  });
});
```

- [ ] **Step 8: Update `updates.test.ts` for the new URL shape**

Replace the entire contents of `enterprise_server/tests/routes/updates.test.ts` with:

```ts
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { authService } from '../../src/auth/authService';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { appRelease } from '../../src/models/appRelease';
import { authRoutes } from '../../src/routes/auth';
import { updatesRoutes } from '../../src/routes/updates';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  app.route('/', updatesRoutes);
  return app;
}

async function login(): Promise<string> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
  await authService.createUser({ orgId: 'o1', username: 'alice', password: 'pw12345678' });
  const a = buildApp();
  const r = await a.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgName: 'T', username: 'alice', password: 'pw12345678' }),
  });
  return ((await r.json()) as { token: string }).token;
}

describe('routes/updates (installers)', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('401 without bearer token', async () => {
    const a = buildApp();
    const r = await a.request('/updates/latest');
    expect(r.status).toBe(401);
  });

  test('{ latest: false } when org has no release', async () => {
    const tok = await login();
    const a = buildApp();
    const r = await a.request('/updates/latest', { headers: { authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ latest: false });
  });

  test('emits a server-relative installer URL per platform that exists', async () => {
    const tok = await login();
    const { id } = await appRelease.add('o1', {
      version: '1.2.3',
      published_at: '2026-08-27T00:00:00Z',
      change_log: { zh: { title: 'zh', content: ['a'] }, en: { title: 'en', content: ['b'] } },
      installers: {
        macArm: { id: 'mac-file', fileName: 'GenWork.dmg', fileSize: 100, sha256: 'x' },
        windowsX64: { id: 'win-file', fileName: 'GenWork.exe', fileSize: 200, sha256: 'y' },
      },
    });
    await appRelease.setLatest(id);
    const a = buildApp();
    const r = await a.request('/updates/latest', { headers: { authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, any>;
    expect(body.latest).toBe(true);
    expect(body.version).toBe('1.2.3');
    expect(body.date).toBe('2026-08-27T00:00:00.000Z');
    expect(body.changeLog).toEqual({ zh: { title: 'zh', content: ['a'] }, en: { title: 'en', content: ['b'] } });
    const origin = new URL(r.url).origin;
    expect(body.macArm).toEqual({ url: `${origin}/downloads/app-releases/mac-file.dmg` });
    expect(body.windowsX64).toEqual({ url: `${origin}/downloads/app-releases/win-file.exe` });
    expect(body).not.toHaveProperty('macIntel');
  });

  test('omits a platform URL when that platform has no installer (Review Focus #4)', async () => {
    const tok = await login();
    const { id } = await appRelease.add('o1', {
      version: '1.2.3',
      change_log: {},
      installers: { windowsX64: { id: 'win-file', fileName: 'GenWork.exe', fileSize: 200, sha256: 'y' } },
    });
    await appRelease.setLatest(id);
    const a = buildApp();
    const r = await a.request('/updates/latest', { headers: { authorization: `Bearer ${tok}` } });
    const body = (await r.json()) as Record<string, any>;
    expect(body).toHaveProperty('windowsX64');
    expect(body).not.toHaveProperty('macArm');
  });

  test('disabled latest is not exposed', async () => {
    const tok = await login();
    const { id } = await appRelease.add('o1', {
      version: '1.2.4',
      change_log: {},
      installers: { macArm: { id: 'm', fileName: 'a.dmg', fileSize: 1, sha256: 's' } },
    });
    await appRelease.setLatest(id);
    await appRelease.update(id, { enabled: false });
    const a = buildApp();
    const r = await a.request('/updates/latest', { headers: { authorization: `Bearer ${tok}` } });
    expect(await r.json()).toEqual({ latest: false });
  });

  test('cross-org isolation', async () => {
    const tokA = await login();
    const { id } = await appRelease.add('o1', {
      version: '1.0.0',
      change_log: {},
      installers: { macArm: { id: 'm', fileName: 'a.dmg', fileSize: 1, sha256: 's' } },
    });
    await appRelease.setLatest(id);
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','T2')`);
    await authService.createUser({ orgId: 'o2', username: 'bob', password: 'pw12345678' });
    const a = buildApp();
    const loginB = await a.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgName: 'T2', username: 'bob', password: 'pw12345678' }),
    });
    const tokB = ((await loginB.json()) as { token: string }).token;
    const rB = await a.request('/updates/latest', { headers: { authorization: `Bearer ${tokB}` } });
    expect(await rB.json()).toEqual({ latest: false });
  });
});
```

- [ ] **Step 9: Run the updated server tests**

Run:
```
cd enterprise_server && npx vitest run tests/models/appRelease.test.ts tests/routes/adminReleases.test.ts tests/routes/updates.test.ts
```
Expected: PASS (all three files).

- [ ] **Step 10: Lint the touched server files**

Run:
```
cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  src/models/appRelease.ts src/routes/admin/releases.ts src/routes/updates.ts
```
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add enterprise_server/src/db/migrations/041_app_release_installers.sql \
        enterprise_server/src/models/appRelease.ts \
        enterprise_server/src/routes/admin/releases.ts \
        enterprise_server/src/routes/updates.ts \
        enterprise_server/tests/models/appRelease.test.ts \
        enterprise_server/tests/routes/adminReleases.test.ts \
        enterprise_server/tests/routes/updates.test.ts
git commit -m "feat(enterprise): store release installers instead of download URLs"
```

---

## Task 2: Chunked-resumable installer upload (server)

**Files:**
- Modify: `enterprise_server/src/lib/stateDir.ts`
- Create: `enterprise_server/src/routes/releaseInstallerUploads.ts`
- Modify: `enterprise_server/src/server.ts`
- Test: `enterprise_server/tests/routes/releaseInstallerUploads.test.ts`

**Interfaces:**
- Consumes: `releaseInstallerUploadDir(uploadId)`, `releaseInstallerFile(fileId, ext)` (added in this task), `requireAuth` + `requirePermission(PP.VersionCreate)`.
- Produces (HTTP):
  - `POST /admin/releases/installers/init` body `{platform:'macArm'|'windowsX64', fileName:string, fileSize:number}` → `200 {uploadId, chunkSize}`.
  - `PUT /admin/releases/installers/:uploadId/chunks/:index` body = raw bytes → `200 {acceptedIndex, totalAccepted}` (`400 bad_order`, `404 not_found`).
  - `POST /admin/releases/installers/:uploadId/complete` → `200 {id, fileName, fileSize, sha256}` (`400 size_mismatch`, `400 bad_order`, `404 not_found`).
  - `GET /downloads/app-releases/:name` → `200`/`206` stream, `404`/`403`/`416` (this endpoint is Task 3; it is mounted here so the download route can be tested alongside uploads, but its implementation lands in Task 3).

- [ ] **Step 1: Add installer storage path helpers to `stateDir.ts`**

Append to the end of `enterprise_server/src/lib/stateDir.ts` (after `kitStoreDir`):

```ts
/** Directory for uploaded release installer files. */
export function releaseInstallerDir(): string {
  return join(_stateDir, 'release-installers');
}

/** On-disk path for a finalized installer file. `fileId` is the upload id. */
export function releaseInstallerFile(fileId: string, ext: string): string {
  return join(releaseInstallerDir(), `${fileId}${ext}`);
}

/** Staging dir for in-progress (chunked) uploads. */
export function releaseInstallerUploadDir(uploadId: string): string {
  return join(releaseInstallerDir(), '.uploads', uploadId);
}
```

- [ ] **Step 2: Write the failing upload test**

Create `enterprise_server/tests/routes/releaseInstallerUploads.test.ts`:

```ts
import '../helpers/setupEnv';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENTERPRISE_STATE_DIR = join(tmpdir(), 'ent-upload-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { releaseInstallerFile, releaseInstallerUploadDir } from '../../src/lib/stateDir';
import { authRoutes } from '../../src/routes/auth';
import { releaseInstallerUploadsRoutes } from '../../src/routes/releaseInstallerUploads';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', authRoutes);
  app.route('/', releaseInstallerUploadsRoutes);
  return app;
}

// signToken is async, so build the admin token in beforeEach (not at module scope).
let auth: { authorization: string } = { authorization: 'Bearer ' };

async function seedOrg(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
}

describe('routes/releaseInstallerUploads', () => {
  beforeEach(async () => {
    rmSync(process.env.ENTERPRISE_STATE_DIR!, { recursive: true, force: true });
    await resetSchema();
    await runMigrations();
    await seedOrg();
    const adminTok = await signToken({ sub: 'u1', orgId: 'o1', roles: ['super_admin'] });
    auth = { authorization: `Bearer ${adminTok}` };
  });

  test('init validates extension matches platform', async () => {
    const a = buildApp();
    const r = await a.request('/admin/releases/installers/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ platform: 'windowsX64', fileName: 'genwork.dmg', fileSize: 100 }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()) as any).toMatchObject({ error: 'bad_extension' });
  });

  test('full upload: init -> chunks -> complete writes the file and returns meta', async () => {
    const payload = Buffer.from('A'.repeat(5)); // 5 bytes, single chunk
    const a = buildApp();
    const init = await a.request('/admin/releases/installers/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ platform: 'windowsX64', fileName: 'genwork.exe', fileSize: 5 }),
    });
    expect(init.status).toBe(200);
    const { uploadId, chunkSize } = (await init.json()) as any;
    expect(typeof uploadId).toBe('string');
    expect(chunkSize).toBeGreaterThan(5);

    const put = await a.request(`/admin/releases/installers/${uploadId}/chunks/0`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(payload),
    });
    expect(put.status).toBe(200);
    expect((await put.json()) as any).toMatchObject({ acceptedIndex: 0, totalAccepted: 1 });

    const done = await a.request(`/admin/releases/installers/${uploadId}/complete`, {
      method: 'POST',
      headers: { ...auth },
    });
    expect(done.status).toBe(200);
    const meta = (await done.json()) as any;
    expect(meta.id).toBe(uploadId);
    expect(meta.fileName).toBe('genwork.exe');
    expect(meta.fileSize).toBe(5);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);

    const diskPath = releaseInstallerFile(uploadId, '.exe');
    expect(existsSync(diskPath)).toBe(true);
    expect(readFileSync(diskPath).toString()).toBe('AAAAA');
    // staging cleaned up
    expect(existsSync(releaseInstallerUploadDir(uploadId))).toBe(false);
  });

  test('out-of-order chunk is rejected (Review Focus #5)', async () => {
    const a = buildApp();
    const init = await a.request('/admin/releases/installers/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ platform: 'windowsX64', fileName: 'genwork.exe', fileSize: 5 }),
    });
    const { uploadId } = (await init.json()) as any;
    // Send index 1 before index 0 -> gap.
    const bad = await a.request(`/admin/releases/installers/${uploadId}/chunks/1`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(Buffer.from('x')),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()) as any).toMatchObject({ error: 'bad_order' });
  });

  test('complete with under-delivery is size_mismatch (Review Focus #5)', async () => {
    const a = buildApp();
    const init = await a.request('/admin/releases/installers/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ platform: 'windowsX64', fileName: 'genwork.exe', fileSize: 100 }),
    });
    const { uploadId } = (await init.json()) as any;
    const put = await a.request(`/admin/releases/installers/${uploadId}/chunks/0`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(Buffer.from('A'.repeat(5))),
    });
    expect(put.status).toBe(200);
    const done = await a.request(`/admin/releases/installers/${uploadId}/complete`, {
      method: 'POST',
      headers: { ...auth },
    });
    expect(done.status).toBe(400);
    expect((await done.json()) as any).toMatchObject({ error: 'size_mismatch' });
  });

  test('init is org-scoped; another org cannot complete a different org upload', async () => {
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','T2')`);
    const tokOther = await signToken({ sub: 'u2', orgId: 'o2', roles: ['super_admin'] });
    const a = buildApp();
    const init = await a.request('/admin/releases/installers/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ platform: 'windowsX64', fileName: 'genwork.exe', fileSize: 5 }),
    });
    const { uploadId } = (await init.json()) as any;
    const done = await a.request(`/admin/releases/installers/${uploadId}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokOther}` },
    });
    expect(done.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the upload test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/releaseInstallerUploads.test.ts`
Expected: FAIL — `releaseInstallerUploadsRoutes` not found.

- [ ] **Step 4: Implement the upload route**

Create `enterprise_server/src/routes/releaseInstallerUploads.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { Hono } from 'hono';

import { requireAuth, requirePermission } from '../auth/middleware';
import { releaseInstallerFile, releaseInstallerUploadDir } from '../lib/stateDir';
import { PermissionPoint as PP } from '../shared/permissionPoints';

export const releaseInstallerUploadsRoutes = new Hono();
releaseInstallerUploadsRoutes.use('/admin/releases/installers/*', requireAuth, requirePermission(PP.VersionCreate));

/** Chunk size in bytes for resumable uploads (env-overridable for proxy limits). */
const CHUNK_SIZE = Number(process.env.RELEASE_INSTALLER_CHUNK_SIZE ?? 8 * 1024 * 1024);

type Platform = 'macArm' | 'windowsX64';
const PLATFORM_EXT: Record<Platform, string> = { macArm: '.dmg', windowsX64: '.exe' };

interface UploadMeta {
  orgId: string;
  platform: Platform;
  fileName: string;
  ext: string;
  expectedSize: number;
  totalAccepted: number;
}

const jsonError = (status: number, error: string, issues?: unknown): Response =>
  new Response(JSON.stringify({ error, ...(issues ? { issues } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function readMeta(uploadId: string): UploadMeta | null {
  const p = join(releaseInstallerUploadDir(uploadId), 'meta.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as UploadMeta;
  } catch {
    return null;
  }
}

function writeMeta(uploadId: string, meta: UploadMeta): void {
  const dir = releaseInstallerUploadDir(uploadId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
}

function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

releaseInstallerUploadsRoutes.post('/admin/releases/installers/init', async (c) => {
  const claims = c.get('claims');
  const raw = await c.req.json().catch(() => ({}));
  const platform = raw.platform as Platform;
  const fileName = typeof raw.fileName === 'string' ? raw.fileName.trim() : '';
  const fileSize = typeof raw.fileSize === 'number' ? raw.fileSize : NaN;
  if (platform !== 'macArm' && platform !== 'windowsX64') {
    return jsonError(400, 'bad_platform');
  }
  const ext = PLATFORM_EXT[platform];
  if (!fileName || !fileName.toLowerCase().endsWith(ext)) {
    return jsonError(400, 'bad_extension');
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return jsonError(400, 'bad_size');
  }
  const uploadId = randomUUID();
  writeMeta(uploadId, {
    orgId: claims.orgId,
    platform,
    fileName,
    ext,
    expectedSize: Math.floor(fileSize),
    totalAccepted: 0,
  });
  return c.json({ uploadId, chunkSize: CHUNK_SIZE });
});

releaseInstallerUploadsRoutes.put('/admin/releases/installers/:uploadId/chunks/:index', async (c) => {
  const claims = c.get('claims');
  const uploadId = c.req.param('uploadId');
  const index = Number(c.req.param('index'));
  if (!Number.isInteger(index) || index < 0) return jsonError(400, 'bad_order');

  const meta = readMeta(uploadId);
  if (!meta) return jsonError(404, 'not_found');
  if (meta.orgId !== claims.orgId) return jsonError(404, 'not_found');

  if (index > meta.totalAccepted) return jsonError(400, 'bad_order');

  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength === 0) return jsonError(400, 'empty_chunk');

  const dir = releaseInstallerUploadDir(uploadId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `chunk-${index}`), buf);

  if (index === meta.totalAccepted) {
    meta.totalAccepted = index + 1;
    writeMeta(uploadId, meta);
  }
  return c.json({ acceptedIndex: index, totalAccepted: meta.totalAccepted });
});

releaseInstallerUploadsRoutes.post('/admin/releases/installers/:uploadId/complete', async (c) => {
  const claims = c.get('claims');
  const uploadId = c.req.param('uploadId');
  const meta = readMeta(uploadId);
  if (!meta) return jsonError(404, 'not_found');
  if (meta.orgId !== claims.orgId) return jsonError(404, 'not_found');

  const dir = releaseInstallerUploadDir(uploadId);
  // Verify every chunk 0..totalAccepted-1 exists before touching the final file.
  for (let i = 0; i < meta.totalAccepted; i += 1) {
    if (!existsSync(join(dir, `chunk-${i}`))) {
      rmSync(dir, { recursive: true, force: true });
      return jsonError(400, 'bad_order');
    }
  }

  // Stream all chunks, in order, into the final file (never holds the whole file
  // in memory), and clean up staging.
  const finalPath = releaseInstallerFile(uploadId, meta.ext);
  mkdirSync(dirname(finalPath), { recursive: true });
  const out = createWriteStream(finalPath);
  try {
    for (let i = 0; i < meta.totalAccepted; i += 1) {
      const chunk = readFileSync(join(dir, `chunk-${i}`));
      if (!out.write(chunk)) {
        // back-pressure: wait for drain before the next chunk
        await new Promise<void>((resolve) => out.once('drain', resolve));
      }
    }
    out.end();
    await new Promise<void>((resolve, reject) => {
      out.once('finish', resolve);
      out.once('error', reject);
    });
  } catch {
    out.destroy();
    rmSync(finalPath, { force: true });
    return jsonError(500, 'write_failed');
  }

  rmSync(dir, { recursive: true, force: true });

  const totalBytes = statSync(finalPath).size;
  if (totalBytes !== meta.expectedSize) {
    rmSync(finalPath, { force: true });
    return jsonError(400, 'size_mismatch');
  }
  const sha256 = await sha256OfFile(finalPath);
  return c.json({ id: uploadId, fileName: meta.fileName, fileSize: totalBytes, sha256 });
});
```

- [ ] **Step 5: Register the route in `server.ts`**

In `enterprise_server/src/server.ts`, add the import next to the other route imports (after the `releaseDownloads` import added in Task 3 — for now add after `import { releasesRoutes }`-style lines; specifically after the `import { updatesRoutes } ...` line is not present, so add near the other `routes/*` imports):

```ts
import { releaseInstallerUploadsRoutes } from './routes/releaseInstallerUploads';
```

And register it in `buildApp()` alongside the other `app.route('/', ...)` calls (e.g. after `app.route('/', updatesRoutes);`):

```ts
  app.route('/', releaseInstallerUploadsRoutes);
```

- [ ] **Step 6: Run the upload test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/releaseInstallerUploads.test.ts`
Expected: PASS (all 5).

- [ ] **Step 7: Lint**

Run:
```
cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  src/lib/stateDir.ts src/routes/releaseInstallerUploads.ts src/server.ts
```
Expected: no errors. (Remove the unused `z`/`ZodError` import if the linter flags it — the upload route does not use Zod.)

- [ ] **Step 8: Commit**

```bash
git add enterprise_server/src/lib/stateDir.ts \
        enterprise_server/src/routes/releaseInstallerUploads.ts \
        enterprise_server/src/server.ts \
        enterprise_server/tests/routes/releaseInstallerUploads.test.ts
git commit -m "feat(enterprise): chunked resumable installer upload endpoints"
```

---

## Task 3: Resumable, JWT-gated installer download (server)

**Files:**
- Create: `enterprise_server/src/routes/releaseDownloads.ts`
- Modify: `enterprise_server/src/server.ts`
- Test: `enterprise_server/tests/routes/releaseDownloads.test.ts`

**Interfaces:**
- Consumes: `appRelease.getInstallerMeta(fileId)` (Task 1), `releaseInstallerFile(fileId, ext)` (Task 2), `requireAuth`.
- Produces (HTTP): `GET /downloads/app-releases/:name` where `:name = <fileId><ext>`. Returns `200` (full) or `206` (partial, with `Content-Range`), `Accept-Ranges: bytes`, `Content-Disposition: attachment`, `Content-Length`. Errors: `401` (no/invalid token), `404` (unknown `fileId`), `403` (cross-org), `416` (unsatisfiable range), `400` (bad range). Sets `Accept-Ranges` so the `server.ts` wrapper streams (not buffers) this response.

- [ ] **Step 1: Write the failing download test**

Create `enterprise_server/tests/routes/releaseDownloads.test.ts`:

```ts
import '../helpers/setupEnv';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENTERPRISE_STATE_DIR = join(tmpdir(), 'ent-dl-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { appRelease } from '../../src/models/appRelease';
import { releaseInstallerFile } from '../../src/lib/stateDir';
import { releaseDownloadsRoutes } from '../../src/routes/releaseDownloads';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', releaseDownloadsRoutes);
  return app;
}

const FILE_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';
const CONTENT = Buffer.from('0123456789AB'); // 12 bytes

async function seedInstaller(orgId: string): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id,name) VALUES ('${orgId}','T')`);
  const { id } = await appRelease.add(orgId, {
    version: '9.9.9',
    change_log: {},
    installers: { windowsX64: { id: FILE_ID, fileName: 'genwork.exe', fileSize: CONTENT.length, sha256: 'x' } },
  });
  await appRelease.setLatest(id);
  // Write the on-disk file the download route will serve.
  const p = releaseInstallerFile(FILE_ID, '.exe');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, CONTENT);
}

const userTok = async (orgId: string): Promise<string> =>
  signToken({ sub: 'u1', orgId, roles: ['user'] });

describe('routes/releaseDownloads', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('200 serves full file with attachment headers', async () => {
    await seedInstaller('o1');
    const tok = await userTok('o1');
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/' + FILE_ID + '.exe', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('content-length')).toBe(String(CONTENT.length));
    expect(r.headers.get('content-disposition')).toContain('genwork.exe');
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe(CONTENT.toString());
  });

  test('206 serves a byte range with Content-Range', async () => {
    await seedInstaller('o1');
    const tok = await userTok('o1');
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/' + FILE_ID + '.exe', {
      headers: { authorization: `Bearer ${tok}`, range: 'bytes=4-7' },
    });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 4-7/12');
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('4567');
  });

  test('416 for an unsatisfiable range', async () => {
    await seedInstaller('o1');
    const tok = await userTok('o1');
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/' + FILE_ID + '.exe', {
      headers: { authorization: `Bearer ${tok}`, range: 'bytes=999-' },
    });
    expect(r.status).toBe(416);
  });

  test('401 without a token (Review Focus #3)', async () => {
    await seedInstaller('o1');
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/' + FILE_ID + '.exe');
    expect(r.status).toBe(401);
  });

  test('403 cross-org download (Review Focus #1)', async () => {
    await seedInstaller('o1');
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o2','T2')`);
    const tokOther = await signToken({ sub: 'u2', orgId: 'o2', roles: ['user'] });
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/' + FILE_ID + '.exe', {
      headers: { authorization: `Bearer ${tokOther}` },
    });
    expect(r.status).toBe(403);
  });

  test('404 for an unknown fileId', async () => {
    await testPool.query(`INSERT INTO orgs(id,name) VALUES ('o1','T')`);
    const tok = await userTok('o1');
    const a = buildApp();
    const r = await a.request('/downloads/app-releases/ffffffff-0000-0000-0000-000000000000.exe', {
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the download test to verify it fails**

Run: `cd enterprise_server && npx vitest run tests/routes/releaseDownloads.test.ts`
Expected: FAIL — `releaseDownloadsRoutes` not found.

- [ ] **Step 3: Implement the download route**

Create `enterprise_server/src/routes/releaseDownloads.ts`:

```ts
import { existsSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import { Readable } from 'node:stream';

import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { appRelease } from '../models/appRelease';
import { releaseInstallerFile } from '../lib/stateDir';

export const releaseDownloadsRoutes = new Hono();
releaseDownloadsRoutes.use('/downloads/app-releases/*', requireAuth);

interface ByteRange {
  start: number;
  end: number;
}

/** Parse a `Range: bytes=...` header against `total`. Returns null for unsatisfiable, or undefined for absent/invalid (serve full). */
function parseByteRange(header: string | undefined, total: number): ByteRange | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined; // malformed -> serve full (200)
  const [, aRaw, bRaw] = m;
  let start: number;
  let end: number;
  if (aRaw === '' && bRaw !== '') {
    // suffix: last N bytes
    const suffix = Number(bRaw);
    if (suffix === 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = aRaw === '' ? 0 : Number(aRaw);
    end = bRaw === '' ? total - 1 : Math.min(Number(bRaw), total - 1);
  }
  if (start >= total || start > end) return null;
  return { start, end };
}

releaseDownloadsRoutes.get('/downloads/app-releases/:name', async (c) => {
  const claims = c.get('claims');
  const name = c.req.param('name');
  const ext = extname(name);
  const fileId = name.slice(0, name.length - ext.length);

  const meta = await appRelease.getInstallerMeta(fileId);
  if (!meta) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  if (meta.orgId !== claims.orgId) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
  }
  // The name's extension must match the stored file's extension.
  if (extname(meta.fileName).toLowerCase() !== ext.toLowerCase()) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }

  const filePath = releaseInstallerFile(fileId, ext);
  if (!existsSync(filePath)) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const total = statSync(filePath).size;
  const range = parseByteRange(c.req.header('range'), total);
  if (range === null) {
    return new Response(JSON.stringify({ error: 'range_not_satisfiable' }), { status: 416, headers: { 'content-type': 'application/json' } });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? total - 1;
  const length = end - start + 1;
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-length': String(length),
    'accept-ranges': 'bytes',
    'content-disposition': `attachment; filename="${meta.fileName}"`,
  };
  if (range) {
    headers['content-range'] = `bytes ${start}-${end}/${total}`;
  }

  const nodeStream = createReadStream(filePath, { start, end });
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new Response(webStream, { status: range ? 206 : 200, headers });
});
```

- [ ] **Step 4: Register the route in `server.ts` and stream its responses**

In `enterprise_server/src/server.ts`:

Add the import (with the Task 2 import):
```ts
import { releaseDownloadsRoutes } from './routes/releaseDownloads';
```

Register in `buildApp()`:
```ts
  app.route('/', releaseDownloadsRoutes);
```

Now make the `node:http` wrapper stream rangeable responses instead of buffering them. Find this block in `start()`:

```ts
    const honoRes = await app.fetch(new Request(url, { method, headers, body }));
    res.statusCode = honoRes.status;
    honoRes.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await honoRes.arrayBuffer());
    res.end(buf);
```
Replace with:

```ts
    const honoRes = await app.fetch(new Request(url, { method, headers, body }));
    res.statusCode = honoRes.status;
    honoRes.headers.forEach((v, k) => res.setHeader(k, v));
    // Stream rangeable responses (release installer downloads) so a hundreds-of-MB
    // file is not buffered in memory. Gated on the Accept-Ranges header the
    // download route sets; every other route keeps the buffered path unchanged.
    if (honoRes.headers.get('accept-ranges') && honoRes.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(honoRes.body as ReadableStream<Uint8Array>).pipe(res);
      return;
    }
    const buf = Buffer.from(await honoRes.arrayBuffer());
    res.end(buf);
```

- [ ] **Step 5: Run the download test to verify it passes**

Run: `cd enterprise_server && npx vitest run tests/routes/releaseDownloads.test.ts`
Expected: PASS (all 6).

- [ ] **Step 6: Re-run the full server release/updates tests together (still per-file)**

Run:
```
cd enterprise_server && npx vitest run tests/routes/releaseDownloads.test.ts tests/routes/releaseInstallerUploads.test.ts tests/routes/updates.test.ts tests/models/appRelease.test.ts
```
Expected: PASS (all four).

- [ ] **Step 7: Lint**

Run:
```
cd enterprise_server && npx eslint --ext ts --report-unused-disable-directives --max-warnings 0 \
  src/routes/releaseDownloads.ts src/server.ts
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add enterprise_server/src/routes/releaseDownloads.ts enterprise_server/src/server.ts \
        enterprise_server/tests/routes/releaseDownloads.test.ts
git commit -m "feat(enterprise): JWT resumable installer download endpoint"
```

---

## Task 4: Desktop download — auth + HTTP Range resume

**Files:**
- Modify: `src/main/libs/appUpdateInstaller.ts`
- Modify: `src/main/libs/appUpdateCoordinator.ts`
- Test: `src/main/libs/appUpdateInstaller.test.ts`

**Interfaces:**
- Produces: `buildDownloadPaths(updateDir: string, source: string, url: string, ext: string): { downloadPath: string; finalPath: string }` (stable per URL so retries resume). `downloadUpdate(url, source, onProgress, options?: { authToken?: string })`.
- Consumes: `session.defaultSession.fetch`, `crypto` (node:crypto).

- [ ] **Step 1: Write the failing desktop tests (auth + resume)**

Append to the end of `src/main/libs/appUpdateInstaller.test.ts` a new `describe` block. First, add `buildDownloadPaths` to the existing import list from `'./appUpdateInstaller'` (the long list that already includes `downloadUpdate`). The test file already imports `fs`, `os`, `path`, and the `mocks` object — no new top-level imports are needed (the `crypto` import lives in the source file, not the test).

Append this `describe` at the end of the file:

```ts
describe('downloadUpdate auth + range resume', () => {
  const originalPlatform = process.platform;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genwork-dl-auth-'));
    mocks.getPath.mockReset();
    mocks.getPath.mockReturnValue(tmpDir);
    mocks.fetch.mockReset();
  });

  afterEach(() => {
    mocks.fetch.mockReset();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('sends Authorization header when authToken is provided', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const bytes = new TextEncoder().encode('pkg');
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes); c.close(); },
    });
    mocks.fetch.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', url: '',
      headers: new Headers({ 'content-length': String(bytes.byteLength) }), body,
    });
    const url = 'https://server.example.com/downloads/app-releases/abc.dmg';
    await downloadUpdate(url, 'auto', () => {}, { authToken: 'jwt-tok' });
    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer jwt-tok');
  });

  test('omits Authorization header when no authToken', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const bytes = new TextEncoder().encode('pkg');
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes); c.close(); },
    });
    mocks.fetch.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', url: '',
      headers: new Headers({ 'content-length': String(bytes.byteLength) }), body,
    });
    await downloadUpdate('https://server.example.com/downloads/app-releases/abc.dmg', 'auto', () => {});
    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
  });

  test('resumes a 206 by appending to the existing partial (Review Focus #2)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const url = 'https://server.example.com/downloads/app-releases/abc.dmg';
    const ext = '.dmg';
    const { downloadPath } = buildDownloadPaths(path.join(tmpDir, 'updates'), 'auto', url, ext);
    fs.mkdirSync(path.dirname(downloadPath), { recursive: true });
    const existing = Buffer.from('AAAA'); // 4 bytes already downloaded
    fs.writeFileSync(downloadPath, existing);

    const remaining = Buffer.from('BBBB'); // 4 more bytes
    const total = existing.length + remaining.length; // 8
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(remaining)); c.close(); },
    });
    mocks.fetch.mockResolvedValue({
      ok: true, status: 206, statusText: 'Partial', url: '',
      headers: new Headers({ 'content-length': String(remaining.length) }), body,
    });

    let percentAtEnd: number | undefined;
    await downloadUpdate(url, 'auto', (p) => { percentAtEnd = p.percent; });

    const { finalPath } = buildDownloadPaths(path.join(tmpDir, 'updates'), 'auto', url, ext);
    expect(fs.readFileSync(finalPath).toString()).toBe('AAAABBBB');
    expect(fs.existsSync(downloadPath)).toBe(false); // renamed to final
    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).range).toBe('bytes=4-');
    expect(percentAtEnd).toBeCloseTo(1);
  });

  test('two different urls produce different partial paths (no cross-resume)', () => {
    const a = buildDownloadPaths(path.join(tmpDir, 'updates'), 'auto', 'https://x/1.dmg', '.dmg');
    const b = buildDownloadPaths(path.join(tmpDir, 'updates'), 'auto', 'https://x/2.dmg', '.dmg');
    expect(a.downloadPath).not.toBe(b.downloadPath);
  });

  test('a 200 response after sending Range truncates and starts fresh', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const url = 'https://server.example.com/downloads/app-releases/abc.dmg';
    const ext = '.dmg';
    const { downloadPath } = buildDownloadPaths(path.join(tmpDir, 'updates'), 'auto', url, ext);
    fs.mkdirSync(path.dirname(downloadPath), { recursive: true });
    fs.writeFileSync(downloadPath, Buffer.from('STALE-BYTES'));

    const full = Buffer.from('FRESH');
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(full)); c.close(); },
    });
    mocks.fetch.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', url: '',
      headers: new Headers({ 'content-length': String(full.length) }), body,
    });
    const result = await downloadUpdate(url, 'auto', () => {});
    expect(fs.readFileSync(result.filePath).toString()).toBe('FRESH');
  });
});
```

- [ ] **Step 2: Run the new desktop tests to verify they fail**

Run: `npx vitest run src/main/libs/appUpdateInstaller.test.ts -t "auth + range resume"`
Expected: FAIL — `buildDownloadPaths` is not exported / `downloadUpdate` ignores `authToken` and Range.

- [ ] **Step 3: Add `crypto` import and `buildDownloadPaths` to `appUpdateInstaller.ts`**

In `src/main/libs/appUpdateInstaller.ts`, after `import { pipeline } from 'stream/promises';` add:

```ts
import crypto from 'crypto';
```

After the `WindowsInstallerLauncherFallback` const (or near the top after imports), add:

```ts
/**
 * Stable partial + final paths for a download, derived from the URL so a retry
 * for the same target resumes the same partial file. `nameKey` is a short
 * digest of the URL — distinct URLs never share a partial (no cross-version
 * resume).
 */
export interface DownloadPaths {
  downloadPath: string;
  finalPath: string;
}

export function buildDownloadPaths(
  updateDir: string,
  source: string,
  url: string,
  ext: string,
): DownloadPaths {
  const nameKey = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  const base = `genwork-update-${source}-${nameKey}${ext}`;
  return {
    downloadPath: path.join(updateDir, `${base}.download`),
    finalPath: path.join(updateDir, base),
  };
}
```

- [ ] **Step 4: Rework `downloadUpdate` for auth + Range resume**

In `downloadUpdate`, replace the URL-parse/extension/path block. Find this region:

```ts
  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: ${url}`);
  }

  const ext = path.extname(parsedUrl.pathname) || (process.platform === 'darwin' ? '.dmg' : '.exe');
  const updateDir = path.join(app.getPath('userData'), 'updates');
  const ts = Date.now();
  const downloadPath = path.join(updateDir, `genwork-update-${source}-${ts}${ext}.download`);
  const finalPath = path.join(updateDir, `genwork-update-${source}-${ts}${ext}`);

  console.log(`[AppUpdate] Temp path: ${downloadPath}`);
  console.log(`[AppUpdate] Final path: ${finalPath}`);
```

Replace with:

```ts
  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid download URL: ${url}`);
  }

  const ext = path.extname(parsedUrl.pathname) || (process.platform === 'darwin' ? '.dmg' : '.exe');
  const updateDir = path.join(app.getPath('userData'), 'updates');
  const { downloadPath, finalPath } = buildDownloadPaths(updateDir, source, url, ext);

  console.log(`[AppUpdate] Temp path: ${downloadPath}`);
  console.log(`[AppUpdate] Final path: ${finalPath}`);
```

Now find the fetch call and the surrounding progress state. The current code (immediately after `resetInactivityTimer = ...` definition and the `try {`) is:

```ts
    const response = await session.defaultSession.fetch(url, {
      signal: controller.signal,
      // Electron documents Response.url as unreliable for session.fetch().
      // Reject Windows redirects so the validated input remains the download
      // source without relying on that field for final-URL provenance.
      ...(process.platform === 'win32' ? { redirect: 'error' as const } : {}),
    });

    console.log(`[AppUpdate] HTTP response: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      throw new Error(`Download failed (HTTP ${response.status})`);
    }

    if (!response.body) {
      throw new Error('Response has no body');
    }

    const totalHeader = response.headers.get('content-length');
    const total = totalHeader ? Number(totalHeader) : undefined;
    console.log(`[AppUpdate] Content-Length: ${totalHeader ?? 'unknown'}`);

    let received = 0;
```

Replace with (adds auth header, Range resume, and correct `total`/`received` for 206):

```ts
    const authHeaders: Record<string, string> = {};
    if (options?.authToken) {
      authHeaders.authorization = `Bearer ${options.authToken}`;
    }

    // Resume from an existing partial file for this (source, url) target.
    let existingPartialBytes = 0;
    try {
      existingPartialBytes = (await fs.promises.stat(downloadPath)).size;
    } catch {
      existingPartialBytes = 0;
    }
    const resumeRange = existingPartialBytes > 0;

    const response = await session.defaultSession.fetch(url, {
      signal: controller.signal,
      headers: {
        ...authHeaders,
        ...(resumeRange ? { range: `bytes=${existingPartialBytes}-` } : {}),
      },
      // Electron documents Response.url as unreliable for session.fetch().
      // Reject Windows redirects so the validated input remains the download
      // source without relying on that field for final-URL provenance.
      ...(process.platform === 'win32' ? { redirect: 'error' as const } : {}),
    });

    console.log(`[AppUpdate] HTTP response: ${response.status} ${response.statusText}`);

    if (!response.ok && response.status !== 206) {
      throw new Error(`Download failed (HTTP ${response.status})`);
    }

    if (!response.body) {
      throw new Error('Response has no body');
    }

    // A 206 means the server honored our Range and streams only the remaining
    // bytes; a 200 means it ignored Range (or we had no partial), so start over.
    const isPartial = resumeRange && response.status === 206;
    if (resumeRange && !isPartial) {
      console.log('[AppUpdate] server ignored Range; restarting download from 0');
      await fs.promises.rm(downloadPath, { force: true }).catch(() => {});
    }

    const declaredHeader = response.headers.get('content-length');
    const declared = declaredHeader ? Number(declaredHeader) : undefined;
    const declaredValid = declared != null && Number.isFinite(declared) ? declared : undefined;
    const startReceived = isPartial ? existingPartialBytes : 0;
    const total: number | undefined = isPartial
      ? startReceived + (declaredValid ?? 0)
      : declaredValid;
    console.log(`[AppUpdate] Content-Length: ${declaredHeader ?? 'unknown'}, resumeFrom=${startReceived}, isPartial=${isPartial}`);

    let received = startReceived;
```

Now the write-stream creation. Find:

```ts
    await fs.promises.mkdir(updateDir, { recursive: true });
    writeStream = fs.createWriteStream(downloadPath);
```
Replace with:

```ts
    await fs.promises.mkdir(updateDir, { recursive: true });
    writeStream = fs.createWriteStream(downloadPath, { flags: isPartial ? 'a' : 'w' });
```

The existing progress `emitProgress` uses `received / total`, which is now correct (both are full-file based for a 206). The existing completion check uses `total` (full size) and `stat.size !== total`, which is also correct now. Leave those as-is.

The `downloadUpdate` signature must accept `options`. Find the function signature:
```ts
export async function downloadUpdate(
  url: string,
  source: AppUpdateSource,
  onProgress: (progress: AppUpdateDownloadProgress) => void,
): Promise<AppUpdateDownloadResult> {
```
Replace with:
```ts
export interface DownloadUpdateOptions {
  /** Org JWT sent as `Authorization: Bearer` so the enterprise server serves the file. */
  authToken?: string;
}

export async function downloadUpdate(
  url: string,
  source: AppUpdateSource,
  onProgress: (progress: AppUpdateDownloadProgress) => void,
  options?: DownloadUpdateOptions,
): Promise<AppUpdateDownloadResult> {
```

- [ ] **Step 5: Pass the JWT from the coordinator**

In `src/main/libs/appUpdateCoordinator.ts` (around line 510), the `startDownload` flow calls `downloadUpdate(url, source, progressCb)`. Find the closing of that call — the progress callback's end followed by the call's close:

```ts
        },
      );
      const filePath = download.filePath;
```
Replace with (adds the `options` argument as the 4th param):

```ts
        },
        { authToken: sessionStorage.load()?.jwt },
      );
      const filePath = download.filePath;
```

(`sessionStorage` is already imported in `appUpdateCoordinator.ts`, line 17.)

- [ ] **Step 6: Run the desktop installer tests**

Run: `npx vitest run src/main/libs/appUpdateInstaller.test.ts`
Expected: PASS — all existing tests plus the 5 new auth/resume tests.

- [ ] **Step 7: Run the coordinator tests (guard against regressions)**

Run: `npx vitest run src/main/libs/appUpdateCoordinator.test.ts`
Expected: PASS.

- [ ] **Step 8: Lint**

Run:
```
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/main/libs/appUpdateInstaller.ts src/main/libs/appUpdateCoordinator.ts
```
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/main/libs/appUpdateInstaller.ts src/main/libs/appUpdateCoordinator.ts src/main/libs/appUpdateInstaller.test.ts
git commit -m "feat(desktop): resumable JWT auth installer download"
```

---

## Task 5: Admin web — installer types, chunked-upload client, i18n

**Files:**
- Modify: `enterprise_server/web/src/i18n.ts`
- Modify: `enterprise_server/web/src/api/releases.ts`
- Create: `enterprise_server/web/src/api/releaseInstallers.ts`
- Modify: `enterprise_server/web/tests/api/releases.test.ts`
- Test: `enterprise_server/web/tests/api/releaseInstallers.test.ts`

**Interfaces:**
- Produces:
  - `ReleaseInstaller = { id, fileName, fileSize, sha256 }`, `ReleaseInstallers = { macArm?, windowsX64? }` (in `api/releases.ts`). `ReleaseView.installers: ReleaseInstallers`; `releasesApi.add`/`update` take `installers`.
  - `uploadInstaller(opts: { platform: 'macArm'|'windowsX64'; file: File; getToken: () => string | null; onProgress?: (done: number, total: number) => void; resume?: { uploadId: string; totalAccepted: number } }): Promise<InstallerMeta>`. Throws `InstallerUploadError` (has `.resume?: { uploadId, totalAccepted }`) on failure.
- Consumes: `apiClient.baseUrl()`.

- [ ] **Step 1: Update `web/src/api/releases.ts`**

Replace the `ReleaseDownloads` type + `ReleaseView` + `releasesApi.add`/`update` signatures. Concretely, replace:

```ts
export interface ReleaseDownloads {
  macIntel?: { url: string };
  macArm?: { url: string };
  windowsX64?: { url: string };
}

export interface ReleaseView {
  id: string;
  version: string;
  published_at: string;
  change_log: ReleaseChangelog;
  downloads: ReleaseDownloads;
  enabled: boolean;
  is_latest: boolean;
}
```
with:
```ts
export interface ReleaseInstaller {
  id: string;
  fileName: string;
  fileSize: number;
  sha256: string;
}

export interface ReleaseInstallers {
  macArm?: ReleaseInstaller;
  windowsX64?: ReleaseInstaller;
}

export interface ReleaseView {
  id: string;
  version: string;
  published_at: string;
  change_log: ReleaseChangelog;
  installers: ReleaseInstallers;
  enabled: boolean;
  is_latest: boolean;
}
```

In `releasesApi.add`, replace `downloads: ReleaseDownloads;` with `installers: ReleaseInstallers;`.
In `releasesApi.update`'s patch type, replace `downloads?: ReleaseDownloads;` with `installers?: ReleaseInstallers;`.

- [ ] **Step 2: Update `web/tests/api/releases.test.ts`**

Replace the `downloads: { macArm: { url: 'https://cdn.example.com/a.dmg' } }` occurrences with an `installers` object. The two tests using it:
- `add POSTs the structured body`: change the input's `downloads` to `installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } }` and update the `toMatchObject` to expect that `installers` (remove `downloads` from the matcher).

After the edit the `add` test body/matcher should be:
```ts
  test('add POSTs the structured body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"id":"r1"}', { status: 200 }));
    const id = await releasesApi.add({
      orgId: 'o1',
      version: '1.2.0',
      changeLog: { zh: { title: 't', content: ['a'] } },
      installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
    });
    expect(id).toBe('r1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/admin/releases');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      orgId: 'o1',
      version: '1.2.0',
      changeLog: { zh: { title: 't', content: ['a'] } },
      installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
    });
  });
```

- [ ] **Step 3: Write the failing upload-client test**

Create `enterprise_server/web/tests/api/releaseInstallers.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { apiClient } from '../../src/api/client';
import { InstallerUploadError, uploadInstaller } from '../../src/api/releaseInstallers';

const getToken = () => 'tok';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('api/releaseInstallers.uploadInstaller', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    apiClient.setBaseUrl('http://test');
  });

  test('init -> chunks -> complete posts the right endpoints and returns meta', async () => {
    const file = new File([new Uint8Array(5).fill(65)], 'genwork.exe', { type: 'application/octet-stream' });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { uploadId: 'up1', chunkSize: 8 * 1024 * 1024 })); // init
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { acceptedIndex: 0, totalAccepted: 1 })); // chunk 0
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'up1', fileName: 'genwork.exe', fileSize: 5, sha256: 'abc' })); // complete

    const meta = await uploadInstaller({ platform: 'windowsX64', file, getToken, onProgress: vi.fn() });
    expect(meta).toEqual({ id: 'up1', fileName: 'genwork.exe', fileSize: 5, sha256: 'abc' });

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe('http://test/admin/releases/installers/init');
    expect(urls[1]).toBe('http://test/admin/releases/installers/up1/chunks/0');
    expect(urls[2]).toBe('http://test/admin/releases/installers/up1/complete');

    const initBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(initBody).toMatchObject({ platform: 'windowsX64', fileName: 'genwork.exe', fileSize: 5 });
    const authHeader = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(authHeader.authorization).toBe('Bearer tok');
  });

  test('a failed chunk surfaces a resumable InstallerUploadError', async () => {
    const file = new File([new Uint8Array(5).fill(65)], 'genwork.exe', { type: 'application/octet-stream' });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { uploadId: 'up1', chunkSize: 8 * 1024 * 1024 })); // init
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' })); // chunk 0 fails

    let err: unknown;
    try {
      await uploadInstaller({ platform: 'windowsX64', file, getToken, onProgress: vi.fn() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InstallerUploadError);
    expect((err as InstallerUploadError).resume).toEqual({ uploadId: 'up1', totalAccepted: 0 });
  });

  test('resume skips already-accepted chunks', async () => {
    // 8-byte file with a 4-byte chunkSize = 2 chunks; resume from totalAccepted=1
    // sends only chunk 1 (not chunk 0) and does not call init.
    const file = new File([new Uint8Array(8).fill(65)], 'genwork.exe', { type: 'application/octet-stream' });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { acceptedIndex: 1, totalAccepted: 2 })); // chunk 1
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'up9', fileName: 'genwork.exe', fileSize: 8, sha256: 'z' })); // complete

    const meta = await uploadInstaller({
      platform: 'windowsX64',
      file,
      getToken,
      onProgress: vi.fn(),
      chunkSize: 4,
      resume: { uploadId: 'up9', totalAccepted: 1 },
    });
    expect(meta.id).toBe('up9');
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain('http://test/admin/releases/installers/up9/chunks/1');
    expect(urls).not.toContain('http://test/admin/releases/installers/up9/chunks/0');
    expect(urls).not.toContain('http://test/admin/releases/installers/init');
  });
});
```

- [ ] **Step 4: Run the upload-client test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/api/releaseInstallers.test.ts`
Expected: FAIL — `releaseInstallers` module not found.

- [ ] **Step 5: Implement `releaseInstallers.ts`**

Create `enterprise_server/web/src/api/releaseInstallers.ts`:

```ts
import { apiClient } from './client';

export type InstallerPlatform = 'macArm' | 'windowsX64';

export interface InstallerMeta {
  id: string;
  fileName: string;
  fileSize: number;
  sha256: string;
}

export interface UploadProgress {
  done: number;
  total: number;
}

export interface ResumeState {
  uploadId: string;
  totalAccepted: number;
}

/** Thrown when a chunked upload fails. `.resume` lets the caller continue. */
export class InstallerUploadError extends Error {
  resume?: ResumeState;
  constructor(message: string, resume?: ResumeState) {
    super(message);
    this.name = 'InstallerUploadError';
    this.resume = resume;
  }
}

async function raw(method: string, url: string, token: string | null, body?: BodyInit): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/octet-stream';
  const res = await fetch(url, { method, headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail: string | undefined;
    try { detail = (JSON.parse(text) as { detail?: string }).detail; } catch { /* ignore */ }
    throw new Error(`upload failed (http ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return res;
}

export interface UploadInstallerOptions {
  platform: InstallerPlatform;
  file: File;
  getToken: () => string | null;
  onProgress?: (progress: UploadProgress) => void;
  resume?: ResumeState;
  /**
   * Bytes per chunk. On a fresh upload the server's returned `chunkSize` is used
   * when this is omitted; pass it explicitly (e.g. on a resume after the server
   * restarted) to control slicing. Defaults to 8 MiB.
   */
  chunkSize?: number;
}

/**
 * Chunked, resumable installer upload. `init` is called once unless `resume`
 * supplies an existing `uploadId`. Each chunk is a `file.slice` PUT. On failure
 * it throws `InstallerUploadError` with `.resume` so the caller can continue.
 */
export async function uploadInstaller(opts: UploadInstallerOptions): Promise<InstallerMeta> {
  const { platform, file, getToken, onProgress, resume, chunkSize } = opts;
  const base = apiClient.baseUrl();
  let uploadId: string;
  let totalAccepted: number;
  let sliceSize = chunkSize;

  if (resume) {
    uploadId = resume.uploadId;
    totalAccepted = resume.totalAccepted;
  } else {
    const token = getToken();
    const res = await raw('POST', `${base}/admin/releases/installers/init`, token, JSON.stringify({
      platform,
      fileName: file.name,
      fileSize: file.size,
    }));
    const { uploadId: id, chunkSize: serverChunkSize } = (await res.json()) as { uploadId: string; chunkSize: number };
    uploadId = id;
    totalAccepted = 0;
    sliceSize = sliceSize ?? serverChunkSize ?? 8 * 1024 * 1024;
  }

  const CHUNK = sliceSize ?? 8 * 1024 * 1024;
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK));

  for (let index = totalAccepted; index < totalChunks; index += 1) {
    const start = index * CHUNK;
    const slice = file.slice(start, Math.min(start + CHUNK, file.size));
    const blob = await slice.arrayBuffer();
    try {
      const res = await raw('PUT', `${base}/admin/releases/installers/${uploadId}/chunks/${index}`, getToken(), new Uint8Array(blob));
      const { totalAccepted: next } = (await res.json()) as { totalAccepted: number };
      totalAccepted = next;
      onProgress?.({ done: Math.min(start + CHUNK, file.size), total: file.size });
    } catch (e) {
      throw new InstallerUploadError((e as Error).message, { uploadId, totalAccepted });
    }
  }

  try {
    const res = await raw('POST', `${base}/admin/releases/installers/${uploadId}/complete`, getToken());
    return (await res.json()) as InstallerMeta;
  } catch (e) {
    throw new InstallerUploadError((e as Error).message, { uploadId, totalAccepted });
  }
}
```

> The client honors the server's `chunkSize` on a fresh `init` (or the caller's explicit `chunkSize`), so the on-wire chunk boundaries always match what the server expects. On a resume the caller must pass the same `chunkSize` it used before (the server does not persist it across a restart), so the client slices the same way and continues from `totalAccepted`.

- [ ] **Step 6: Run the upload-client test to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/api/releaseInstallers.test.ts`
Expected: PASS (all 3).

- [ ] **Step 7: Update i18n (`web/src/i18n.ts`)**

In the **English** block, delete these three lines:
```ts
  'page.versions.downloadsMacIntel': 'macOS (Intel) download URL',
  'page.versions.downloadsMacArm': 'macOS (Apple Silicon) download URL',
  'page.versions.downloadsWindowsX64': 'Windows (x64) download URL',
```
Add (anywhere within the `page.versions.*` group, e.g. right after the `changeLogEnContent` line):
```ts
  'page.versions.installerMacArm': 'macOS (Apple Silicon) installer (.dmg)',
  'page.versions.installerWindowsX64': 'Windows (x64) installer (.exe)',
  'page.versions.installerChoose': 'Choose file…',
  'page.versions.installerUploading': 'Uploading…',
  'page.versions.installerUploaded': 'Uploaded',
  'page.versions.installerReplace': 'Replace',
  'page.versions.installerError': 'Upload failed',
  'page.versions.installerRetry': 'Retry / resume',
  'page.versions.columnInstallers': 'Installers',
  'page.versions.noInstaller': 'No installer',
```

In the **Chinese** block, delete:
```ts
  'page.versions.downloadsMacIntel': 'macOS(Intel)下载链接',
  'page.versions.downloadsMacArm': 'macOS(Apple Silicon)下载链接',
  'page.versions.downloadsWindowsX64': 'Windows(x64)下载链接',
```
Add:
```ts
  'page.versions.installerMacArm': 'macOS(Apple Silicon)安装包(.dmg)',
  'page.versions.installerWindowsX64': 'Windows(x64)安装包(.exe)',
  'page.versions.installerChoose': '选择文件…',
  'page.versions.installerUploading': '上传中…',
  'page.versions.installerUploaded': '已上传',
  'page.versions.installerReplace': '替换',
  'page.versions.installerError': '上传失败',
  'page.versions.installerRetry': '重试/续传',
  'page.versions.columnInstallers': '安装包',
  'page.versions.noInstaller': '无安装包',
```

- [ ] **Step 8: Lint**

Run:
```
cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/api/releases.ts src/api/releaseInstallers.ts src/i18n.ts
```
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add enterprise_server/web/src/i18n.ts enterprise_server/web/src/api/releases.ts \
        enterprise_server/web/src/api/releaseInstallers.ts \
        enterprise_server/web/tests/api/releases.test.ts enterprise_server/web/tests/api/releaseInstallers.test.ts
git commit -m "feat(enterprise-web): installer upload client + installer types"
```

---

## Task 6: Admin web — `VersionsPage` uploader UI

**Files:**
- Modify: `enterprise_server/web/src/pages/VersionsPage.tsx`
- Modify: `enterprise_server/web/tests/pages/VersionsPage.test.tsx`

**Interfaces:**
- Consumes: `uploadInstaller`, `InstallerMeta`, `InstallerUploadError`, `ResumeState` (Task 5); `releasesApi` with `installers` (Task 5); `useAuthStore.getState().token` (or `useAuth()` token) for `getToken`.
- Produces: `VersionsPage` renders two installer uploaders and posts `installers` on create/patch.

- [ ] **Step 1: Update `VersionsPage.test.tsx` fixtures + add uploader render test**

In `enterprise_server/web/tests/pages/VersionsPage.test.tsx`, replace the `downloads: { macArm: { url: 'https://cdn.example.com/a.dmg' } }` in the "lists releases" fixture with:
```ts
        installers: { macArm: { id: 'file-1', fileName: 'GenWork.dmg', fileSize: 100, sha256: 's' } },
```
and add a new test to the `describe` block:

```ts
  test('opens the drawer with two installer uploaders', async () => {
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 }));
    renderPage();
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    const addBtn = screen.getByRole('button', { name: /Add|新增/i });
    fireEvent.click(addBtn);
    await waitFor(() => {
      expect(screen.getByText(/Apple Silicon|macOS/i)).toBeInTheDocument();
      expect(screen.getByText(/Windows \(x64\)|Windows/i)).toBeInTheDocument();
    });
  });
```

- [ ] **Step 2: Run the page test to verify it fails**

Run: `cd enterprise_server/web && npx vitest run tests/pages/VersionsPage.test.tsx`
Expected: FAIL — the new uploader-label test (labels not rendered).

- [ ] **Step 3: Rewrite `VersionsPage.tsx` to use uploaders**

This is the largest UI edit. Replace the `FIELD` object, the download-related form state, the `fields` array (remove the three download fields), `onSubmit` (build `installers` from uploader state), `initialValues` (pre-populate from `installers`), and the list "downloads" column (→ "installers").

Concretely, make these changes:

(a) Replace the `FIELD` const:
```ts
export const FIELD = {
  version: 'version',
  publishedAt: 'publishedAt',
  changeLogZhTitle: 'changeLogZhTitle',
  changeLogZhContent: 'changeLogZhContent',
  changeLogEnTitle: 'changeLogEnTitle',
  changeLogEnContent: 'changeLogEnContent',
} as const;
```

(b) Add imports at the top (after the existing `releasesApi` import):
```ts
import { uploadInstaller, InstallerUploadError, type InstallerMeta, type ResumeState } from '../api/releaseInstallers';
```

(c) Add per-platform uploader state inside the component (next to the existing `useState` hooks):
```ts
  type Uploader =
    | { status: 'idle' }
    | { status: 'uploading'; progress: UploadProgressShape; file: File }
    | { status: 'done'; meta: InstallerMeta; file: File }
    | { status: 'error'; message: string; file: File; resume?: ResumeState };

  interface UploadProgressShape { done: number; total: number; }
  const [macUploader, setMacUploader] = useState<Uploader>({ status: 'idle' });
  const [winUploader, setWinUploader] = useState<Uploader>({ status: 'idle' });

  const getToken = () => useAuthStore.getState().token ?? null;

  async function runUpload(platform: 'macArm' | 'windowsX64', file: File, resume?: ResumeState, set = setMacUploader) {
    set({ status: 'uploading', progress: { done: 0, total: file.size }, file });
    try {
      const meta = await uploadInstaller({
        platform, file, getToken, resume,
        onProgress: (p) => set((prev) => (prev.status === 'uploading' ? { ...prev, progress: p } : prev)),
      });
      set({ status: 'done', meta, file });
      toast.success(t('page.versions.installerUploaded'));
    } catch (e) {
      const err = e instanceof InstallerUploadError ? e : new InstallerUploadError((e as Error).message);
      set({ status: 'error', message: err.message, file, resume: err.resume });
      toast.error(err.message);
    }
  }
```

Add `import { useAuthStore } from '../auth/store';` to the imports (it is used by the existing page's sibling tests; confirm the import path `../auth/store` matches `web/src/auth/store`).

(d) Add an uploader control renderer (a small inline component or JSX helper) and render two of them in the `FormDrawer` body (the drawer's children), replacing the removed download text fields. Because `FormDrawer` renders `fields` and its children, place the uploaders in the drawer's children slot (the `<FormDrawer ...>{children}</FormDrawer>` block currently shows `publishedAt` when editing). Add a second child block:

```tsx
      <FormDrawer ...>
        {editing && (
          <div className="mb-3">
            <div className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
              {t('page.versions.publishedAt')}
            </div>
            <div className="text-sm text-[var(--text-primary)]">
              {editing.published_at.slice(0, 10)}
            </div>
          </div>
        )}
        <InstallerUploaders
          macLabel={t('page.versions.installerMacArm')}
          winLabel={t('page.versions.installerWindowsX64')}
          choose={t('page.versions.installerChoose')}
          uploading={t('page.versions.installerUploading')}
          uploaded={t('page.versions.installerUploaded')}
          replace={t('page.versions.installerReplace')}
          error={t('page.versions.installerError')}
          retry={t('page.versions.installerRetry')}
          mac={macUploader}
          win={winUploader}
          onPickMac={(f) => runUpload('macArm', f, undefined, setMacUploader)}
          onPickWin={(f) => runUpload('windowsX64', f, undefined, setWinUploader)}
          onRetryMac={() => runUpload('macArm', macUploader.file, macUploader.status === 'error' ? macUploader.resume : undefined, setMacUploader)}
          onRetryWin={() => runUpload('windowsX64', winUploader.file, winUploader.status === 'error' ? winUploader.resume : undefined, setWinUploader)}
        />
      </FormDrawer>
```

(e) Define the `InstallerUploaders` presentational component (below `VersionsPage` in the same file) that renders the two labeled rows. Each row: a label, a file `<input type="file">` (accept `.dmg`/`.exe`), and a status line (progress percent, uploaded filename, or error + Retry button). Example implementation:

```tsx
function InstallerUploaders(props: {
  macLabel: string; winLabel: string; choose: string; uploading: string; uploaded: string;
  replace: string; error: string; retry: string;
  mac: Uploader; win: Uploader;
  onPickMac: (f: File) => void; onPickWin: (f: File) => void;
  onRetryMac: () => void; onRetryWin: () => void;
}) {
  const row = (
    label: string, accept: string, up: Uploader,
    onPick: (f: File) => void, onRetry: () => void,
  ): JSX.Element => {
    const meta = up.status === 'done' ? up.meta : undefined;
    const pct = up.status === 'uploading' && up.progress.total
      ? Math.round((up.progress.done / up.progress.total) * 100)
      : undefined;
    return (
      <div className="mb-3">
        <div className="block text-sm font-medium text-[var(--text-secondary)] mb-1">{label}</div>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="file"
            accept={accept}
            aria-label={label}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); }}
            className="text-[12px] text-[var(--text-secondary)] file:mr-2.5 file:rounded-[6px] file:border-0 file:bg-[var(--accent-primary)]/10 file:px-3 file:py-1.5 file:text-[12px] file:text-[var(--accent-primary)]"
          />
          {up.status === 'uploading' && (
            <span className="text-sm text-[var(--text-secondary)]">{props.uploading} {pct != null ? `${pct}%` : ''}</span>
          )}
          {up.status === 'done' && (
            <span className="text-sm text-[var(--success-primary)]" title={meta?.sha256}>
              {props.uploaded}: {meta?.fileName}
            </span>
          )}
          {up.status === 'error' && (
            <span className="text-sm text-[var(--danger-primary)]">
              {props.error}: {up.message}
            </span>
          )}
          {up.status === 'error' && (
            <button
              type="button"
              className="px-2 py-1 text-sm rounded bg-[var(--accent-primary)] text-white"
              onClick={onRetry}
            >
              {props.retry}
            </button>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="mb-4">
      {row(props.macLabel, '.dmg', props.mac, props.onPickMac, props.onRetryMac)}
      {row(props.winLabel, '.exe', props.win, props.onPickWin, props.onRetryWin)}
    </div>
  );
}
```

(f) Update `onSubmit` to build `installers` from the uploader `done` metas (and require at least one before creating). Replace the `onSubmit` body's `downloads` construction (the `const downloads ... const mi/mi/mi ...` block) and the two mutation calls:

```ts
    const installers: ReleaseInstallers = {};
    if (macUploader.status === 'done') installers.macArm = macUploader.meta;
    if (winUploader.status === 'done') installers.windowsX64 = winUploader.meta;

    const publishedAtRaw = v(FIELD.publishedAt).trim();
    const publishedAt =
      publishedAtRaw && !Number.isNaN(Date.parse(publishedAtRaw)) ? publishedAtRaw : undefined;

    try {
      if (editing) {
        await updateMut.mutateAsync({ id: editing.id, patch: { changeLog, installers } });
      } else {
        if (!installers.macArm && !installers.windowsX64) {
          throw new Error(t('page.versions.noInstaller'));
        }
        await addMut.mutateAsync({
          orgId,
          version: v(FIELD.version).trim(),
          published_at: publishedAt,
          changeLog,
          installers,
        });
      }
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
```
Add `import { type ReleaseInstallers } from '../api/releases';` and remove the now-unused download field logic.

(g) `initialValues`: remove the three `downloads*` entries. When editing, pre-populate uploader state from `editing.installers` (optional — if not done, the user can re-upload). Set on open of the edit drawer:
```ts
  const openEdit = (r: ReleaseView) => {
    setEditing(r);
    setMacUploader(r.installers.macArm
      ? { status: 'done', meta: r.installers.macArm, file: undefined as unknown as File }
      : { status: 'idle' });
    setWinUploader(r.installers.windowsX64
      ? { status: 'done', meta: r.installers.windowsX64, file: undefined as unknown as File }
      : { status: 'idle' });
    setDrawerOpen(true);
  };
```
(Replace the inline `setEditing(r); setDrawerOpen(true)` in the Edit button's `onClick` with `openEdit(r)`.)

(h) Replace the list "downloads" column with an "installers" column:
```ts
    {
      key: 'installers',
      header: t('page.versions.columnInstallers'),
      render: (r) => {
        const present = [
          r.installers.macArm ? 'macOS arm' : null,
          r.installers.windowsX64 ? 'Win x64' : null,
        ].filter(Boolean);
        const title = [
          r.installers.macArm ? `macOS: ${r.installers.macArm.fileName}` : null,
          r.installers.windowsX64 ? `Windows: ${r.installers.windowsX64.fileName}` : null,
        ].filter(Boolean).join('\n');
        return <span title={title}>{present.length ? present.join(' · ') : t('page.versions.noInstaller')}</span>;
      },
    },
```

- [ ] **Step 4: Run the page test to verify it passes**

Run: `cd enterprise_server/web && npx vitest run tests/pages/VersionsPage.test.tsx`
Expected: PASS (existing 3 tests + the new uploader test).

- [ ] **Step 5: Lint + typecheck the web**

Run:
```
cd enterprise_server/web && npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/pages/VersionsPage.tsx
```
Expected: no errors. (If the project has a `tsc`/typecheck script, run it; the `Uploader` union's `file` field is `File`, so the edit pre-populate's `file: undefined as unknown as File` is a deliberate cast — if the linter flags the cast, restructure so the `done` state's `file` is optional: change the `done` variant to `{ status: 'done'; meta: InstallerMeta; file?: File }`.)

- [ ] **Step 6: Commit**

```bash
git add enterprise_server/web/src/pages/VersionsPage.tsx enterprise_server/web/tests/pages/VersionsPage.test.tsx
git commit -m "feat(enterprise-web): upload installers in the versions page"
```

---

## Post-implementation verification (not a task — run at the end)

- Server: run each new/changed test file individually (per-file constraint):
  ```
  cd enterprise_server
  npx vitest run tests/models/appRelease.test.ts tests/routes/adminReleases.test.ts tests/routes/updates.test.ts
  npx vitest run tests/routes/releaseInstallerUploads.test.ts
  npx vitest run tests/routes/releaseDownloads.test.ts
  ```
- Desktop: `npx vitest run src/main/libs/appUpdateInstaller.test.ts src/main/libs/appUpdateCoordinator.test.ts`
- Web: `cd enterprise_server/web && npx vitest run tests/api/releases.test.ts tests/api/releaseInstallers.test.ts tests/pages/VersionsPage.test.tsx`
- Manual (Electron): `npm run electron:dev` — with a local enterprise server, upload a `.dmg`, set it latest, confirm the app detects the new version, shows the changelog, and downloads from `/downloads/app-releases/...`. Confirm a manual network interruption mid-download resumes rather than restarting.
- Streaming wrapper: confirm a large file served by `GET /downloads/app-releases/...` does not spike the server's RSS (the `accept-ranges` gate makes it stream, not buffer).
