import { apiClient } from './client';
import { departmentsApi } from './departments';
import { usersApi } from './users';

export type AuthMode6 = 'none' | 'shared-key' | 'user-key' | 'user-oauth' | 'client-creds' | 'sso';
export type Transport2 = 'http' | 'sse';
export interface ConnectorScope { allCompany: boolean; deptIds: string[]; userIds: string[] }
export interface ToolEntry { name: string; desc?: string; enabled: boolean; syncedAt?: string; removed?: boolean }
/** A connector's version-history row (admin wire; the `config` snapshot stays
 * server-side — rollback restores it). */
export interface VersionRow {
  id: string;
  version: string;
  note: string | null;
  current: boolean;
  createdAt: string;
  createdBy: string | null;
}
/** The staged (unpublished) working copy as returned by the detail endpoint.
 * It mirrors `ConnectorWorkingCopy` (what the drawer sends on save-draft /
 * publish) but stays a loose superset — a partial draft still parses — and
 * its `authConfig` arrives MASKED (secret fields in `••••xxxx` form), so it
 * can never pre-fill a secret. */
export interface ConnectorDraftWire {
  url: string;
  version: string;
  nameEn?: string | null;
  nameZh?: string | null;
  categoryId?: string | null;
  description?: string | null;
  transport?: Transport2;
  authMode?: AuthMode6;
  scope?: ConnectorScope;
  tools?: ToolEntry[];
  authConfig?: Record<string, unknown>;
  serverKey?: string;
}
export interface Connector {
  id: string; serverKey: string; nameEn: string | null; nameZh: string | null;
  version: string; categoryId: string | null; description: string | null;
  connectorType: 'mcp' | 'app'; url: string; transport: Transport2; authMode: AuthMode6;
  authConfig: Record<string, unknown>;
  secretMeta: { lastUpdatedAt?: string; lastUpdatedBy?: string } | null;
  authStatus: 'configured' | 'pending'; enabled: boolean;
  scope: ConnectorScope; scopeSummary: string; tools: ToolEntry[]; toolCount: number; hasDraft: boolean;
  lastTestAt: string | null; lastTestStatus: string | null; lastLatencyMs: number | null;
  createdAt: string; updatedAt: string;
  /** Detail endpoint only: the version history (newest first). */
  versions?: VersionRow[];
  /** Detail endpoint only: the staged draft, MASKED (null/absent = none). */
  draft?: ConnectorDraftWire | null;
}
export interface ConnectorInput {
  serverKey: string; url: string; nameEn?: string; nameZh?: string; version?: string;
  categoryId?: string | null; description?: string; transport?: Transport2; authMode?: AuthMode6;
  authConfig?: Record<string, unknown>; scope?: ConnectorScope;
}
export interface ConnectorPatch extends Partial<ConnectorInput> { enabled?: boolean }

/** The connector's full working copy (the save-draft / publish body): the
 * live fields the drawer edits plus per-tool toggles and the per-mode
 * authConfig (a blank secret means "keep the stored value" — the backend
 * merges over the stored ciphertext). Optional fields omitted = keep the
 * live value; explicit null clears the field. */
export interface ConnectorWorkingCopy {
  serverKey?: string;
  url: string;
  version: string;
  nameEn?: string | null;
  nameZh?: string | null;
  categoryId?: string | null;
  description?: string | null;
  transport?: Transport2;
  authMode?: AuthMode6;
  authConfig?: Record<string, unknown>;
  scope?: ConnectorScope;
  tools?: ToolEntry[];
}

export type SubmissionStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

/**
 * A member-submitted connector config in the admin review queue (wire table
 * `mcp_connector_submissions`, snake_case → camelCase per this file's
 * convention; the `"desc"` column is a quoted SQL reserved word and arrives
 * on the wire as `desc`). `cfg` is the complete free-form JSONB the member
 * submitted (serverKey/url/authMode/scope/tools, …) — read it defensively,
 * never assume exact keys.
 */
export interface Submission {
  id: string;
  name: string;
  desc: string | null;
  authorId: string;
  version: string;
  submittedAt: string;
  status: SubmissionStatus;
  rejectReason: string | null;
  cfg: Record<string, unknown>;
  approvedConnectorId: string | null;
}

export interface SubmissionList {
  submissions: Submission[];
  /** Per-status counts returned by the list route (the UI falls back to
   * counting `submissions` client-side when absent). */
  counts?: Partial<Record<SubmissionStatus, number>>;
}

