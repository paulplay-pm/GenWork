import { expect, test } from 'vitest';

import { DATA_SCOPE_VALUES, PERMISSION_MODULES, PERMISSION_POINTS } from '../../src/shared/permissions';
const expected = {
  user: ['user:view','user:create','user:edit','user:delete','user:export'],
  role: ['role:view','role:create','role:edit','role:delete'],
  dept: ['dept:view','dept:create','dept:edit','dept:delete','dept:adjust_member'],
  model: ['model:view','model:create','model:edit','model:delete'],
  provider: ['provider:view','provider:edit','provider:rotate'],
  skill: ['skill:view','skill:create','skill:edit','skill:toggle'],
  audit: ['audit:view','audit:export'],
  version: ['version:view','version:create','version:edit','version:publish','version:rollback'],
  mcp: ['mcp:view','mcp:create','mcp:edit','mcp:delete'],
  agent: ['agent:view','agent:create','agent:edit','agent:delete','agent:publish'],
};
test('SPA catalog matches server (codes + grouping)', () => {
  expect(PERMISSION_POINTS).toHaveLength(41);
  for (const m of PERMISSION_MODULES) {
    expect(m.points).toEqual(expected[m.key as keyof typeof expected]);
  }
  expect(PERMISSION_MODULES.map((m) => m.key)).toEqual(['user', 'role', 'dept', 'model', 'provider', 'skill', 'audit', 'version', 'mcp', 'agent']);
});
test('data scope values', () => {
  expect(DATA_SCOPE_VALUES).toEqual(['org_wide','dept_and_below','dept','self','custom_dept_tree']);
});
