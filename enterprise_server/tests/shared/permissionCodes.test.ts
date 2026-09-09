import { describe, expect, test } from 'vitest';

import { AuditAction } from '../../src/shared/enterpriseServerConstants';
import {
  BUILTIN_ROLE_POINTS,
  DATA_SCOPE_VALUES,
  DataScope,
  PERMISSION_MODULES,
  PERMISSION_POINTS,
  PermissionPoint,
} from '../../src/shared/permissionPoints';

describe('fine permission-point catalog', () => {
  test('exposes the expected fine point IDs (module:verb shape)', () => {
    expect(PermissionPoint.UserView).toBe('user:view');
    expect(PermissionPoint.UserCreate).toBe('user:create');
    expect(PermissionPoint.UserEdit).toBe('user:edit');
    expect(PermissionPoint.UserDelete).toBe('user:delete');
    expect(PermissionPoint.UserExport).toBe('user:export');
    expect(PermissionPoint.RoleView).toBe('role:view');
    expect(PermissionPoint.DeptView).toBe('dept:view');
    expect(PermissionPoint.DeptAdjustMember).toBe('dept:adjust_member');
    expect(PermissionPoint.ProviderRotate).toBe('provider:rotate');
    expect(PermissionPoint.AuditView).toBe('audit:view');
    expect(PermissionPoint.VersionPublish).toBe('version:publish');
    expect(PermissionPoint.VersionRollback).toBe('version:rollback');
    expect(PermissionPoint.McpDelete).toBe('mcp:delete');
    expect(PermissionPoint.AgentPublish).toBe('agent:publish');
  });

  test('point IDs are unique and all match the module:verb shape', () => {
    const values = PERMISSION_POINTS;
    expect(new Set(values).size).toBe(values.length);
    for (const p of values) {
      expect(p).toMatch(/^[a-z]+:[a-z_]+$/);
    }
  });

  test('PERMISSION_MODULES cover every point exactly once', () => {
    const flat = PERMISSION_MODULES.flatMap((m) => m.points);
    expect(new Set(flat).size).toBe(flat.length);
    expect(new Set(flat)).toEqual(new Set(PERMISSION_POINTS));
  });

  test('data scope values are the five documented scopes', () => {
    expect([...DATA_SCOPE_VALUES].sort()).toEqual([...Object.values(DataScope)].sort());
    expect(DATA_SCOPE_VALUES).toContain('dept_and_below');
    expect(DATA_SCOPE_VALUES).toContain('custom_dept_tree');
  });

  test('built-in role point sets are subsets of the catalog; super_admin is total', () => {
    const all = new Set(PERMISSION_POINTS);
    for (const [role, pts] of Object.entries(BUILTIN_ROLE_POINTS)) {
      for (const p of pts) {
        expect(all.has(p), `${role} references unknown point ${p}`).toBe(true);
      }
    }
    expect([...BUILTIN_ROLE_POINTS.super_admin].sort()).toEqual([...PERMISSION_POINTS].sort());
  });

  test('AuditAction carries role mutation actions', () => {
    expect(AuditAction.RoleCreate).toBe('role_create');
    expect(AuditAction.RoleUpdate).toBe('role_update');
    expect(AuditAction.RoleDelete).toBe('role_delete');
  });

  test('AuditAction carries agent mutation actions', () => {
    expect(AuditAction.AgentCreate).toBe('agent_create');
    expect(AuditAction.AgentUpdate).toBe('agent_update');
    expect(AuditAction.AgentDelete).toBe('agent_delete');
  });
});
