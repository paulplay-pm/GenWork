import { apiClient } from './client';

export interface AuditEvent {
  id: string;
  ts: string;
  user_id: string | null;
  target_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: unknown;
}

export const auditApi = {
  list: (params: {
    orgId: string;
    userId?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) => {
    const q = new URLSearchParams({ orgId: params.orgId });
    if (params.userId) q.set('userId', params.userId);
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    if (params.limit) q.set('limit', String(params.limit));
    return apiClient.get<AuditEvent[]>(`/admin/audit?${q.toString()}`);
  },
  exportCsv: async (params: { orgId: string; userId?: string; from?: string; to?: string }) => {
    const q = new URLSearchParams({ orgId: params.orgId, format: 'csv' });
    if (params.userId) q.set('userId', params.userId);
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    return apiClient.getRaw(`/admin/audit?${q.toString()}`);
  },
};