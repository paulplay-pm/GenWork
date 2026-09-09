import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the on-disk directory for runtime state.
 *
 * Production uses ENTERPRISE_STATE_DIR (set by the deployer). Tests and
 * dev fall back to <os.tmpdir>/enterprise-server so each process gets a
 * fresh tree. The directory is created lazily on first call.
 */
const _stateDir = ((): string => {
  const explicit = process.env.ENTERPRISE_STATE_DIR;
  const dir = explicit && explicit.trim().length > 0
    ? explicit
    : join(tmpdir(), 'enterprise-server');
  mkdirSync(dir, { recursive: true });
  return dir;
})();

export function stateDir(): string {
  return _stateDir;
}

export function htmlShareDir(shareId: string): string {
  return join(_stateDir, 'html-shares', shareId);
}

export function skillStoreDir(skillId: string): string {
  return join(_stateDir, 'skill-marketplace', skillId);
}

export function kitStoreDir(kitId: string): string {
  return join(_stateDir, 'kit-marketplace', kitId);
}

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

/** Per-connection SSO logo upload directory. Each connection may store
 *  one logo file (`<connectionId>.<ext>`); the row's `logo_url` column
 *  points at `/sso-logos/uploads/<connectionId>.<ext>` and the Hono
 *  static-serve route under `server.ts` serves it. */
export function ssoLogoUploadDir(): string {
  return join(_stateDir, 'sso-logos', 'uploads');
}

/** On-disk path for a single SSO connection's uploaded logo. */
export function ssoLogoFile(connectionId: string, ext: string): string {
  return join(ssoLogoUploadDir(), `${connectionId}${ext}`);
}

/**
 * Enumerate every staging upload directory under the on-disk release installer
 * root). Missing or freshly-created trees yield an empty list — the caller's
 * `sweepStaleReleaseUploads` short-circuits on that.
 */
export function releaseInstallerUploadDirs(): string[] {
  const root = join(releaseInstallerDir(), '.uploads');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

/**
 * Best-effort sweep of stale chunked-upload staging directories (Spec §6).
 * Removes any `<releaseInstallerDir>/.uploads/<uploadId>/` whose mtime is
 * older than `maxAgeMs`. Also `rm -rf`s any `chunk-*` files inside the
 * scanned directories so a half-finished upload cannot leave litter behind
 * even when the sweep itself decides not to remove the parent dir.
 *
 * Returns the number of dirs removed. The call site (`src/server.ts start()`)
 * treats the call as best-effort: failures are swallowed + logged.
 */
export async function sweepStaleReleaseUploads(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const dirs = releaseInstallerUploadDirs();
  if (dirs.length === 0) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const dir of dirs) {
    try {
      const st = statSync(dir);
      if (st.mtimeMs >= cutoff) continue;
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Permission error / race: skip this dir and try the next.
    }
  }
  return removed;
}
