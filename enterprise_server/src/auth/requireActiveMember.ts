import type { MiddlewareHandler } from 'hono';

import { pool } from '../db/pool';
import { ProviderProxyWireError } from '../shared/enterpriseServerConstants';
import { type Claims, verifyToken } from './jwt';

declare module 'hono' {
  interface ContextVariableMap {
    claims: Claims;
  }
}

/**
 * LLM-proxy membership gate.
 *
 * `requireAuth` only proves the bearer token verifies (HS256, stateless). A
 * member whose `users.status` has been flipped to `disabled` — or whose row
 * was deleted — still holds a signed, unexpired JWT and would sail through
 * `requireAuth`; and because `/auth/refresh` re-signs without checking status,
 * the desktop's proactive refresh would keep renewing that JWT forever. This
 * middleware is what actually bounces a revoked member.
 *
 * It is a SEPARATE middleware applied only to the `/proxy/*` routes, not a DB
 * query inside `requireAuth`: `requireAuth` is shared by ~20 non-LLM routes
 * (`/me`, `/models`, `/usage`, admin, …) and this is the one place the
 * per-request cost matters (every LLM turn). The status lookup is a
 * `users.id` PRIMARY KEY point query, and a short TTL cache keeps it off the
 * hot path for repeat calls within a window. The cache is a bounded
 * enforcement delay, not a correctness hole: a newly-disabled member is
 * bounced on their next request once the TTL lapses (≤ 30s).
 */
type MemberStatusResult =
  | { kind: 'missing' }        // row gone → revoked / not a member
  | { kind: 'status'; status: string } // row present, with its status
  | { kind: 'error' };         // DB read failed → fail open, do not revoke

const MEMBER_STATUS_TTL_MS = 30_000;
const memberStatusCache = new Map<string, { value: MemberStatusResult; at: number }>();

function cacheFresh(
  userId: string,
  now: number,
): { kind: 'missing' } | { kind: 'status'; status: string } | { kind: 'error' } | null {
  const cached = memberStatusCache.get(userId);
  if (cached && now - cached.at < MEMBER_STATUS_TTL_MS) {
    return cached.value;
  }
  return null;
}

async function resolveMemberStatus(userId: string): Promise<MemberStatusResult> {
  const now = Date.now();
  const cached = cacheFresh(userId, now);
  if (cached) return cached;

  let result: MemberStatusResult;
  try {
    const r = await pool.query<{ status: string }>(
      `SELECT status FROM users WHERE id = $1`,
      [userId],
    );
    const status = r.rows[0]?.status ?? null;
    result = status === null ? { kind: 'missing' } : { kind: 'status', status };
  } catch {
    // Fail-open: a transient DB problem must surface as a normal proxy error
    // (and be investigated there), not as a 401 the desktop would read as
    // "revoked" and use to kick an innocent user out.
    result = { kind: 'error' };
  }
  // Cache every outcome, including 'error': a fresh TTL on the error path keeps
  // a flapping DB from stampeding on every LLM turn.
  memberStatusCache.set(userId, { value: result, at: now });
  return result;
}

/**
 * Bearer-auth + active-member gate for the LLM proxy. Emits the distinct
 * `{ error: 'not_member' }` 401 a revoked member sees — which the desktop maps
 * to a membership revocation — as opposed to the generic `unauthorized` a
 * merely-expired or invalid token sees.
 */
export const requireActiveMember: MiddlewareHandler = async (c, next) => {
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

  const status = await resolveMemberStatus(claims.sub);
  if (status.kind === 'missing') {
    return c.json({ error: ProviderProxyWireError.NotMember }, 401);
  }
  if (status.kind === 'status' && status.status !== 'active') {
    return c.json({ error: ProviderProxyWireError.NotMember }, 401);
  }
  // 'active' or 'error' (fail-open) → proceed to the handler.
  await next();
};

// Test helper: clear the status cache between cases so a re-seeded user with a
// changed status is re-read rather than served from a stale TTL entry.
export function _resetRequireActiveMemberCacheForTest(): void {
  memberStatusCache.clear();
}
