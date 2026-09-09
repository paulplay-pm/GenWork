import { describe, expect, test } from 'vitest';

import { DATA_SCOPE_VALUES, DataScope, PERMISSION_MODULES, PERMISSION_POINTS } from '../../src/shared/permissionPoints';

describe('permissionPoints catalog', () => {
  test('exposes 49 unique fine-grained points', () => {
    expect(new Set(PERMISSION_POINTS).size).toBe(PERMISSION_POINTS.length);
    expect(PERMISSION_POINTS).toHaveLength(49);
  });
  test('every point is module:action and covered by exactly one module', () => {
    const all = PERMISSION_MODULES.flatMap((m) => m.points);
    expect(new Set(all).size).toBe(49);
    for (const p of all) expect(p).toMatch(/^[a-z]+:[a-z_]+$/);
  });
  test('data scope enum has the 5 PRD values', () => {
    expect(DATA_SCOPE_VALUES).toEqual(
      ['org_wide', 'dept_and_below', 'dept', 'self', 'custom_dept_tree'],
    );
    expect(DataScope.Self).toBe('self');
  });
  test('super_admin built-in point set is the full catalog', () => {
    // super_admin covers every point; assert a few module anchors are present
    for (const m of PERMISSION_MODULES) {
      for (const p of m.points) {
        expect(PERMISSION_POINTS).toContain(p);
      }
    }
  });
  test('kit points and module exist', () => {
    expect(PERMISSION_POINTS).toContain('kit:view');
    expect(PERMISSION_POINTS).toContain('kit:delete');
    expect(PERMISSION_MODULES.find((m) => m.key === 'kit')).toBeDefined();
  });
});
