import { apiClient } from './client';
import type { LoginRequest, LoginResponse, OrgsResponse } from './types';

export const authApi = {
  login: (body: LoginRequest) => apiClient.post<LoginResponse>('/auth/login', body),
  refresh: () => apiClient.post<LoginResponse>('/auth/refresh'),
  // Public list of orgs; SPA calls it on /login mount to decide whether
  // to render the org selector (≥2 orgs) or hide it (exactly 1).
  listOrgs: () => apiClient.get<OrgsResponse>('/auth/orgs'),
  changePassword: (currentPassword: string, newPassword: string) =>
    apiClient.post<{ ok: true }>('/auth/change-password', {
      currentPassword,
      newPassword,
    }),
  // Clears the browser session cookie (HttpOnly, so the SPA cannot clear it
  // itself). Used on logout so org-restricted share pages stop authorizing
  // this browser.
  logout: () => apiClient.post<{ ok: true }>('/auth/logout'),
};