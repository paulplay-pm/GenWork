import { apiClient } from './client';

export interface ProviderKeyView {
  id: string;
  provider: string;
  endpoint: string | null;
  label: string | null;
  enabled: boolean;
  region: 'china' | 'global' | null;
  default_base_url: string | null;
  website: string | null;
  description: string | null;
  api_key_masked: string | null;
  status: 'unknown' | 'connected' | 'failed';
  latency_ms: number | null;
  last_test_at: string | null;
  created_at: string;
  /** True for the 9 PRD built-in providers (migration 031). Built-ins cannot be deleted. */
  is_builtin: boolean;
  /** Wire protocol the endpoint speaks (migration 031). */
  protocol: 'openai' | 'anthropic';
  /** "Coding Plan" (beta) flag (migration 034): on → the Base URL uses the
   * provider's coding-specific endpoint. */
  coding_plan: boolean;
}

export const providersApi = {
  list: (orgId: string) =>
    apiClient.get<ProviderKeyView[]>(`/admin/provider-keys?orgId=${encodeURIComponent(orgId)}`),
  add: (input: {
    orgId: string;
    provider: string;
    /** Optional for built-ins (no key needed); required in practice for custom providers. */
    apiKey?: string;
    label?: string;
    endpoint?: string;
    region?: 'china' | 'global';
    defaultBaseUrl?: string;
    website?: string;
    protocol?: 'openai' | 'anthropic';
    /** "Coding Plan" (beta) flag; on → the Base URL uses the coding endpoint. */
    codingPlan?: boolean;
  }) => apiClient.post<{ id: string }>('/admin/provider-keys', input),
  setEnabled: (id: string, enabled: boolean) =>
    apiClient.post<{ ok: true }>(
      `/admin/provider-keys/${id}/${enabled ? 'enable' : 'disable'}`
    ),
  refreshModels: (id: string) =>
    apiClient.post<{
      added: number;
      unchanged: number;
      upstreamCount?: number;
      skipped?: 'unsupported_provider';
      error?: 'invalid_api_key' | 'upstream_error' | 'upstream_timeout' | 'empty_endpoint';
      detail?: string;
    }>(`/admin/provider-keys/${id}/refresh-models`),
  patch: (
    id: string,
    body: {
      description?: string | null;
      baseUrl?: string | null;
      label?: string | null;
      enabled?: boolean;
      protocol?: 'openai' | 'anthropic';
      /** "Coding Plan" (beta) flag; on → the Base URL uses the coding endpoint. */
      codingPlan?: boolean;
      /** Replace the API key; omit to keep the current one. */
      apiKey?: string;
    }
  ) => apiClient.patch<{ ok: true }>(`/admin/provider-keys/${id}`, body),
  remove: (id: string) =>
    apiClient.delete<{ ok: true; deletedModels: number }>(
      `/admin/provider-keys/${id}`
    ),
  test: (id: string) =>
    apiClient.post<{
      status: 'connected' | 'failed';
      latencyMs: number;
      lastTestAt: string;
    }>(`/admin/provider-keys/${id}/test`),
};