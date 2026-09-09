import { t } from '../i18n';
import { apiClient, ApiError } from './client';

/** One node of the `/admin/departments` forest (GET ?orgId=). */
export interface DeptNode {
  id: string;
  name: string;
  code: string | null;
  parent_id: string | null;
  path: string;
  leader_id: string | null;
  sort: number;
  description: string | null;
  /** Members assigned directly to this department. */
  directMembers: number;
  /** Members of this department and all of its descendants. */
  subtreeMembers: number;
  children: DeptNode[];
}

/** A direct member row on a department detail. */
export interface DeptMember {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  position: string | null;
  extra_roles: string[];
  status: string;
}

/** `GET /admin/departments/:id` (404 `{error:'not_found'}` when absent). */
export interface DeptDetail {
  id: string;
  name: string;
  code: string | null;
  parent_id: string | null;
  path: string;
  leader_id: string | null;
  sort: number;
  description: string | null;
  stats: { direct: number; subtree: number; childrenCount: number };
  breadcrumbs: { id: string; name: string }[];
  members: DeptMember[];
  /** Server-side data-scope check: may this caller act on this dept? */
  canAct: boolean;
}

/** `PATCH /admin/departments/:id` body. `code` is immutable after creation
 * (the server 422s with `code_immutable` on a change). */
export interface DeptPatch {
  name?: string;
  code?: string;
  parentId?: string | null;
  leaderId?: string | null;
  sort?: number;
  description?: string | null;
}

export interface DeptCreateInput {
  orgId: string;
  name: string;
  code?: string;
  parentId: string | null;
  leaderId?: string | null;
  sort?: number;
  description?: string | null;
}

export const departmentsApi = {
  /** Full forest with per-node direct/subtree member counts. */
  list: (orgId: string) =>
    apiClient.get<DeptNode[]>(`/admin/departments?orgId=${encodeURIComponent(orgId)}`),
  get: (id: string) => apiClient.get<DeptDetail>(`/admin/departments/${id}`),
  create: (input: DeptCreateInput) =>
    apiClient.post<{ id: string; path: string }>('/admin/departments', input),
  patch: (id: string, body: DeptPatch) =>
    apiClient.patch<{ ok: true }>(`/admin/departments/${id}`, body),
  /** 409 `{error:'has_members'|'has_children'}` when the delete guard trips. */
  remove: (id: string) => apiClient.delete<{ ok: true }>(`/admin/departments/${id}`),
  reorder: (orgId: string, parentId: string | null, orderedIds: string[]) =>
    apiClient.post<{ ok: true }>('/admin/departments/reorder', { orgId, parentId, orderedIds }),
};

/** Flatten the dept forest into indented `{ value, label }` options
 * (tree-select style: two spaces per depth level). A "(none)" option is the
 * caller's job. */
export function flattenDeptsOptions(nodes: DeptNode[]): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const walk = (ns: DeptNode[], prefix: string): void => {
    for (const n of ns) {
      out.push({ value: n.id, label: `${prefix}${n.name}` });
      walk(n.children, `${prefix}  `);
    }
  };
  walk(nodes, '');
  return out;
}

/** Map a thrown error from the dept endpoints to a localized message.
 * 403 `forbidden` → outside the caller's data scope; the 409 delete guard →
 * the cannot-delete notice (the caller must not retry). */
export function deptErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.body?.error;
    if (e.status === 403 || code === 'forbidden') return t('dept.scope.denied');
    if (e.status === 409 && (code === 'has_members' || code === 'has_children')) {
      return t('dept.delete.guard');
    }
    if (code === 'duplicate_code') return t('dept.error.duplicateCode');
    if (code === 'code_immutable') return t('dept.error.codeImmutable');
    if (code === 'parent_not_found') return t('dept.error.parentNotFound');
    if (code === 'not_found') return t('dept.notFound');
    if (code === 'circular_parent') return t('dept.error.circularParent');
  }
  return e instanceof Error ? e.message : String(e);
}
