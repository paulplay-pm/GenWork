import { pool } from '../db/pool';
import type { DataScope } from '../shared/permissionPoints';

export type VisibleScope =
  | { kind: 'all' }
  | { kind: 'self' }
  | { kind: 'dept'; deptIds: string[] };

export function descendantsOf(deptIds: string[], deptPath: Map<string, string>): Set<string> {
  const out = new Set<string>(deptIds);
  for (const root of deptIds) {
    const prefix = deptPath.get(root);
    if (!prefix) continue;
    for (const [id, path] of deptPath) {
      if (path === prefix || path.startsWith(prefix + '/')) out.add(id);
    }
  }
  return out;
}

interface RoleScopeInfo { dataScope: DataScope; customDeptIds: string[] }

export function effectiveScope(args: {
  roles: string[];
  callerDeptIds: string[];
  roleScope: Map<string, RoleScopeInfo>;
  deptPath: Map<string, string>;
  isSuperAdmin: boolean;
}): VisibleScope {
  const { roles, callerDeptIds, roleScope, deptPath, isSuperAdmin } = args;
  if (isSuperAdmin) return { kind: 'all' };
  if (roles.length === 0) return { kind: 'self' };

  let hasSelf = false;
  const sets: Set<string>[] = [];

  for (const name of roles) {
    const info = roleScope.get(name);
    if (!info) { hasSelf = true; continue; } // unknown role → fail-closed to self
    if (info.dataScope === 'self') { hasSelf = true; continue; }
    if (info.dataScope === 'org_wide') { continue; }
    if (info.dataScope === 'dept') {
      sets.push(new Set(callerDeptIds));
    } else if (info.dataScope === 'dept_and_below') {
      sets.push(descendantsOf(callerDeptIds, deptPath));
    } else { // custom_dept_tree
      sets.push(descendantsOf(info.customDeptIds, deptPath));
    }
  }

  if (hasSelf) return { kind: 'self' };
  if (sets.length === 0) return { kind: 'all' }; // only org_wide roles

  let acc = new Set(sets[0]!);
  for (let i = 1; i < sets.length; i++) {
    const next = new Set<string>();
    for (const id of acc) if (sets[i]!.has(id)) next.add(id);
    acc = next;
  }
  if (acc.size === 0) return { kind: 'self' }; // intersected to nothing
  return { kind: 'dept', deptIds: [...acc] };
}

/** True when `deptId` is inside the caller's visible scope. */
export function scopeIncludesDept(scope: VisibleScope, deptId: string): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'dept') return scope.deptIds.includes(deptId);
  return false;
}

export function scopePredicate(scope: VisibleScope, callerId: string): { where: string; params: unknown[] } {
  if (scope.kind === 'all') return { where: '1=1', params: [] };
  if (scope.kind === 'self') return { where: 'u.id = $1', params: [callerId] };
  return {
    where: `(u.department_id = ANY($1) OR EXISTS (SELECT 1 FROM user_departments ud WHERE ud.user_id = u.id AND ud.dept_id = ANY($1)))`,
    params: [scope.deptIds],
  };
}

// ---------------------------------------------------------------------------
// DB-backed loaders (cached). The pure functions above are fed live data by
// this API: role name → {dataScope, customDeptIds} and dept id → path, both
// TTL-cached so per-request scope resolution costs at most 2 queries per 30s.
// Callers must `scopeApi.invalidate()` after any role data-scope / permission
// mutation or department path change (see roleService + roles routes).
// ---------------------------------------------------------------------------

const SCOPE_TTL_MS = 30_000;
let roleScopeCache: Map<string, RoleScopeInfo> | null = null;
let deptPathCache: Map<string, string> | null = null;
let cacheExpires = 0;

async function refresh(): Promise<void> {
  const now = Date.now();
  if (!roleScopeCache || !deptPathCache || now >= cacheExpires) {
    const rs = await pool.query<{ name: string; data_scope: DataScope; custom_dept_ids: string[] }>(
      `SELECT name, data_scope, custom_dept_ids FROM roles`,
    );
    const rm = new Map<string, RoleScopeInfo>();
    for (const r of rs.rows) rm.set(r.name, { dataScope: r.data_scope, customDeptIds: r.custom_dept_ids ?? [] });
    const dp = await pool.query<{ id: string; path: string }>(`SELECT id, path FROM departments`);
    const dm = new Map<string, string>();
    for (const r of dp.rows) dm.set(r.id, r.path);
    roleScopeCache = rm;
    deptPathCache = dm;
    cacheExpires = now + SCOPE_TTL_MS;
  }
}

export const scopeApi = {
  /** Clear both caches. Call after role/department data mutations. */
  async invalidate(): Promise<void> {
    roleScopeCache = null;
    deptPathCache = null;
    cacheExpires = 0;
  },
  /** All department ids the user belongs to (primary + concurrent), deduped.
   * Org-scoped: a user id that does not exist in `orgId` yields nothing. */
  async deptIdsFor(orgId: string, userId: string): Promise<string[]> {
    const r = await pool.query<{ dept_id: string }>(
      `SELECT ud.dept_id
       FROM user_departments ud
       JOIN users u ON u.id = ud.user_id
       WHERE u.id = $1 AND u.org_id = $2`,
      [userId, orgId],
    );
    const set = new Set<string>(r.rows.map((x) => x.dept_id));
    return [...set];
  },
  /** Live VisibleScope for the caller: effectiveScope over cached role
   * data-scopes, dept paths, and the caller's department memberships. */
  async loadScope(claims: { sub: string; orgId: string; roles: string[] }): Promise<VisibleScope> {
    await refresh();
    // Capture the maps into locals SYNCHRONOUSLY before the next await: a
    // concurrent `scopeApi.invalidate()` (fired by role create/update/delete)
    // may null the module-level caches while `deptIdsFor` is in flight, and
    // reading them after that await would hand `null` to effectiveScope.
    const roleScope = roleScopeCache!;
    const deptPath = deptPathCache!;
    const callerDeptIds = await scopeApi.deptIdsFor(claims.orgId, claims.sub);
    return effectiveScope({
      roles: claims.roles,
      callerDeptIds,
      roleScope,
      deptPath,
      isSuperAdmin: claims.roles.includes('super_admin'),
    });
  },
};
