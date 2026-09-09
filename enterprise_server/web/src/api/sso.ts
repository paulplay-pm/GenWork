// web/src/api/sso.ts
// SSO federation admin + public routes. Admin endpoints are org-scoped by the
// token's `claims.orgId` (the server scopes the list by the token — no
// `?orgId` on `list()`), gated on the `sso:*` permission points. The public
// providers endpoint is consumed by the login page (T17).
import type { SsoConnection, SsoConnectionInput, SsoPublicProvider } from '../pages/sso/types';
import { apiClient, ApiError } from './client';

/** `GET /admin/users/:id/sso-binding` body (200) — null when the user has no
 *  SSO binding; 404 for cross-org / missing user (callers should treat 404 as
 *  null/unbound). */
export interface SsoBinding {
  connectionId: string;
  connectionName: string;
  providerType: string;
  externalId: string;
}

/** `GET /admin/sso-connections/:id/bindings` row. */
export interface SsoBindingListItem {
  userId: string;
  username: string;
  displayName: string | null;
  externalId: string;
}

/** `POST /me/sso-binding/start` body + response. */
export interface SsoBindingStartResponse {
  authorizeUrl: string;
}

export const ssoApi = {
  list: () => apiClient.get<SsoConnection[]>('/admin/sso-connections'),
  get: (id: string) => apiClient.get<SsoConnection>(`/admin/sso-connections/${id}`),
  create: (input: SsoConnectionInput) => apiClient.post<{ id: string }>('/admin/sso-connections', input),
  patch: (id: string, patch: Partial<SsoConnectionInput>) => apiClient.patch<{ ok: boolean }>(`/admin/sso-connections/${id}`, patch),
  disable: (id: string) => apiClient.delete<{ ok: true }>(`/admin/sso-connections/${id}`),
  providers: (orgName: string) =>
    apiClient.get<{ providers: SsoPublicProvider[] }>(`/auth/sso/providers?orgName=${encodeURIComponent(orgName)}`),
  /** Upload a per-connection logo (PNG / JPEG / WEBP / SVG, ≤ 1 MB). The
   *  server stores the file at <stateDir>/sso-logos/uploads/<id>.<ext>
   *  and returns the server-relative path the public endpoint resolves
   *  to an absolute <img src> URL. */
  uploadLogo: async (id: string, file: File): Promise<{ logoUrl: string }> => {
    const form = new FormData();
    form.append('logo', file, file.name);
    return apiClient.postRaw<{ logoUrl: string }>(`/admin/sso-connections/${id}/logo`, form);
  },
  /** Clear the per-connection logo so the public endpoint falls back to
   *  the built-in default for the provider type. Idempotent. */
  clearLogo: (id: string) => apiClient.delete<{ ok: boolean }>(`/admin/sso-connections/${id}/logo`),
  // --- User-driven SSO self-binding (T7-T9 frontend) ---
  /** Start the user-driven binding flow for the calling user. The backend
   *  parks a `self_binding` context keyed by `state`; the subsequent
   *  `/auth/sso/callback` (after the IdP dance) resolves it and writes the
   *  `users.sso_*` columns. `extra_roles` is preserved (T7 R=6 fix). */
  startMyBinding: (connectionId: string) =>
    apiClient.post<SsoBindingStartResponse>('/me/sso-binding/start', { connectionId }),
  /** Drop the calling user's own SSO binding. No-op on the server when the
   *  user is unbound. */
  deleteMyBinding: () => apiClient.delete<{ ok: true }>('/me/sso-binding'),
};

/** Admin read + unbind for user-driven bindings (T8 frontend). The "get" call
 *  returns `null` when the user has no binding. A 404 (cross-org / missing
 *  user) is normalized to `null` here so the UI can render "Unbound" without
 *  surfacing a permission/forbidden error. */
export async function getUserSsoBinding(userId: string): Promise<SsoBinding | null> {
  try {
    return await apiClient.get<SsoBinding | null>(
      `/admin/users/${encodeURIComponent(userId)}/sso-binding`
    );
  } catch (e: unknown) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Every user currently bound to a given SSO connection (T8 frontend). */
export function getConnectionBindings(connectionId: string): Promise<SsoBindingListItem[]> {
  return apiClient.get<SsoBindingListItem[]>(
    `/admin/sso-connections/${encodeURIComponent(connectionId)}/bindings`
  );
}

/** Admin-only force-unbind: clears `users.sso_*` and writes an audit entry
 *  (gated server-side on `sso:edit`). */
export function adminDeleteUserSsoBinding(userId: string): Promise<{ ok: true }> {
  return apiClient.delete<{ ok: true }>(
    `/admin/users/${encodeURIComponent(userId)}/sso-binding`
  );
}