export const connectorApi = {
  // Org-scoped list/categories/settings gate on `?orgId=` (the backend's
  // `orgFromQuery` 400s without it). `orgId` is the caller's own org (from
  // their token claims) — the same source `listSubmissions` already threads.
  // The detail route `get` and the id-scoped mutations (patch/del/test/…)
  // resolve the org from the token + row, so they take no `orgId`.
  list: (orgId: string) =>
    apiClient.get<Connector[]>(`/admin/mcp-connectors?orgId=${encodeURIComponent(orgId)}`),
  get: (id: string) => apiClient.get<Connector>(`/admin/mcp-connectors/${id}`),
  create: (input: ConnectorInput) => apiClient.post<{ id: string }>('/admin/mcp-connectors', input),
  patch: (id: string, patch: ConnectorPatch) => apiClient.patch<{ ok: boolean }>(`/admin/mcp-connectors/${id}`, patch),
  del: (id: string) => apiClient.delete<{ ok: true }>(`/admin/mcp-connectors/${id}`),
  test: (id: string) =>
    apiClient.post<{ status: string; latencyMs?: number; error?: string; lastTestAt?: string; toolCount?: number }>(
      `/admin/mcp-connectors/${id}/test`,
    ),
  /** Stage the working copy as a draft (no live effect). */
  saveDraft: (id: string, body: ConnectorWorkingCopy) =>
    apiClient.post<{ ok: boolean }>(`/admin/mcp-connectors/${id}/save-draft`, body),
  /** Apply the working copy to the live row (+ version row on a version bump). */
  publish: (id: string, body: ConnectorWorkingCopy) =>
    apiClient.post<{ ok: boolean; version: string; destructiveAuthSwitch?: boolean }>(
      `/admin/mcp-connectors/${id}/publish`,
      body,
    ),
  /** Restore a recorded version snapshot to the live row. */
  rollback: (id: string, version: string) =>
    apiClient.post<{ ok: boolean; version: string }>(`/admin/mcp-connectors/${id}/rollback`, { version }),
  listCategories: (orgId: string) =>
    apiClient.get<{ id: string; name: string }[]>(`/admin/mcp-connectors/categories?orgId=${encodeURIComponent(orgId)}`),
  createCategory: (orgId: string, name: string) =>
    apiClient.post<{ id: string }>(`/admin/mcp-connectors/categories?orgId=${encodeURIComponent(orgId)}`, { name }),
  deleteCategory: (orgId: string, id: string) =>
    apiClient.delete<{ ok: true }>(`/admin/mcp-connectors/categories/${id}?orgId=${encodeURIComponent(orgId)}`),
  getSettings: (orgId: string) =>
    apiClient.get<{ membersCanSubmit: boolean }>(`/admin/mcp-connectors/settings?orgId=${encodeURIComponent(orgId)}`),
  setSettings: (orgId: string, b: { membersCanSubmit: boolean }) =>
    apiClient.patch<{ ok: true }>(`/admin/mcp-connectors/settings?orgId=${encodeURIComponent(orgId)}`, b),
  // Member submissions (the admin review queue). `submit` itself is called
  // from the desktop client, so the SPA only needs list/approve/reject;
  // `withdrawSubmission` is kept for API completeness (author-side flow).
  listSubmissions: (orgId: string, status?: SubmissionStatus | 'all') => {
    const q = new URLSearchParams({ orgId });
    if (status && status !== 'all') q.set('status', status);
    return apiClient.get<SubmissionList>(`/admin/mcp-connectors/submissions?${q.toString()}`);
  },
  approveSubmission: (id: string) => apiClient.post<{ ok: boolean }>(`/admin/mcp-connectors/submissions/${id}/approve`),
  rejectSubmission: (id: string, reason: string) =>
    apiClient.post<{ ok: boolean }>(`/admin/mcp-connectors/submissions/${id}/reject`, { reason }),
  withdrawSubmission: (id: string) => apiClient.post<{ ok: boolean }>(`/admin/mcp-connectors/submissions/${id}/withdraw`),
  // Scope selector data (reuses existing dept/member endpoints).
  listDeptTree: (orgId: string) => departmentsApi.list(orgId),
  listMembers: (orgId: string) => usersApi.list(orgId),
};
