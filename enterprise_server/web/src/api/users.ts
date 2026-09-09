import { t } from '../i18n';
import { apiClient, ApiError } from './client';

/** One row of `GET /admin/users?orgId=&q=&deptId=&roleId=&status=`. */
export interface UserRow {
  id: string;
  org_id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  level: string | null;
  department_id: string | null;
  primary_dept_name: string | null;
  timezone: string | null;
  extra_roles: string[];
  status: 'active' | 'disabled';
  joined_at: string | null;
  last_login_at: string | null;
  created_at: string;
}

/** One department membership on `UserFull.departments`. */
export interface UserDepartment {
  id: string;
  name: string;
  path: string;
  is_primary: boolean;
}

/** One recent login event on `UserFull.recent_logins`. */
export interface RecentLogin {
  id: string;
  ts: string;
  ip: string | null;
  device: string | null;
  result: string;
}

/** `GET /admin/users/:id` — the full profile for the detail page. */
export interface UserFull {
  id: string;
  org_id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  level: string | null;
  timezone: string | null;
  extra_roles: string[];
  status: 'active' | 'disabled';
  joined_at: string | null;
  last_login_at: string | null;
  last_login_ip: string | null;
  last_login_device: string | null;
  created_at: string;
  /** Department memberships (primary + concurrent). */
  departments: UserDepartment[];
  /** All dept ids the user is attached to: primary ∪ concurrent. */
  deptIds: string[];
  /** Last 10 login events, newest first. */
  recent_logins: RecentLogin[];
}

/** `POST /admin/users` body. The server generates the initial password and
 * returns it as `tempPassword` — the client sends no password. Canonical
 * field names (`primaryDeptId`, `concurrentDeptIds`, `roles`) — the server
 * also tolerates the legacy `departmentId`/`extraRoles` but clients should
 * send the canonical ones. */
export interface CreateUserInput {
  orgId: string;
  username: string;
  displayName?: string;
  email?: string;
  phone?: string;
  position?: string;
  level?: string;
  primaryDeptId?: string | null;
  concurrentDeptIds?: string[];
  roles?: string[];
  joinedAt?: string | null;
  timezone?: string;
}

/** `PATCH /admin/users/:id` body (same field set as create minus
 * `orgId`/`username`, plus an explicit `status`). */
export interface PatchUserInput {
  displayName?: string;
  email?: string;
  phone?: string;
  position?: string;
  level?: string;
  primaryDeptId?: string | null;
  concurrentDeptIds?: string[];
  roles?: string[];
  joinedAt?: string | null;
  timezone?: string;
  status?: 'active' | 'disabled';
}

/** `POST /admin/users/batch` actions. */
export type BatchAction =
  | 'assign_role'
  | 'adjust_dept'
  | 'enable'
  | 'disable'
  | 'reset_password';

export interface BatchInput {
  action: BatchAction;
  userIds: string[];
  /** Required (non-empty) for `assign_role` (server unions the roles). */
  roleCodes?: string[];
  /** Required for `adjust_dept`. */
  deptId?: string;
}

export interface BatchResult {
  ok: true;
  affected: number;
  /** Present when `action` is `reset_password`: one temp password per user. */
  tempPasswords?: { username: string; tempPassword: string }[];
}

/** `POST /admin/users/import` result (partial success per row). */
export interface ImportResult {
  created: number;
  skipped: number;
  errors: { row: number; reason: string }[];
  tempPasswords: { username: string; tempPassword: string }[];
}

export interface UserListFilters {
  q?: string;
  deptId?: string;
  roleId?: string;
  status?: 'active' | 'disabled';
}

export const usersApi = {
  list: (orgId: string, filters: UserListFilters = {}) => {
    const params = new URLSearchParams();
    params.set('orgId', orgId);
    if (filters.q) params.set('q', filters.q);
    if (filters.deptId) params.set('deptId', filters.deptId);
    if (filters.roleId) params.set('roleId', filters.roleId);
    if (filters.status) params.set('status', filters.status);
    return apiClient.get<UserRow[]>(`/admin/users?${params.toString()}`);
  },
  get: (id: string) => apiClient.get<UserFull>(`/admin/users/${id}`),
  create: (input: CreateUserInput) =>
    apiClient.post<{ id: string; tempPassword: string }>('/admin/users', input),
  patch: (id: string, input: PatchUserInput) =>
    apiClient.patch<{ ok: true }>(`/admin/users/${id}`, input),
  disable: (id: string) =>
    apiClient.post<{ ok: true }>(`/admin/users/${id}/disable`),
  enable: (id: string) =>
    apiClient.post<{ ok: true }>(`/admin/users/${id}/enable`),
  /** Server-generated password: no request body; returns `{ tempPassword }`. */
  resetPassword: (id: string) =>
    apiClient.post<{ tempPassword: string }>(`/admin/users/${id}/reset-password`),
  batch: (input: BatchInput) => apiClient.post<BatchResult>('/admin/users/batch', input),
  /** `GET /admin/users/export` — CSV attachment text. */
  exportCsv: (orgId: string) =>
    apiClient.getRaw(`/admin/users/export?orgId=${encodeURIComponent(orgId)}`),
  /** 422 `{error:'too_many_rows'}` above 1000 data rows. */
  importUsers: (orgId: string, csv: string) =>
    apiClient.post<ImportResult>('/admin/users/import', { orgId, csv }),
};

/** Map a thrown error from the user endpoints to a localized message. */
export function userErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.body?.error;
    if (code === 'email_duplicate') return t('users.error.emailDuplicate');
    if (code === 'not_found' || code === 'dept_not_found') return t('users.error.notFound');
    if (e.status === 403 || code === 'forbidden') return t('users.error.forbidden');
    if (code === 'too_many_rows') return t('users.import.tooMany');
  }
  return e instanceof Error ? e.message : String(e);
}
