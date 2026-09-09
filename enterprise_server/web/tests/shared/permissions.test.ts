import { describe, expect, test } from 'vitest';

import {
  DATA_SCOPE_VALUES,
  dataScopeLabelKey,
  moduleLabelKey,
  PERMISSION_MODULES,
  PERMISSION_POINTS,
  pointLabelKey,
} from '../../src/shared/permissions';

describe('fine-grained permission catalog', () => {
  test('catalog is intact: 41 unique points grouped into the 10 modules', () => {
    expect(PERMISSION_POINTS).toHaveLength(41);
    // Points that were the subject of the coarse→fine migration.
    expect(PERMISSION_POINTS).toContain('dept:adjust_member');
    expect(PERMISSION_POINTS).toContain('provider:rotate');
    expect(PERMISSION_POINTS).toContain('agent:publish');
    // No duplicates, and the module grouping covers exactly the catalog.
    expect(new Set(PERMISSION_POINTS).size).toBe(PERMISSION_POINTS.length);
    expect(PERMISSION_MODULES.map((m) => m.points).flat()).toEqual(PERMISSION_POINTS);
  });

  test('data scope values', () => {
    expect(DATA_SCOPE_VALUES).toEqual([
      'org_wide',
      'dept_and_below',
      'dept',
      'self',
      'custom_dept_tree',
    ]);
  });

  test('label key helpers build the i18n keys', () => {
    expect(pointLabelKey('user:view')).toBe('roles.point.user:view');
    expect(moduleLabelKey('agent')).toBe('roles.module.agent');
    expect(dataScopeLabelKey('org_wide')).toBe('roles.scope.org_wide');
  });
});
