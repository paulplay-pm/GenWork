import { roleResolver } from '../auth/roleResolver';
import { scopeApi } from '../auth/scopeResolver';
import { pool } from '../db/pool';
import { DATA_SCOPE_VALUES, DataScope, type PermissionPoint } from '../shared/permissionPoints';

export interface Role {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  permissions: PermissionPoint[];
  dataScope: DataScope;
  customDeptIds: string[];
  isBuiltin: boolean;
  memberCount?: number;
}

/** Role code shape: lowercase alphanumeric + underscore (machine-safe). */
const ROLE_NAME_RE = /^[a-z0-9_]+$/;

/** Role input/state conflict (route maps per code: not_found→404, name_invalid/data_scope_invalid→422, duplicate→409). */
export class RoleError extends Error {
  constructor(
    public code: 'not_found' | 'name_invalid' | 'duplicate' | 'data_scope_invalid',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'RoleError';
  }
}

/** A built-in role cannot be deleted (route maps to 409 {error:'builtin_role'}). */
export class RoleGuardError extends Error {
  constructor(public code: 'builtin_role') {
    super(code);
    this.name = 'RoleGuardError';
  }
}

/** A custom role is still assigned to users (route maps to 409 {error:'role_in_use'}). */
export class RoleInUseError extends Error {
  constructor(public code: 'role_in_use') {
    super(code);
    this.name = 'RoleInUseError';
  }
}

async function assertNameUnique(name: string, excludeId?: string): Promise<void> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM roles WHERE name=$1 ${excludeId ? 'AND id<>$2' : ''}`,
    excludeId ? [name, excludeId] : [name]
  );
  if (r.rowCount > 0) throw new RoleError('duplicate', `role name '${name}' already exists`);
}

const ROLE_COLUMNS = `r.id, r.name, r.display_name AS "displayName", r.description, r.permissions, r.data_scope AS "dataScope", r.custom_dept_ids AS "customDeptIds", r.is_builtin AS "isBuiltin"`;

export const roleService = {
  async list(filter?: { type?: 'builtin' | 'custom' }): Promise<Role[]> {
    const where =
      filter?.type === 'builtin'
        ? ' WHERE r.is_builtin'
        : filter?.type === 'custom'
          ? ' WHERE NOT r.is_builtin'
          : '';
    const r = await pool.query<Role>(
      `SELECT ${ROLE_COLUMNS}, (SELECT COUNT(*) FROM users u WHERE u.extra_roles @> to_jsonb(r.name))::int AS "memberCount" FROM roles r${where} ORDER BY r.name`
    );
    return r.rows;
  },

  async create(input: {
    name: string;
    description?: string | null;
    permissions: PermissionPoint[];
    displayName?: string | null;
    dataScope?: DataScope;
    customDeptIds?: string[];
  }): Promise<{ id: string }> {
    if (!ROLE_NAME_RE.test(input.name)) throw new RoleError('name_invalid');
    // The route zod already validates against DATA_SCOPE_VALUES; re-check so
    // direct service callers cannot persist an unknown scope.
    const dataScope = input.dataScope ?? DataScope.Self;
    if (!DATA_SCOPE_VALUES.includes(dataScope)) throw new RoleError('data_scope_invalid');
    const customDeptIds = input.customDeptIds ?? [];
    await assertNameUnique(input.name);
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO roles(id, name, description, permissions, display_name, data_scope, custom_dept_ids, is_builtin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
      [
        id,
        input.name,
        input.description ?? null,
        JSON.stringify(input.permissions),
        input.displayName ?? input.name,
        dataScope,
        JSON.stringify(customDeptIds),
      ]
    );
    roleResolver.invalidate();
    await scopeApi.invalidate();
    return { id };
  },

  async get(id: string): Promise<Role | null> {
    const r = await pool.query<Role>(
      `SELECT ${ROLE_COLUMNS} FROM roles r WHERE r.id=$1`,
      [id]
    );
    return r.rows[0] ?? null;
  },

  async update(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      permissions?: PermissionPoint[];
      displayName?: string | null;
      dataScope?: DataScope;
      customDeptIds?: string[];
    }
  ): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new RoleError('not_found');
    if (patch.name !== undefined) {
      if (!ROLE_NAME_RE.test(patch.name)) throw new RoleError('name_invalid');
      await assertNameUnique(patch.name, id);
    }
    const name = patch.name ?? existing.name;
    const description = patch.description === undefined ? existing.description : patch.description;
    const permissions = patch.permissions ?? existing.permissions;
    const displayName = patch.displayName ?? existing.displayName;
    // Validate only the provided scope (the stored value is trusted to be
    // valid: the column default and migrations 028/029 keep it so).
    const dataScope = patch.dataScope ?? existing.dataScope;
    if (patch.dataScope !== undefined && !DATA_SCOPE_VALUES.includes(patch.dataScope)) {
      throw new RoleError('data_scope_invalid');
    }
    const customDeptIds = patch.customDeptIds ?? existing.customDeptIds;
    await pool.query(
      `UPDATE roles SET name=$1, description=$2, permissions=$3, display_name=$4, data_scope=$5, custom_dept_ids=$6 WHERE id=$7`,
      [name, description, JSON.stringify(permissions), displayName, dataScope, JSON.stringify(customDeptIds), id]
    );
    roleResolver.invalidate();
    await scopeApi.invalidate();
  },

  /** Copy a role under a new machine code. A copy is always custom,
   * even when the source is a built-in. */
  async copy(id: string, newCode: string): Promise<{ id: string }> {
    const src = await this.get(id);
    if (!src) throw new RoleError('not_found');
    if (!ROLE_NAME_RE.test(newCode)) throw new RoleError('name_invalid');
    await assertNameUnique(newCode);
    const newId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO roles(id, name, description, permissions, display_name, data_scope, custom_dept_ids, is_builtin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
      [
        newId,
        newCode,
        src.description,
        JSON.stringify(src.permissions),
        `${src.displayName ?? src.name} (copy)`,
        src.dataScope,
        JSON.stringify(src.customDeptIds),
      ]
    );
    roleResolver.invalidate();
    await scopeApi.invalidate();
    return { id: newId };
  },

  async remove(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new RoleError('not_found');
    if (existing.isBuiltin) throw new RoleGuardError('builtin_role');
    const members = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM users WHERE extra_roles @> $1::jsonb`,
      [JSON.stringify(existing.name)]
    );
    if ((members.rows[0]?.c ?? 0) > 0) throw new RoleInUseError('role_in_use');
    await pool.query(`DELETE FROM roles WHERE id=$1`, [id]);
    roleResolver.invalidate();
    await scopeApi.invalidate();
  },
};
