import { useCallback, useEffect, useState } from 'react';

import { meApi, type MeProfile } from '../api/me';
import { useAuth } from './useAuth';

export interface UseMeResult {
  /** The fetched `/me` profile, or null until it resolves (or if it failed). */
  profile: MeProfile | null;
  loading: boolean;
  /** Whether the initial fetch failed (the UI degrades to the JWT `sub`). */
  error: boolean;
  /** Persist a new display name (PATCH /me) and update local state. */
  saveDisplayName: (displayName: string) => Promise<void>;
}

/**
 * Session-scoped `/me` profile cache. `useMe` is consumed by several
 * components at once (the sidebar's `UserMenu` and pages via
 * `usePermissions`); without a shared cache, every mount would issue its own
 * `GET /me`. The cache is keyed by the session token: a different token (a new
 * login) must refetch. It is cleared on logout and refreshed by
 * `saveDisplayName`.
 */
let cachedProfile: MeProfile | null = null;
let cachedToken: string | null = null;
/** In-flight request, shared by consumers that mount before it settles. */
let inflight: Promise<MeProfile> | null = null;

/** Drop the cached profile (called on logout, so the next login refetches). */
export function clearMeProfileCache(): void {
  cachedProfile = null;
  cachedToken = null;
  inflight = null;
}

/**
 * Fetch the current user's profile (`/me`) once per session. The JWT only
 * carries `sub` (the user ID), so a real username / display name requires this
 * call. A failure is non-fatal: the caller falls back to `sub`, so the
 * sidebar never goes blank. `saveDisplayName` refreshes the local profile in
 * place.
 *
 * The request is issued one tick after mount: `/me` is a non-critical profile
 * call, and deferring it keeps the page's own data queries (issued by their
 * observers at subscribe time) ahead of it in the request queue. When a
 * profile is already cached for the current token, the fetch is skipped
 * entirely and the cache is returned synchronously.
 */
export function useMe(): UseMeResult {
  const { token } = useAuth();
  const [profile, setProfile] = useState<MeProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setLoading(false);
      return;
    }
    if (cachedProfile && cachedToken === token) {
      setProfile(cachedProfile);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      // The cache may have been filled since the effect ran (another
      // consumer's timer fired first and its response already landed —
      // guaranteed with instant/mock responses) — reuse it instead of
      // refetching.
      if (cachedProfile && cachedToken === token) {
        setProfile(cachedProfile);
        setLoading(false);
        return;
      }
      // Share one in-flight request across consumers that mounted before the
      // first response landed, so a session issues a single GET /me.
      const pending = inflight ?? meApi.getMe();
      if (!inflight) inflight = pending;
      pending
        .then((me) => {
          // Cache regardless of `cancelled`: the profile is valid for the
          // whole session, other consumers will want it.
          cachedProfile = me;
          cachedToken = token;
          if (!cancelled) setProfile(me);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        })
        .finally(() => {
          if (inflight === pending) inflight = null;
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token]);

  const saveDisplayName = useCallback(async (displayName: string): Promise<void> => {
    const updated = await meApi.updateDisplayName(displayName);
    // PATCH /me returns only the identity fields — merge onto the shared
    // profile so the fine permission points and data scope are preserved,
    // and refresh the cache so other consumers see the new display name.
    const base: MeProfile =
      cachedProfile ?? { username: '', display_name: null, permissions: [], effectiveDataScope: '' };
    const merged: MeProfile = {
      ...base,
      username: updated.username,
      display_name: updated.display_name,
    };
    cachedProfile = merged;
    setProfile(merged);
  }, []);

  return { profile, loading, error, saveDisplayName };
}
