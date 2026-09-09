import { apiClient } from './client';

/** The subset of the `/me` row the SPA uses. The server (src/routes/me.ts)
 * returns this plus `id`, `timezone`, `dept_path`, `effective_roles`,
 * `org_id`, and `concurrentDeptPaths`. `permissions` is the union of the
 * caller's fine permission points (the JWT claims only carry coarse roles);
 * `effectiveDataScope` is the coarse data-scope axis. */
export interface MeProfile {
  username: string;
  display_name: string | null;
  /** Union of the caller's fine permission points (e.g. 'dept:edit'). */
  permissions: string[];
  /** Coarse data-scope axis the caller operates under: 'all' | 'self' | 'dept'. */
  effectiveDataScope: string;
}

/** `PATCH /me` accepts only a display name (enforced server-side by zod). */
export interface MePatchResponse {
  username: string;
  display_name: string | null;
  org_id: string;
}

export const meApi = {
  getMe: () => apiClient.get<MeProfile>('/me'),
  updateDisplayName: (displayName: string) =>
    apiClient.patch<MePatchResponse>('/me', { displayName }),
};
