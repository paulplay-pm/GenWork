// Enterprise JWT self-heal for the enterprise-direct LLM path.
//
// Plan models (genwork-server) route straight at the enterprise server with the
// user's JWT baked into the OpenClaw config and the dsh engine environment. The
// enterprise JWT is short-lived (~1h) and, unlike the consumer token, cannot be
// refreshed after it has already expired — the /auth/refresh endpoint requires
// the current (still-valid) token to verify. So we must rotate it proactively
// while it is still valid.
//
// This module owns the single-flight refresh decision and the "apply" fan-out
// (re-sync the OpenClaw config with the new JWT + re-spawn the idle dsh engine
// so it bakes the fresh key). It stays Electron-free: callers inject the
// collaborators, which keeps it unit-testable without Electron or a live
// enterprise server.

import type { Session } from '../auth/sessionStorage';

export type EnterpriseJwtRefreshStatus =
  | 'refreshed'
  | 'not-due'
  | 'not-logged-in'
  | 'jwt-expired'
  | 'refresh-failed';

export type EnterpriseJwtRefreshResult = { status: EnterpriseJwtRefreshStatus };

export interface EnterpriseJwtRefreshDeps {
  /** Current session, or null when logged out. */
  getSession: () => Session | null;
  /** Rotate the enterprise JWT (POST /auth/refresh with the current token). */
  refresh: () => Promise<{ token: string }>;
  /** Persist the rotated session (jwt + expiresAt). */
  persistSession: (session: Session) => void;
  /** Re-render + deliver the OpenClaw config so the gateway hot-loads the new JWT. */
  applyConfig: () => Promise<unknown>;
  /** Re-spawn the idle dsh engine so it bakes the refreshed plan credential. */
  refreshPlanCredential: () => void;
  now?: () => number;
  /** Refresh when the JWT expires within this window (ms). */
  refreshWindowMs?: number;
}

// Rotate well before the 1h lifetime lapses so the refresh never races expiry.
const DEFAULT_REFRESH_WINDOW_MS = 10 * 60 * 1000;

// Single-flight: coalesce concurrent triggers (the periodic refresher, a
// reactive recovery, and a config sync can all fire around the same 401).
let inFlight: Promise<EnterpriseJwtRefreshResult> | null = null;

/**
 * Decode the `exp` claim (seconds) from a JWT without verifying it. Returns
 * null when the payload is absent or unparseable.
 */
export function readJwtExpMs(jwt: string): number | null {
  const segments = jwt.split('.');
  if (segments.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString()) as { exp?: number };
    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Rotate the enterprise JWT when the stored session is within the refresh
 * window (and still valid). Single-flight: concurrent calls share one
 * in-flight refresh. Returns a status rather than throwing:
 *  - `refreshed`       — the JWT was rotated and applied.
 *  - `not-due`         — the JWT is still fresh; nothing to do (a no-op).
 *  - `not-logged-in`   — no session; caller should surface the login gate.
 *  - `jwt-expired`     — the stored JWT is already past expiry and cannot be
 *                        rotated (the refresh endpoint re-verifies it); the
 *                        caller should fall through to re-login.
 *  - `refresh-failed`  — the refresh request failed; caller keeps the generic
 *                        copy and the next trigger retries.
 */
export function refreshEnterpriseJwtIfDue(deps: EnterpriseJwtRefreshDeps): Promise<EnterpriseJwtRefreshResult> {
  if (inFlight) return inFlight;

  const now = deps.now ?? Date.now;
  const refreshWindowMs = deps.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;

  const run = async (): Promise<EnterpriseJwtRefreshResult> => {
    const session = deps.getSession();
    if (!session || !session.jwt) return { status: 'not-logged-in' };

    const exp = readJwtExpMs(session.jwt);
    // An already-expired JWT cannot be rotated — the refresh endpoint would
    // reject the stale token. Report that so the caller falls through to
    // re-login rather than attempting a doomed refresh.
    if (exp !== null && exp <= now()) return { status: 'jwt-expired' };

    // Only refresh when the window is actually closing. `exp` null (an
    // unparseable claim) is treated as due so a skewed token still rotates
    // rather than 401ing downstream.
    const due = exp === null || exp - now() <= refreshWindowMs;
    if (!due) return { status: 'not-due' };

    try {
      const { token } = await deps.refresh();
      if (!token || token === session.jwt) {
        // No new material to apply (the server echoed the same token).
        return { status: 'not-due' };
      }
      const newExp =
        readJwtExpMs(token)
        ?? (exp !== null ? exp + refreshWindowMs : now() + refreshWindowMs);
      deps.persistSession({ ...session, jwt: token, expiresAt: newExp });

      // Fan out to the two consumers that bake the JWT: the OpenClaw config
      // (hot-delivery, with the existing deferred-restart fallback if the RPC
      // path is unavailable) and the dsh engine (idle-gated re-spawn).
      await deps.applyConfig();
      deps.refreshPlanCredential();
      return { status: 'refreshed' };
    } catch {
      return { status: 'refresh-failed' };
    }
  };

  const promise = run().finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  inFlight = promise;
  return promise;
}

// Test helper: clear the single-flight latch between cases.
export function _resetEnterpriseJwtRefreshForTest(): void {
  inFlight = null;
}
