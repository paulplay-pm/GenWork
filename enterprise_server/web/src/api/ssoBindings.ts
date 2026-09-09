import type { SsoConnectionWithBinding } from '../pages/account/types';
import { apiClient } from './client';

export async function fetchSsoBindings(): Promise<SsoConnectionWithBinding[]> {
  const j = await apiClient.get<{ connections: SsoConnectionWithBinding[] }>('/me/sso-binding/connections');
  return j.connections;
}

export interface SsoBindingStartResponse {
  authorizeUrl: string;
}

/** Start the user-driven SSO binding flow for the calling user. The backend
 *  parks a `self_binding` context keyed by `state`; the IdP's authorize
 *  redirect resolves at `redirectUri` and the subsequent callback writes the
 *  `users.sso_*` columns. `returnTarget: 'web'` tells the backend that the
 *  post-bind redirect should land on the web SPA's `/auth/sso/bind-callback`
 *  instead of the desktop deep-link. */
export async function startSsoBinding(connectionId: string): Promise<SsoBindingStartResponse> {
  return apiClient.post<SsoBindingStartResponse>('/me/sso-binding/start', {
    connectionId,
    returnTarget: 'web',
  });
}

export async function unbindSsoBinding(): Promise<{ ok: true }> {
  return apiClient.delete<{ ok: true }>('/me/sso-binding');
}