import { randomBytes } from 'node:crypto';

import { hashPassword } from '../auth/password';
import { scopeIncludesDept, scopePredicate, type VisibleScope } from '../auth/scopeResolver';
import { pool } from '../db/pool';
import { timezone } from './timezone';

interface DeptRow {
  id: string;
  org_id: string;
  name: string;
  code: string | null;
  parent_id: string | null;
  path: string;
  leader_id: string | null;
  sort: number;
  description: string | null;
}

export interface DeptNode {
  id: string;
  name: string;
  code: string | null;
  parent_id: string | null;
  path: string;
  leader_id: string | null;
  sort: number;
  description: string | null;
  directMembers: number;
  subtreeMembers: number;
  children: DeptNode[];
}

export interface DeptMember {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  position: string | null;
  extra_roles: string[];
  status: string;
}

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
  canAct: boolean;
}

export interface DeptSnapshot {
  name: string;
  code: string | null;
  parent_id: string | null;
  leader_id: string | null;
  sort: number;
  description: string | null;
  path: string;
}

export interface DeptPatch {
  name?: string;
  code?: string;
  parentId?: string | null;
  leaderId?: string | null;
  sort?: number;
  description?: string | null;
}

/** Structural delete of a department was refused (route maps to 409 {error: code}). */
export class DeptGuardError extends Error {
  constructor(public code: 'has_members' | 'has_children') {
    super(code);
    this.name = 'DeptGuardError';
  }
}

/** Department input/state conflict (route maps per code, see routes/admin/departments.ts). */
export class DeptError extends Error {
  constructor(
    public code:
      | 'duplicate_code'
      | 'code_immutable'
      | 'parent_not_found'
      | 'circular_parent'
      | 'not_found',
  ) {
    super(code);
    this.name = 'DeptError';
  }
}

/** User input/state conflict (route maps per code, see routes/admin/users.ts). */
export class UserError extends Error {
  constructor(public code: 'email_duplicate' | 'dept_not_found' | 'not_found') {
    super(code);
    this.name = 'UserError';
  }
}

/** One row of a scope-filtered user list. */
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
  status: string;
  joined_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

/** Full profile for one user: base columns, dept memberships, recent logins. */
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
  status: string;
  joined_at: Date | null;
  last_login_at: Date | null;
  last_login_ip: string | null;
  last_login_device: string | null;
  created_at: Date;
  /** Department memberships (primary + concurrent) via `user_departments`. */
  departments: { id: string; name: string; path: string; is_primary: boolean }[];
  /** All dept ids the user is attached to: `department_id` ∪ junction depts. */
  deptIds: string[];
  /** Last 10 `login_events`, newest first. */
  recent_logins: {
    id: string;
    ts: Date;
    ip: string | null;
    device: string | null;
    result: string;
  }[];
}

/** Unambiguous alphabet for server-generated temp passwords (no 0/O/1/I/l). */
const TEMP_PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Batch mutation actions (POST /admin/users/batch). */
export const BATCH_ACTIONS = [
  'assign_role',
  'adjust_dept',
  'enable',
  'disable',
  'reset_password',
] as const;
export type BatchAction = (typeof BATCH_ACTIONS)[number];

/** Strong server-generated temporary password (default 16 chars). */
export function generateTempPassword(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const b = bytes[i]!;
    out += TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length];
  }
  return out;
}

const DEPT_COLS = `id, org_id, name, code, parent_id, path, leader_id, sort, description`;

async function loadDeptRow(id: string): Promise<DeptRow | null> {
  const r = await pool.query<DeptRow>(`SELECT ${DEPT_COLS} FROM departments WHERE id=$1`, [id]);
  return r.rows[0] ?? null;
}

function snap(d: DeptRow): DeptSnapshot {
  return {
    name: d.name,
    code: d.code,
    parent_id: d.parent_id,
    leader_id: d.leader_id,
    sort: d.sort,
    description: d.description,
    path: d.path,
  };
}

