# Enterprise Release Installers — Design

Date: 2026-10-08
Status: Draft (for review)
Scope: `enterprise_server` (API + storage + migration), `enterprise_server/web` (admin console), GenWork desktop `src/main` (installer download).

## 1. Intent

Enterprise admins currently distribute desktop app versions by **pasting external
download URLs** into the admin console (`VersionsPage`). This requires standing up
a separate host/CDN, copying long-lived links, and trusting external origins — and
the desktop's Windows URL policy has to special-case each one.

Goal: the enterprise server becomes the **single source of truth for installers**.
An admin uploads the actual installer binaries (macOS Apple Silicon `.dmg` and
Windows x64 `.exe`; **no macOS Intel build**) plus a release note, marks the version
latest, and desktop clients auto-detect it, show the release note, then download
**from the enterprise server** and self-install.

The desktop side (auto-detect → release-note modal → download → auto-install) is
**already implemented** and remains the target behavior. This work changes what the
server stores and serves, and makes that download resumable.

Success: an admin uploads a version's `.dmg`/`.exe` + changelog → sets it latest →
desktop clients detect the new version, show the changelog, and after confirmation
download it from the enterprise server (resumably) and self-install, without any
external URL.

## 2. Confirmed decisions

1. **Delete the `downloads` (external-URL) column.** No more paste-URL flow.
   `/updates/latest` keeps the same response *shape* (`macArm.url` / `windowsX64.url`),
   so the desktop parser and coordinator are untouched by the data-model change.
2. **Two-step flow** (match kit/skill): upload installer files first, then write the
   resulting metadata into a release (create or edit).
3. **Both directions resumable this release:**
   - Desktop **download** resumes via HTTP Range against the existing `.download`
     partial file.
   - Admin **upload** is chunked (multipart/chunked endpoints) with resume support.
4. **Downloads are JWT-authenticated** (org-scoped), same as `/updates/latest`.
   The desktop download path gains a `Bearer` header.

## 3. Current state (verified)

- `app_releases` (migration `007_app_releases.sql`): `version`, `change_log` (JSONB),
  `downloads` (JSONB `{macIntel?/macArm?/windowsX64?:{url}}`), `enabled`, `is_latest`,
  unique `(org_id, version)`, partial unique `is_latest`.
- `appRelease` model (`src/models/appRelease.ts`): `listForAdmin`, `getLatestEnabled`,
  `add`, `update`, `setLatest`, `remove`.
- Admin API (`src/routes/admin/releases.ts`): CRUD + `set-latest`, permission points
  `VersionView/Create/Edit/Publish/Rollback`.
- `GET /updates/latest` (`src/routes/updates.ts`): `requireAuth`, returns
  `{latest, version, date, changeLog:{zh,en}, macArm?, windowsX64?, macIntel?}`.
- Admin web `VersionsPage.tsx` + `api/releases.ts`: three URL text fields.
- Storage pattern: kit/skill/html-share write to `ENTERPRISE_STATE_DIR`
  (`src/lib/stateDir.ts`) and are served by the `node:http` wrapper in
  `src/server.ts` which **buffers the full request body in memory** before dispatch.
- Desktop: `appUpdateCoordinator.fetchUpdateInfo` → `parseEnterpriseUpdate` →
  `pickPlatformUrl`; `appUpdateInstaller.downloadUpdate(url, source, onProgress)`
  fetches via `session.defaultSession.fetch` with **no auth header**, writes to
  `userData/updates/genwork-update-<source>-<ts>.download` then renames; no Range.
- Windows download URL policy (`appUpdateUrlPolicy.ts`): `.exe` path, https or a
  trusted private origin (the enterprise server URL is trusted via
  `ENTERPRISE_SERVER_URL`), no credentials, no fragment, no non-default port
  unless trusted-private.
- Migration max is `040_kit_catalog.sql` → new migration is `041`.
- Desktop auto-update constants in `src/shared/appUpdate/constants.ts`; IPC in
  `src/main/main.ts`. Desktop i18n in `src/renderer/services/i18n.ts` (already has
  `update*` keys). Admin web i18n is a single `web/src/i18n.ts` with flat `en`/`zh`
  dicts (`page.versions.*`).

## 4. Data model

Migration `041_app_release_installers.sql`:

- `ALTER TABLE app_releases DROP COLUMN downloads;` (decisions: delete external URLs)
- `ALTER TABLE app_releases ADD COLUMN installers JSONB NOT NULL DEFAULT '{}'::jsonb;`

