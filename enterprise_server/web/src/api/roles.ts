import type { DataScope, PermissionPoint } from '../shared/permissions';
import { apiClient } from './client';

/** One row of `GET /admin/roles` (optionally `?type=builtin|custom`). */
export interface Role {
  id: string;
  /** Stable role code (`/^[a-z0-9_]+$/`). */
  name: string;
  /** Human label shown on the card; falls back to `name`. */
  displayName: string | null;
  description: string | null;
  /** Fine-grained permission points granted to the role. */
  permissions: PermissionPoint[];
  /** Data-scope axis for the role's members. */
  dataScope: DataScope;
  /** Dept ids in scope when `dataScope` is `custom_dept_tree`. */
  customDeptIds: string[];
  isBuiltin: boolean;
  /** Users currently holding the role (server-computed count). */
  memberCount?: number;
}

export type RoleType = 'builtin' | 'custom';

export interface CreateRoleInput {
  name: string;
  displayName?: string | null;
  description?: string | null;
  permissions: PermissionPoint[];
  dataScope?: DataScope;
  customDeptIds?: string[];
}

export interface PatchRoleInput {
  name?: string;
  displayName?: string | null;
  description?: string | null;
  permissions?: PermissionPoint[];
  dataScope?: DataScope;
  customDeptIds?: string[];
}

export const rolesApi = {
  list: (type?: RoleType) => apiClient.get<Role[]>(type ? `/admin/roles?type=${type}` : '/admin/roles'),
  create: (input: CreateRoleInput) => apiClient.post<{ id: string }>('/admin/roles', input),
  patch: (id: string, input: PatchRoleInput) => apiClient.patch<{ ok: true }>(`/admin/roles/${id}`, input),
  /** `409 {error:'builtin_role'|'role_in_use'}` when a server guard trips. */
  remove: (id: string) => apiClient.delete<{ ok: true }>(`/admin/roles/${id}`),
  /** Clone a role under a new code. `409 {error:'duplicate'}` on collision. */
  copy: (id: string, newCode: string) =>
    apiClient.post<{ id: string }>(`/admin/roles/${id}/copy`, { newCode }),
};
