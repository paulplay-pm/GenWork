import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Stale OpenClaw gateway lock cleanup.
 *
 * OpenClaw's gateway holds a single-instance lock file at
 * `<tmpdir>/openclaw[-<uid>]/gateway.<sha256(configPath)[:8]>.lock` (see
 * OpenClaw v2026.6.1 src/infra/gateway-lock.ts). The payload is JSON:
 * `{ pid, createdAt, configPath, startTime? }`.
 *
 * When GenWork force-kills the gateway (Windows SIGTERM is
 * TerminateProcess), the kill can land between the lock file's create and
 * payload write, leaving an EMPTY lock file behind. OpenClaw treats an
 * unreadable payload as owner "unknown" and only reclaims it after a 30s
 * mtime staleness window — while its own acquire timeout is 5s — so every
 * respawn within those 30s fails with "gateway already running; lock
 * timeout". GenWork is the gateway's only supervisor, so whenever it knows
 * it has no live gateway child it can safely reclaim locks whose owner is
 * dead or whose payload is unreadable.
 */

export type GatewayLockPayload = {
  pid: number;
  createdAt?: string;
  configPath?: string;
};

export const GatewayLockCleanupAction = {
  RemovedUnreadable: 'removed-unreadable',
  RemovedDeadOwner: 'removed-dead-owner',
  KeptAliveOwner: 'kept-alive-owner',
  RemoveFailed: 'remove-failed',
} as const;
export type GatewayLockCleanupAction =
  typeof GatewayLockCleanupAction[keyof typeof GatewayLockCleanupAction];

export type GatewayLockCleanupResult = {
  lockPath: string;
  action: GatewayLockCleanupAction;
  ownerPid?: number;
};

const GATEWAY_LOCK_FILE_RE = /^gateway\.[0-9a-f]{8}\.lock$/;

/** Mirrors OpenClaw v2026.6.1 resolveGatewayLockDir(). */
export function resolveGatewayLockDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const suffix = uid != null ? `openclaw-${uid}` : 'openclaw';
  return path.join(os.tmpdir(), suffix);
}

/**
 * Mirrors OpenClaw v2026.6.1 resolveGatewayLockPath(): the gateway resolves
 * OPENCLAW_CONFIG_PATH through resolveUserPath() which is path.resolve() for
 * absolute paths, then hashes the resolved string.
 */
export function resolveGatewayLockPathForConfig(configPath: string, lockDir = resolveGatewayLockDir()): string {
  const resolved = path.resolve(configPath.trim());
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return path.join(lockDir, `gateway.${hash}.lock`);
}

function normalizePathForCompare(input: string): string {
  const resolved = path.resolve(input.trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function parseGatewayLockPayload(raw: string): GatewayLockPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const pid = (parsed as { pid?: unknown }).pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    const configPath = (parsed as { configPath?: unknown }).configPath;
    return {
      pid,
      ...(typeof configPath === 'string' ? { configPath } : {}),
    };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type CleanupOptions = {
  configPath: string;
  /** Override for tests; defaults to the OpenClaw lock directory. */
  lockDir?: string;
  /** Override for tests. */
  isPidAliveFn?: (pid: number) => boolean;
};

function removeLockFile(
  lockPath: string,
  action: typeof GatewayLockCleanupAction.RemovedUnreadable | typeof GatewayLockCleanupAction.RemovedDeadOwner,
  ownerPid?: number,
): GatewayLockCleanupResult {
  try {
    fs.rmSync(lockPath, { force: true });
    return { lockPath, action, ...(ownerPid != null ? { ownerPid } : {}) };
  } catch {
    return { lockPath, action: GatewayLockCleanupAction.RemoveFailed, ...(ownerPid != null ? { ownerPid } : {}) };
  }
}

/**
 * Reclaim stale gateway lock files for our config path.
 *
 * MUST only be called when the caller knows it has no live gateway child of
 * its own (before spawning a gateway, or right after confirming the previous
 * one exited). A lock whose payload is readable and whose owner pid is alive
 * is never touched.
 *
 * Two matching strategies:
 * - The exact lock path for our configPath (hash replica). An unreadable
 *   payload here is reclaimed: only our own gateway can legitimately own it,
 *   and the caller guarantees no such process is starting right now.
 * - Any other `gateway.*.lock` in the directory whose readable payload points
 *   at our configPath with a dead owner (guards against hash-input drift).
 *   Unreadable payloads under other hashes are left alone — they may belong
 *   to a user-run OpenClaw CLI with a different config.
 */
export function cleanupStaleGatewayLocks(options: CleanupOptions): GatewayLockCleanupResult[] {
  const lockDir = options.lockDir ?? resolveGatewayLockDir();
  const pidAlive = options.isPidAliveFn ?? isPidAlive;
  const results: GatewayLockCleanupResult[] = [];
  const ownLockPath = resolveGatewayLockPathForConfig(options.configPath, lockDir);
  const ownConfigKey = normalizePathForCompare(options.configPath);

  let entries: string[];
  try {
    entries = fs.readdirSync(lockDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!GATEWAY_LOCK_FILE_RE.test(entry)) {
      continue;
    }
    const lockPath = path.join(lockDir, entry);
    const isOwnLock = lockPath === ownLockPath;

    let raw: string | null = null;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch {
      // Unreadable file handle: treat like an unreadable payload below.
      raw = null;
    }
    const payload = raw != null ? parseGatewayLockPayload(raw) : null;

    if (!payload) {
      if (isOwnLock) {
        results.push(removeLockFile(lockPath, GatewayLockCleanupAction.RemovedUnreadable));
      }
      continue;
    }

    const matchesOurConfig = isOwnLock
      || (payload.configPath != null && normalizePathForCompare(payload.configPath) === ownConfigKey);
    if (!matchesOurConfig) {
      continue;
    }

    if (pidAlive(payload.pid)) {
      results.push({ lockPath, action: GatewayLockCleanupAction.KeptAliveOwner, ownerPid: payload.pid });
      continue;
    }
    results.push(removeLockFile(lockPath, GatewayLockCleanupAction.RemovedDeadOwner, payload.pid));
  }

  return results;
}