`installers` shape (no Intel):

```json
{
  "macArm":     { "id": "<fileId>", "fileName": "GenWork.dmg",   "fileSize": 123456789, "sha256": "<hex>" },
  "windowsX64": { "id": "<fileId>", "fileName": "GenWork-Setup.exe", "fileSize": 987654321, "sha256": "<hex>" }
}
```

- `id` is a server-minted UUID naming the on-disk file; `fileName` is the original
  basename (kept for display and to preserve the `.dmg`/`.exe` extension for the
  desktop's extension checks); `sha256`/`fileSize` are computed at upload-complete and
  used for integrity checks.
- The `downloads` key is removed from `ReleaseDownloads`/`ReleaseView` types, the
  model, the zod schema, the `/updates/latest` route, and the admin web.

Migration note: `DROP COLUMN` is non-reversible and drops stored data. Per the
decisions this is intended. Backing stores: existing rows' `installers` default to
`{}`, so old versions simply have no installers until re-uploaded; `/updates/latest`
then omits their platform URLs and desktops treat them as "no update" (safe).

`appRelease` model changes:
- `ReleaseDownloads` type → `ReleaseInstallers` (`{macArm?, windowsX64?: InstallerMeta}`).
- `add`/`update` accept `installers` instead of `downloads`.
- New `getInstallerMeta(orgId, fileId): Promise<{orgId, fileSize, sha256, ext} | null>`
  for the download endpoint (resolves a fileId to a release + its metadata).

## 5. Storage

- Directory: `ENTERPRISE_STATE_DIR/release-installers/` (add `releaseInstallerDir()`
  / `releaseInstallerFile(fileId, ext)` helpers in `src/lib/stateDir.ts`).
- Final file: `<fileId><ext>` where `ext` is `.dmg` or `.exe` (from the validated
  platform).
- Upload chunk staging (see §6): `release-installers/.uploads/<uploadId>/` with
  `meta.json` (`{orgId, platform, fileName, expectedSize, ext, chunkIndex}`) and
  per-chunk files `chunk-<index>`.

## 6. Admin upload API (chunked + resumable)

Permission: `VersionCreate` for `init`, `chunks`, and `complete` (one admin is
mid-upload across all three; chunking is idempotent/append so the creating role
suffices). `set-latest` still requires `VersionPublish`. JWT via `requireAuth` +
`requirePermission`.

- `POST /admin/releases/installers/init`
  body: `{ platform: 'macArm' | 'windowsX64', fileName: string, fileSize: number }`.
  Validates `fileName` extension matches platform (arm→`.dmg`, win→`.exe`),
  `fileSize > 0`. Mints `uploadId` (UUID), writes staging dir + `meta.json`.
  Returns `{ uploadId, chunkSize }` (`chunkSize` e.g. 8 MiB, server-chosen).
- `PUT /admin/releases/installers/:uploadId/chunks/:index`
  body: raw chunk bytes. Streams to disk (does **not** read the whole body in
  memory). `index` must be sequential from the last accepted (append) or a replayed
  index (idempotent overwrite of the same index, for resume). Returns
  `{ acceptedIndex, totalAccepted }`.
- `POST /admin/releases/installers/:uploadId/complete`
  Streams all chunks in order into the final `<fileId><ext>` file, computes sha256
  + size, cleans up staging. Returns
  `{ id: fileId, fileName, fileSize, sha256 }`. On size mismatch with the declared
  `expectedSize`, returns 400 `size_mismatch`.

Resume semantics: a client that aborts after `totalAccepted` chunks resumes by
calling `init` again? No — resume re-uses the **same** `uploadId`: the client stores
`uploadId` + `totalAccepted`, and on resume re-issues `PUT` starting at
`totalAccepted`. `init` is only called once per file. (If the browser lost the
`uploadId`, it re-inits; the old staging is GC'd.) Staging GC: `complete` removes it;
a sweep at server start removes staging older than 24h (best-effort).

### Admin web upload flow (`VersionsPage.tsx`)

Replace the three URL text fields with two uploader controls:

- **macOS (Apple Silicon)** `.dmg` and **Windows (x64)** `.exe`.
- Each is a file picker that, on select, runs the chunked upload client
  (`init` → loop `PUT chunks` with progress → `complete`), showing per-file progress
  (bytes/chunks). The completed `InstallerMeta` is held in form state.
- On release **create**: at least one platform's installer must have completed
  before submit (the form expects both; the other can be added later via edit). The
  assembled `installers` object is sent with the create/patch body.
- On release **edit**: existing installers are pre-shown (fileName + size + a
  "replace" button); replacing runs the same uploader.
- List column "installers" shows which platforms are present (e.g. `macOS arm ·
  Win x64`) with file names in the tooltip; replaces the old URL column.
- `set-latest` guard (server): at least one platform present in `installers`, else
  422 `no_installer`. (A version with a release note but no installer cannot be
  published as latest, since there would be nothing to download.)

A small shared client helper `web/src/api/releaseInstallers.ts` encapsulates the
init/chunks/complete loop (reusing `apiClient`'s auth headers) and is used by the
page.

## 7. Download endpoint (resumable, JWT)

`GET /downloads/app-releases/:fileId` (new route `src/routes/releaseDownloads.ts`):
- `requireAuth`; resolve `fileId` → release via `getInstallerMeta`; **404** if not
  found; **403** if the release's `orgId !== claims.orgId` (cross-tenant guard).
- Stream the file with `Content-Type: application/octet-stream`,
  `Content-Disposition: attachment; filename="<fileName>"`,
  `Content-Length`, and **`Accept-Ranges: bytes`** + `Range` handling (206 Partial
  Content with `Content-Range`, 416 for unsatisfiable). Implemented against the file
  fd so large files are not buffered in memory.
- Path ends `.dmg`/`.exe` (from the stored `ext`), so the desktop's
  `pickPlatformUrl` extension checks and the Windows `.exe` policy pass.

This route must be served **without** the in-memory body-buffering wrapper. The
`node:http` handler in `src/server.ts` currently buffers request bodies for
non-GET/HEAD; for a streaming **response** (GET) it also currently
`Buffer.from(await honoRes.arrayBuffer())` the whole response, which would buffer a
hundreds-of-MB file in memory. **Required change:** in that wrapper, when the Hono
response is a stream (or, more simply, when `content-length` exceeds a threshold or
the route opts in), pipe `honoRes.body` directly to `res` via `Readable.fromWeb`
instead of buffering. Scope this carefully (see Risks): only the release-download
route needs true streaming; keep the existing buffered path for all other routes to
avoid regressions.

## 8. `/updates/latest` rewrite

`GET /updates/latest` now maps `installers` → platform URLs instead of `downloads`:

```json
{
  "latest": true,
  "version": "...",
  "date": "...",
  "changeLog": { "zh": {...}, "en": {...} },
  "macArm":     { "url": "<origin>/downloads/app-releases/<fileId>.dmg"   },
  "windowsX64": { "url": "<origin>/downloads/app-releases/<fileId>.exe"  }
}
```

- `<origin>` = `req.url` origin (works behind the reverse proxy via the request URL).
- A platform key is emitted **only** if `installers` has that platform; otherwise it
  is omitted and the desktop's `pickPlatformUrl` returns null for it → "no update"
  for that platform (safe).
- The desktop parser (`parseEnterpriseUpdate`) and coordinator need **no changes**
  for the shape; they keep using `macArmUrl`/`windowsX64Url`.
- **Integrity:** `installers` stores `sha256`/`fileSize`, but the check response keeps
  the existing `{url}` shape and does **not** expose them, so the desktop still
  verifies the download only by `Content-Length` + a self-computed sha256 of the
  completed file (as it does today). The stored hash is for admin display and future
  server-side verification; adding a server-provided hash check to the desktop is
  out of scope this release (the download origin is already the trusted enterprise
  server behind JWT).

## 9. Desktop download: auth + resume

`appUpdateInstaller.downloadUpdate(url, source, onProgress, { authToken? })`:

- **Auth:** when `authToken` is provided, set `Authorization: Bearer <token>` on the
  fetch. `appUpdateCoordinator.startDownload` passes `sessionStorage.load()?.jwt`.
- **Resume:** keep the current `.download` partial file. On start, if a partial file
  exists for this flow, send `Range: bytes=<received>-` and expect 206; append to the
  existing file (open the write stream in append mode, `fs.appendFile`/
  `createWriteStream({flags:'a'})`). On 200 (server ignores Range), reset `received=0`
  and truncate. `received` for progress is `existingBytes + streamedBytes`.
  - Partial file must be the **same flow's** file: key it by the existing
    `genwork-update-<source>-<ts>` naming; if a previous `.download` exists for the
    same source+version, resume it; else start fresh. Simpler robust rule: at the
    start of a download for a given `(source, latestVersion)`, look for the most
    recent `.download` file for that source whose recorded target matches; resume
    it, otherwise create new. (Exact file-discovery rule is an implementation detail;
    the invariant is: never lose a valid partial, never resume a partial of a
    different version.)
- Keep the existing inactivity timeout, cancel, size/`Content-Length` validation,
  sha256-on-completion, and rename-to-final logic. For a 206, validate the final
  size against the **total** declared length, and the completion sha256 against the
  **full** file (now that it's complete).

`appUpdateCoordinator` already persists the ready file + hash; no model change. The
only new behavior is threaded into `downloadUpdate`. The Windows URL policy is
unchanged (URLs still end in `.exe`, enterprise origin is trusted).

Desktop auto-update UX (modal, release note, install) is unchanged.

## 10. i18n

Admin web `web/src/i18n.ts` (`page.versions.*`), en + zh:
- Remove `downloadsMacIntel/MacArm/WindowsX64`.
- Add: `uploadMacArm`, `uploadWindowsX64`, `installerPresent`, `installerReplace`,
  `uploading`, `uploadComplete`, `noInstallerForLatest`, `uploaderErrors.*`
  (too_large / size_mismatch / network), `columnInstallers`.

Desktop i18n (`src/renderer/services/i18n.ts`) — no new keys needed (existing
`update*` keys cover detect/note/download/install); resume is transparent to the
user.

## 11. Testing

Server (per-file runs, per AGENTS.md fd-limit note):
- Migration `041`: applies idempotently; `downloads` gone, `installers` present.
- `appRelease`: add/update/get with `installers`; cross-org `getInstallerMeta` returns
  null.
- Upload: init validates extension/size; chunk append is sequential + idempotent
  replay; complete streams to final file, correct sha256/size, GCs staging;
  size_mismatch on under-delivery.
- Download: 200 with correct headers + bytes; 206 with Range; 416 unsatisfiable;
  404 unknown id; 403 cross-org.
- `/updates/latest`: emits `macArm`/`windowsX64` URLs only when installers exist;
  origin correct; omits missing platforms.

Desktop (`appUpdateInstaller.test.ts` / `appUpdateCoordinator.test.ts`):
- `downloadUpdate` sends `Authorization` when `authToken` given; omits it otherwise.
- Resume: with an existing partial + a 206 response, the final file is the correct
  concatenation and progress reflects the pre-existing bytes; a 200 response resets.

Web:
- `VersionsPage`: uploader renders two controls; completed metadata is included in
  the create/patch body; list column shows present platforms; i18n keys resolve.

Lint gate: every touched TS/TSX file passes
`npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>`.

## 12. Risks / open items

- **`node:http` streaming change** (§7): the wrapper buffers full responses today.
  Changing it to pipe stream responses affects *all* routes if done globally. Mitigation:
  gate on a per-response opt-in (e.g. only stream when `Accept-Ranges`/a marker header
  is present) or on `content-length` above a threshold, and keep the buffered path as
  default. Must be verified against the existing SPA/static/JSON routes with tests.
  This is the highest-risk change in the spec.
- **Large-body request buffering** (§6): the wrapper buffers non-GET bodies; chunked
  upload keeps each request body to one chunk (≤ `chunkSize`), so this stays bounded
  — no wrapper change needed for upload. Confirm `chunkSize` stays well under any
  reverse-proxy body limit.
- **JWT expiry during a long download** (§9): a very large download that outlives the
  JWT would 401 and require a retry (resume picks up where it left off, so this is
  recoverable). Token refresh mid-download is out of scope this release.
- **Reverse proxy / CDN limits** for large uploads: chunked upload mitigates;
  `chunkSize` must be sized for the deployment's proxy limits (default 8 MiB,
  documented, env-overridable).
- **Existing published releases**: after `DROP COLUMN downloads`, any previously
  published version has no installer and won't be downloadable until re-uploaded.
  Admins must re-upload installers for the version they intend to keep serving.
  (Documented in the admin help/README.)

## 13. Out of scope

- macOS Intel builds (explicitly not provided).
- Publisher-signing / Authenticode verification of installers (separate concern,
  already out of scope for the URL policy).
- Token refresh mid-download.
- Multi-org installer sharing or cross-org distribution.