export const orgService = {
  /** Create a department. `code` is unique per org; `path` is built from the
   * parent's path. Concurrency: the (org_id, code) unique index backstops the
   * pre-check and maps to the same `duplicate_code` error. */
  async createDept(input: {
    orgId: string;
    name: string;
    code?: string | null;
    parentId: string | null;
    leaderId?: string | null;
    sort?: number;
    description?: string | null;
  }): Promise<{ id: string; path: string }> {
    const id = crypto.randomUUID();
    let path = `/${input.name}`;
    if (input.parentId) {
      const r = await pool.query<{ path: string }>(
        `SELECT path FROM departments WHERE id=$1 AND org_id=$2`,
        [input.parentId, input.orgId]
      );
      if (r.rowCount === 0) throw new DeptError('parent_not_found');
      path = `${r.rows[0].path}/${input.name}`;
    }
    const code = input.code ?? null;
    if (code) {
      const dup = await pool.query(`SELECT 1 FROM departments WHERE org_id=$1 AND code=$2`, [
        input.orgId,
        code
      ]);
      if ((dup.rowCount ?? 0) > 0) throw new DeptError('duplicate_code');
    }
    try {
      await pool.query(
        `INSERT INTO departments(id, org_id, name, parent_id, path, code, leader_id, sort, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          input.orgId,
          input.name,
          input.parentId,
          path,
          code,
          input.leaderId ?? null,
          input.sort ?? 100,
          input.description ?? null
        ]
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DeptError('duplicate_code');
      throw e;
    }
    return { id, path };
  },

  /** Scope-filtered department tree. `kind:'all'` → whole org; `kind:'self'`
   * → no org structure; `kind:'dept'` → only depts in `scope.deptIds`,
   * surfacing as roots when their parent is outside the scope. */
  async listDeptTree(orgId: string, scope: VisibleScope): Promise<DeptNode[]> {
    if (scope.kind === 'self') return [];
    const r = await pool.query<DeptRow>(
      `SELECT ${DEPT_COLS} FROM departments WHERE org_id=$1 ORDER BY sort, path`,
      [orgId]
    );
    const allowed = scope.kind === 'dept' ? new Set(scope.deptIds) : null;
    const visible = allowed ? r.rows.filter((d) => allowed.has(d.id)) : r.rows;
    const mc = await pool.query<{ dept_id: string; n: number }>(
      `SELECT ud.dept_id, COUNT(*)::int AS n
       FROM user_departments ud
       JOIN departments d ON d.id = ud.dept_id
       WHERE d.org_id=$1
       GROUP BY ud.dept_id`,
      [orgId]
    );
    const direct = new Map(mc.rows.map((x) => [x.dept_id, x.n]));
    const nodes = new Map<string, DeptNode>();
    for (const d of visible) {
      nodes.set(d.id, {
        id: d.id,
        name: d.name,
        code: d.code,
        parent_id: d.parent_id,
        path: d.path,
        leader_id: d.leader_id,
        sort: d.sort,
        description: d.description,
        directMembers: direct.get(d.id) ?? 0,
        subtreeMembers: 0,
        children: []
      });
    }
    const roots: DeptNode[] = [];
    for (const d of visible) {
      const n = nodes.get(d.id)!;
      const parent = d.parent_id ? nodes.get(d.parent_id) : undefined;
      if (parent) parent.children.push(n);
      else roots.push(n);
    }
    const roll = (n: DeptNode): number => {
      n.subtreeMembers = n.directMembers + n.children.reduce((s, c) => s + roll(c), 0);
      return n.subtreeMembers;
    };
    for (const root of roots) roll(root);
    return roots;
  },

  /** Full detail for one department: base info, stats (direct / subtree /
   * children), breadcrumb chain, direct member list, and whether the given
   * caller scope may act on it. Returns null when the dept is unknown or
   * belongs to another org. */
  async getDeptDetail(
    orgId: string,
    deptId: string,
    scope?: VisibleScope
  ): Promise<DeptDetail | null> {
    const all = await pool.query<DeptRow>(
      `SELECT ${DEPT_COLS} FROM departments WHERE org_id=$1`,
      [orgId]
    );
    const d = all.rows.find((x) => x.id === deptId);
    if (!d) return null;
    const byId = new Map(all.rows.map((x) => [x.id, x]));
    const subtreeIds = all.rows
      .filter((x) => x.path === d.path || x.path.startsWith(d.path + '/'))
      .map((x) => x.id);
    const directR = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM user_departments WHERE dept_id=$1`,
      [deptId]
    );
    const subtreeR = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM user_departments WHERE dept_id = ANY($1)`,
      [subtreeIds]
    );
    const childrenR = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM departments WHERE parent_id=$1`,
      [deptId]
    );
    const members = await pool.query<DeptMember>(
      `SELECT u.id, u.username, u.display_name, u.email, u.position,
              u.extra_roles, u.status
       FROM users u
       JOIN user_departments ud ON ud.user_id = u.id
       WHERE ud.dept_id=$1
       ORDER BY u.username`,
      [deptId]
    );
    const crumbs: { id: string; name: string }[] = [];
    let cur: DeptRow | undefined = d;
    let guard = 0;
    while (cur && guard < 1000) {
      guard += 1;
      crumbs.push({ id: cur.id, name: cur.name });
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    crumbs.reverse();
    return {
      id: d.id,
      name: d.name,
      code: d.code,
      parent_id: d.parent_id,
      path: d.path,
      leader_id: d.leader_id,
      sort: d.sort,
      description: d.description,
      stats: {
        direct: directR.rows[0].n,
        subtree: subtreeR.rows[0].n,
        childrenCount: childrenR.rows[0].n
      },
      breadcrumbs: crumbs,
      members: members.rows,
      canAct: scope ? scopeIncludesDept(scope, deptId) : false
    };
  },

  /** Update name/code/parentId/leaderId/sort/description. A `code` change is
   * rejected (codes are stable identifiers). A name or parent change
   * rewrites the subtree `path` atomically. */
  async updateDept(
    id: string,
    patch: DeptPatch
  ): Promise<{ before: DeptSnapshot; after: DeptSnapshot }> {
    if (patch.code !== undefined) throw new DeptError('code_immutable');
    const d = await loadDeptRow(id);
    if (!d) throw new DeptError('not_found');
    const before = snap(d);
    const nextName = patch.name ?? d.name;
    const nextParent = patch.parentId === undefined ? d.parent_id : patch.parentId;
    return pool.transaction(async (tx) => {
      let newOwnPath: string;
      if (nextParent !== null) {
        const p = await tx.query<{ org_id: string; path: string }>(
          `SELECT org_id, path FROM departments WHERE id=$1`,
          [nextParent]
        );
        if (p.rowCount === 0) throw new DeptError('parent_not_found');
        if (p.rows[0].org_id !== d.org_id) throw new DeptError('parent_not_found');
        if (p.rows[0].path === d.path || p.rows[0].path.startsWith(d.path + '/')) {
          throw new DeptError('circular_parent');
        }
        newOwnPath = `${p.rows[0].path}/${nextName}`;
      } else {
        newOwnPath = `/${nextName}`;
      }
      const nextLeader = patch.leaderId === undefined ? d.leader_id : patch.leaderId;
      const nextSort = patch.sort ?? d.sort;
      const nextDesc = patch.description === undefined ? d.description : patch.description;
      await tx.query(
        `UPDATE departments
         SET name=$1, parent_id=$2, path=$3, leader_id=$4, sort=$5, description=$6
         WHERE id=$7`,
        [nextName, nextParent, newOwnPath, nextLeader, nextSort, nextDesc, id]
      );
      if (newOwnPath !== d.path) {
        const subtree = await tx.query<{ id: string; path: string }>(
          `SELECT id, path FROM departments WHERE org_id=$1`,
          [d.org_id]
        );
        for (const x of subtree.rows) {
          if (x.path.startsWith(d.path + '/')) {
            await tx.query(`UPDATE departments SET path=$1 WHERE id=$2`, [
              newOwnPath + x.path.slice(d.path.length),
              x.id
            ]);
          }
        }
      }
      return {
        before,
        after: {
          ...before,
          name: nextName,
          parent_id: nextParent,
          leader_id: nextLeader,
          sort: nextSort,
          description: nextDesc,
          path: newOwnPath
        }
      };
    });
  },

  /** Reparent a department: recompute `path` for the node AND its whole
   * subtree, atomically. The new parent must exist, be in the same org, and
   * not be a descendant of the node being moved (no cycles). */
  async moveDept(
    id: string,
    newParentId: string | null
  ): Promise<{ before: DeptSnapshot; after: DeptSnapshot }> {
    const d = await loadDeptRow(id);
    if (!d) throw new DeptError('not_found');
    const before = snap(d);
    return pool.transaction(async (tx) => {
      let newOwnPath: string;
      if (newParentId !== null) {
        const p = await tx.query<{ org_id: string; path: string }>(
          `SELECT org_id, path FROM departments WHERE id=$1`,
          [newParentId]
        );
        if (p.rowCount === 0) throw new DeptError('parent_not_found');
        if (p.rows[0].org_id !== d.org_id) throw new DeptError('parent_not_found');
        if (p.rows[0].path === d.path || p.rows[0].path.startsWith(d.path + '/')) {
          throw new DeptError('circular_parent');
        }
        newOwnPath = `${p.rows[0].path}/${d.name}`;
      } else {
        newOwnPath = `/${d.name}`;
      }
      if (newOwnPath !== d.path) {
        await tx.query(`UPDATE departments SET parent_id=$1, path=$2 WHERE id=$3`, [
          newParentId,
          newOwnPath,
          id
        ]);
        const subtree = await tx.query<{ id: string; path: string }>(
          `SELECT id, path FROM departments WHERE org_id=$1`,
          [d.org_id]
        );
        for (const x of subtree.rows) {
          if (x.path.startsWith(d.path + '/')) {
            await tx.query(`UPDATE departments SET path=$1 WHERE id=$2`, [
              newOwnPath + x.path.slice(d.path.length),
              x.id
            ]);
          }
        }
      } else {
        await tx.query(`UPDATE departments SET parent_id=$1 WHERE id=$2`, [newParentId, id]);
      }
      return { before, after: { ...before, parent_id: newParentId, path: newOwnPath } };
    });
  },

  /** Delete a leaf department. Throws `DeptGuardError('has_members')` when
   * users are directly assigned (via `user_departments` or `users.department_id`,
   * the latter backstops the FK on users.department_id) and
   * `DeptGuardError('has_children')` when child departments exist. */
  async deleteDept(id: string): Promise<DeptSnapshot | null> {
    const d = await loadDeptRow(id);
    if (!d) return null;
    const before = snap(d);
    await pool.transaction(async (tx) => {
      const m = await tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT user_id FROM user_departments WHERE dept_id=$1
           UNION
           SELECT id FROM users WHERE department_id=$1
         ) t`,
        [id]
      );
      if (m.rows[0].n > 0) throw new DeptGuardError('has_members');
      const c = await tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM departments WHERE parent_id=$1`,
        [id]
      );
      if (c.rows[0].n > 0) throw new DeptGuardError('has_children');
      await tx.query(`DELETE FROM departments WHERE id=$1`, [id]);
    });
    return before;
  },

  /** Set `sort = index+1` for each dept in `orderedIds` (siblings of
   * `parentId` in `orgId`). Unknown/stale ids are skipped. Returns the
   * before/after sort of every applied dept. */
  async reorderSiblings(
    orgId: string,
    parentId: string | null,
    orderedIds: string[]
  ): Promise<{ id: string; before: number; after: number }[]> {
    const items: { id: string; before: number; after: number }[] = [];
    await pool.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i += 1) {
        const deptId = orderedIds[i]!;
        const cur = await tx.query<{ sort: number }>(
          `SELECT sort FROM departments
           WHERE id=$1 AND org_id=$2 AND parent_id IS NOT DISTINCT FROM $3`,
          [deptId, orgId, parentId]
        );
        if (cur.rowCount === 0) continue;
        items.push({ id: deptId, before: cur.rows[0].sort, after: i + 1 });
        await tx.query(`UPDATE departments SET sort=$1 WHERE id=$2`, [i + 1, deptId]);
      }
    });
    return items;
  },

  /** Create a user with a full profile. `password` is caller-supplied; the
   * route echoes it back as `tempPassword` so the SPA can show it once.
   * `primaryDeptId` (or the legacy `departmentId` alias) is written to
   * `users.department_id` AND the `user_departments` junction
   * (is_primary=true); each `concurrentDeptIds` entry becomes a
   * non-primary junction row. `roles` defaults to `['member']` when omitted. */
  async createUser(input: {
    orgId: string;
    username: string;
    password: string;
    displayName?: string | null;
    email?: string | null;
    phone?: string | null;
    position?: string | null;
    level?: string | null;
    primaryDeptId?: string | null;
    /** @deprecated legacy alias for `primaryDeptId`. */
    departmentId?: string | null;
    concurrentDeptIds?: string[];
    roles?: string[];
    /** @deprecated legacy alias for `roles`. */
    extraRoles?: string[];
    joinedAt?: string | null;
    timezone?: string;
  }): Promise<{ id: string; tempPassword: string }> {
    const id = crypto.randomUUID();
    let tz: string | null = null;
    if (input.timezone) {
      try {
        tz = timezone.resolveZone(input.timezone);
      } catch {
        tz = null;
      }
    }
    const roles = input.roles ?? input.extraRoles ?? ['member'];
    const email = input.email ?? null;
    if (email) {
      const dup = await pool.query(`SELECT 1 FROM users WHERE org_id=$1 AND email=$2`, [
        input.orgId,
        email
      ]);
      if ((dup.rowCount ?? 0) > 0) throw new UserError('email_duplicate');
    }
    const primaryDeptId = input.primaryDeptId ?? input.departmentId ?? null;
    const concurrent = [...new Set(input.concurrentDeptIds ?? [])].filter(
      (d) => d !== primaryDeptId
    );
    for (const d of primaryDeptId ? [primaryDeptId, ...concurrent] : concurrent) {
      const r = await pool.query(`SELECT 1 FROM departments WHERE id=$1 AND org_id=$2`, [
        d,
        input.orgId
      ]);
      if ((r.rowCount ?? 0) === 0) throw new UserError('dept_not_found');
    }
    const hash = await hashPassword(input.password);
    try {
      await pool.query(
        `INSERT INTO users(id, org_id, username, password_hash, display_name, email, phone,
                           position, level, department_id, timezone, extra_roles, joined_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          input.orgId,
          input.username,
          hash,
          input.displayName ?? null,
          email,
          input.phone ?? null,
          input.position ?? null,
          input.level ?? null,
          primaryDeptId,
          tz,
          JSON.stringify(roles),
          input.joinedAt ?? null
        ]
      );
    } catch (e) {
      // The (org_id, email) unique index backstops the pre-check under races.
      if (
        (e as { code?: string }).code === '23505' &&
        String((e as { message?: string }).message).includes('users_org_email')
      ) {
        throw new UserError('email_duplicate');
      }
      throw e;
    }
    if (primaryDeptId) {
      await pool.query(
        `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES ($1,$2,true)
         ON CONFLICT (user_id, dept_id) DO UPDATE SET is_primary=true`,
        [id, primaryDeptId]
      );
    }
    for (const d of concurrent) {
      await pool.query(
        `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES ($1,$2,false)
         ON CONFLICT (user_id, dept_id) DO NOTHING`,
        [id, d]
      );
    }
    return { id, tempPassword: input.password };
  },

  async setUserStatus(userId: string, status: 'active' | 'disabled'): Promise<void> {
    await pool.query(`UPDATE users SET status=$1 WHERE id=$2`, [status, userId]);
  },

  /** Overwrite a user's password hash. Returns false when no such user exists. */
  async resetPassword(userId: string, newPassword: string): Promise<boolean> {
    const hash = await hashPassword(newPassword);
    const r = await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, userId]);
    return (r.rowCount ?? 0) > 0;
  },

  /** Replace a user's department memberships (all-or-nothing): drop every
   * `user_departments` row, insert the new primary (is_primary=true) plus
   * each concurrent (is_primary=false), and keep `users.department_id`
   * in sync with the primary. Named depts must exist in the user's org. */
  async setUserDepts(userId: string, primaryId: string | null, concurrentIds: string[]): Promise<void> {
    const u = await pool.query<{ org_id: string }>(`SELECT org_id FROM users WHERE id=$1`, [
      userId
    ]);
    if (u.rowCount === 0) throw new UserError('not_found');
    const orgId = u.rows[0].org_id;
    const concurrent = [...new Set(concurrentIds)].filter((d) => d !== primaryId);
    for (const d of primaryId ? [primaryId, ...concurrent] : concurrent) {
      const r = await pool.query(`SELECT 1 FROM departments WHERE id=$1 AND org_id=$2`, [
        d,
        orgId
      ]);
      if ((r.rowCount ?? 0) === 0) throw new UserError('dept_not_found');
    }
    await pool.transaction(async (tx) => {
      await tx.query(`DELETE FROM user_departments WHERE user_id=$1`, [userId]);
      if (primaryId) {
        await tx.query(
          `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES ($1,$2,true)`,
          [userId, primaryId]
        );
      }
      for (const d of concurrent) {
        await tx.query(
          `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES ($1,$2,false)`,
          [userId, d]
        );
      }
      await tx.query(`UPDATE users SET department_id=$1 WHERE id=$2`, [primaryId, userId]);
    });
  },

  /** True when `email` is already taken in `orgId` (ignoring
   * `excludeUserId` when set, for PATCH-excluding-self checks). */
  async emailInUse(orgId: string, email: string, excludeUserId?: string): Promise<boolean> {
    const params: unknown[] = [orgId, email];
    let excl = '';
    if (excludeUserId) {
      excl = ` AND id <> $${params.length + 1}`;
      params.push(excludeUserId);
    }
    const r = await pool.query(`SELECT 1 FROM users WHERE org_id=$1 AND email=$2${excl}`, params);
    return (r.rowCount ?? 0) > 0;
  },

  async patchUser(
    userId: string,
    patch: Partial<{
      /** @deprecated — writes `users.department_id` only, NOT the
       * `user_departments` junction; use `setUserDepts` for department
       * changes (the admin route does exactly that). */
      departmentId: string;
      extraRoles: string[];
      roles: string[];
      displayName: string | null;
      email: string | null;
      phone: string | null;
      position: string | null;
      level: string | null;
      joinedAt: string | null;
      timezone: string;
      status: string;
    }>
  ): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (patch.departmentId !== undefined) {
      fields.push(`department_id=$${i++}`);
      values.push(patch.departmentId);
    }
    const roles = patch.roles ?? patch.extraRoles;
    if (roles !== undefined) {
      fields.push(`extra_roles=$${i++}`);
      values.push(JSON.stringify(roles));
    }
    if (patch.displayName !== undefined) {
      fields.push(`display_name=$${i++}`);
      values.push(patch.displayName);
    }
    if (patch.email !== undefined) {
      fields.push(`email=$${i++}`);
      values.push(patch.email);
    }
    if (patch.phone !== undefined) {
      fields.push(`phone=$${i++}`);
      values.push(patch.phone);
    }
    if (patch.position !== undefined) {
      fields.push(`position=$${i++}`);
      values.push(patch.position);
    }
    if (patch.level !== undefined) {
      fields.push(`level=$${i++}`);
      values.push(patch.level);
    }
    if (patch.joinedAt !== undefined) {
      fields.push(`joined_at=$${i++}`);
      values.push(patch.joinedAt);
    }
    if (patch.timezone !== undefined) {
      try {
        const z = timezone.resolveZone(patch.timezone);
        fields.push(`timezone=$${i++}`);
        values.push(z);
      } catch {
        /* skip invalid timezone */
      }
    }
    if (patch.status !== undefined) {
      fields.push(`status=$${i++}`);
      values.push(patch.status);
    }
    if (fields.length === 0) return;
    values.push(userId);
    try {
      await pool.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${i}`, values);
    } catch (e) {
      if (
        (e as { code?: string }).code === '23505' &&
        String((e as { message?: string }).message).includes('users_org_email')
      ) {
        throw new UserError('email_duplicate');
      }
      throw e;
    }
  },

  async getUser(userId: string): Promise<{
    id: string;
    org_id: string;
    username: string;
    display_name: string | null;
    department_id: string | null;
    timezone: string | null;
    extra_roles: string[];
    status: string;
  } | null> {
    const r = await pool.query(
      `SELECT id, org_id, username, display_name, department_id,
              timezone, extra_roles, status
       FROM users WHERE id=$1`,
      [userId]
    );
    return (r.rows[0] as never) ?? null;
  },

  /** Scope-filtered user list for an org. The legacy one-arg form
   * (`listUsers(orgId)`) still lists the whole org. `scope` (with the
   * caller's id, see `filters.callerId`) applies `scopePredicate`;
   * optional filters: `q` (ILIKE on username/display_name/email/phone),
   * `deptId` (primary OR concurrent membership), `roleId` (present in
   * `extra_roles`), `status`. */
  async listUsers(
    orgId: string,
    scope: VisibleScope = { kind: 'all' },
    q?: string,
    filters?: { callerId?: string; deptId?: string; roleId?: string; status?: string }
  ): Promise<UserRow[]> {
    const where: string[] = ['u.org_id=$1'];
    const params: unknown[] = [orgId];
    const sp = scopePredicate(scope, filters?.callerId ?? '');
    // scopePredicate's placeholders start at $1; renumber them to follow the
    // org predicate already on the stack.
    where.push(sp.where.replace(/\$(\d+)/g, (_m, n: string) => `$${params.length + Number(n)}`));
    params.push(...sp.params);
    if (q) {
      where.push(
        `(u.username ILIKE $${params.length + 1} OR u.display_name ILIKE $${params.length + 1} ` +
          `OR u.email ILIKE $${params.length + 1} OR u.phone ILIKE $${params.length + 1})`
      );
      params.push(`%${q}%`);
    }
    if (filters?.deptId) {
      where.push(
        `(u.department_id = $${params.length + 1} OR EXISTS ` +
          `(SELECT 1 FROM user_departments ud WHERE ud.user_id = u.id AND ud.dept_id = $${
            params.length + 2
          }))`
      );
      params.push(filters.deptId, filters.deptId);
    }
    if (filters?.roleId) {
      where.push(`u.extra_roles @> $${params.length + 1}::jsonb`);
      params.push(JSON.stringify([filters.roleId]));
    }
    if (filters?.status) {
      where.push(`u.status = $${params.length + 1}`);
      params.push(filters.status);
    }
    const r = await pool.query<UserRow>(
      `SELECT u.id, u.org_id, u.username, u.display_name, u.email, u.phone,
              u.position, u.level, u.department_id, d.name AS primary_dept_name,
              u.timezone, u.extra_roles, u.status, u.joined_at, u.last_login_at, u.created_at
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE ${where.join(' AND ')}
       ORDER BY u.created_at DESC`,
      params
    );
    return r.rows;
  },

  /** Ids of the users in `orgId` the caller may ACT on — the same
   * fail-closed visibility rule as the per-user mutation guard
   * (`userInScope` in routes/admin/users.ts): `all` → every user in the
   * org, `self` → the caller themself (when the caller is a user in the
   * org), `dept` → users whose membership (primary `users.department_id` OR
   * any `user_departments` row) intersects `scope.deptIds`. Batch ops must
   * reject any target outside this set so batch-allowed ⊆ per-user-allowed. */
  async visibleUserIds(orgId: string, scope: VisibleScope, callerId: string): Promise<Set<string>> {
    const where: string[] = ['u.org_id=$1'];
    const params: unknown[] = [orgId];
    const sp = scopePredicate(scope, callerId);
    // scopePredicate's placeholders start at $1; renumber them to follow the
    // org predicate already on the stack (same renumber as listUsers — in
    // the dept case the `ANY($1)` array binding must land on $2 or Postgres
    // mis-binds / throws "op ANY/ALL (array) requires array").
    where.push(sp.where.replace(/\$(\d+)/g, (_m, n: string) => `$${params.length + Number(n)}`));
    params.push(...sp.params);
    const r = await pool.query<{ id: string }>(
      `SELECT u.id FROM users u WHERE ${where.join(' AND ')}`,
      params
    );
    return new Set(r.rows.map((x) => x.id));
  },

  /** Apply one batch action to the given user ids atomically. The route has
   * already fail-closed-verified every id against `visibleUserIds` and
   * scope-checked `adjust_dept`'s destination dept; unknown ids (or a dept
   * that vanished since) are skipped (rowCount 0), not errors.
   * `assign_role` UNIONs `roleCodes` with each user's current roles (batch
   * assign = add; removal is a later SPA concern). `reset_password` returns
   * the per-user generated temp passwords.
   *
   * Implemented with raw `tx` queries (like `updateDept` / `deleteDept`)
   * rather than the pool-based single-user methods: inside
   * `pool.transaction` those would execute on separate pool clients in
   * production pg, leaving the batch non-atomic. */
  async applyBatch(args: {
    orgId: string;
    action: BatchAction;
    userIds: string[];
    roleCodes?: string[];
    deptId?: string;
  }): Promise<{ userId: string; tempPassword: string }[]> {
    const tempPasswords: { userId: string; tempPassword: string }[] = [];
    const seen = new Set<string>();
    await pool.transaction(async (tx) => {
      for (const id of args.userIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        switch (args.action) {
          case 'enable':
            await tx.query(`UPDATE users SET status='active' WHERE id=$1`, [id]);
            break;
          case 'disable':
            await tx.query(`UPDATE users SET status='disabled' WHERE id=$1`, [id]);
            break;
          case 'assign_role': {
            const r = await tx.query<{ extra_roles: string[] }>(
              `SELECT extra_roles FROM users WHERE id=$1`,
              [id]
            );
            if ((r.rowCount ?? 0) === 0) break;
            const merged = [...new Set([...(r.rows[0].extra_roles ?? []), ...(args.roleCodes ?? [])])];
            await tx.query(`UPDATE users SET extra_roles=$1 WHERE id=$2`, [
              JSON.stringify(merged),
              id
            ]);
            break;
          }
          case 'adjust_dept': {
            const deptId = args.deptId;
            if (!deptId) break;
            const d = await tx.query(`SELECT 1 FROM departments WHERE id=$1 AND org_id=$2`, [
              deptId,
              args.orgId
            ]);
            if ((d.rowCount ?? 0) === 0) break;
            // Mirror `setUserDepts(id, deptId, [])`: drop all memberships,
            // make the new dept the sole primary, keep users.department_id
            // in sync.
            await tx.query(`DELETE FROM user_departments WHERE user_id=$1`, [id]);
            await tx.query(
              `INSERT INTO user_departments(user_id, dept_id, is_primary) VALUES ($1,$2,true)
               ON CONFLICT (user_id, dept_id) DO UPDATE SET is_primary=true`,
              [id, deptId]
            );
            await tx.query(`UPDATE users SET department_id=$1 WHERE id=$2`, [deptId, id]);
            break;
          }
          case 'reset_password': {
            const r = await tx.query(`SELECT 1 FROM users WHERE id=$1`, [id]);
            if ((r.rowCount ?? 0) === 0) break;
            const pw = generateTempPassword();
            await tx.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [
              await hashPassword(pw),
              id
            ]);
            tempPasswords.push({ userId: id, tempPassword: pw });
            break;
          }
        }
      }
    });
    return tempPasswords;
  },

  /** Full profile for one user (see `UserFull`): base columns, department
   * memberships, last-10 login events. Null when the id is unknown. */
  async getUserFull(userId: string): Promise<UserFull | null> {
    const r = await pool.query<UserFull & { department_id: string | null }>(
      `SELECT id, org_id, username, display_name, email, phone, position, level,
              timezone, extra_roles, status, joined_at, last_login_at,
              last_login_ip, last_login_device, created_at, department_id
       FROM users WHERE id=$1`,
      [userId]
    );
    const row = r.rows[0];
    if (!row) return null;
    const depts = await pool.query<UserFull['departments'][number]>(
      `SELECT d.id, d.name, d.path, ud.is_primary
       FROM user_departments ud
       JOIN departments d ON d.id = ud.dept_id
       WHERE ud.user_id=$1
       ORDER BY ud.is_primary DESC, d.path`,
      [userId]
    );
    const logins = await pool.query<UserFull['recent_logins'][number]>(
      `SELECT id, ts, ip, device, result
       FROM login_events WHERE user_id=$1
       ORDER BY ts DESC, id
       LIMIT 10`,
      [userId]
    );
    const deptIdSet = new Set<string>(depts.rows.map((d) => d.id));
    if (row.department_id) deptIdSet.add(row.department_id);
    const { department_id: _omitted, ...base } = row;
    return {
      ...base,
      departments: depts.rows,
      deptIds: [...deptIdSet],
      recent_logins: logins.rows
    };
  },

  /** True when a dept with `deptId` exists in `orgId`. Used by the admin
   * routes to keep :id mutations org-scoped (a caller's token is org-bound,
   * so a dept UUID from another org must 404, not be mutated). */
  async deptInOrg(deptId: string, orgId: string): Promise<boolean> {
    const r = await pool.query(`SELECT 1 FROM departments WHERE id=$1 AND org_id=$2`, [
      deptId,
      orgId
    ]);
    return (r.rowCount ?? 0) > 0;
  },
};
