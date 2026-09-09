import { expect, test } from 'vitest';

import { descendantsOf, effectiveScope, scopePredicate } from '../../src/auth/scopeResolver';

const PATH = new Map([
  ['/a', '/a'], ['/a/b', '/a/b'], ['/a/c', '/a/c'], ['/b', '/b'], ['/b/d', '/b/d'],
]);

test('descendantsOf expands via path prefix', () => {
  const d = descendantsOf(['/a'], PATH);
  expect([...d].sort()).toEqual(['/a', '/a/b', '/a/c']);
});

test('super_admin → all', () => {
  const s = effectiveScope({ roles: ['member'], callerDeptIds: ['/a'], roleScope: new Map(), deptPath: PATH, isSuperAdmin: true });
  expect(s).toEqual({ kind: 'all' });
});

test('no roles → self (fail-closed)', () => {
  const s = effectiveScope({ roles: [], callerDeptIds: ['/a'], roleScope: new Map(), deptPath: PATH, isSuperAdmin: false });
  expect(s).toEqual({ kind: 'self' });
});

test('all-unknown roles → self (fail-closed)', () => {
  const s = effectiveScope({ roles: ['ghost'], callerDeptIds: ['/a'], roleScope: new Map(), deptPath: PATH, isSuperAdmin: false });
  expect(s).toEqual({ kind: 'self' });
});

test('self short-circuits to self even with a broad role', () => {
  const s = effectiveScope({
    roles: ['r1', 'r2'], callerDeptIds: ['/a'],
    roleScope: new Map([
      ['r1', { dataScope: 'dept_and_below', customDeptIds: [] }],
      ['r2', { dataScope: 'self', customDeptIds: [] }],
    ]),
    deptPath: PATH, isSuperAdmin: false,
  });
  expect(s).toEqual({ kind: 'self' });
});

test('org_wide only → all', () => {
  const s = effectiveScope({
    roles: ['r1'], callerDeptIds: ['/a'],
    roleScope: new Map([['r1', { dataScope: 'org_wide', customDeptIds: [] }]]),
    deptPath: PATH, isSuperAdmin: false,
  });
  expect(s).toEqual({ kind: 'all' });
});

test('intersection takes the narrowest (a in both)', () => {
  const s = effectiveScope({
    roles: ['r1', 'r2'], callerDeptIds: ['/a'],
    roleScope: new Map([
      ['r1', { dataScope: 'org_wide', customDeptIds: [] }],          // identity
      ['r2', { dataScope: 'custom_dept_tree', customDeptIds: ['/b'] }],
    ]),
    deptPath: PATH, isSuperAdmin: false,
  });
  // intersection of (all) and {/b + descendants} = {/b,/b/d}
  expect(s.kind).toBe('dept');
  if (s.kind === 'dept') expect([...s.deptIds].sort()).toEqual(['/b', '/b/d']);
});

test('multi-dept caller: dept_and_below unions own subtrees', () => {
  const s = effectiveScope({
    roles: ['r1'], callerDeptIds: ['/a', '/b'],
    roleScope: new Map([['r1', { dataScope: 'dept_and_below', customDeptIds: [] }]]),
    deptPath: PATH, isSuperAdmin: false,
  });
  expect(s.kind).toBe('dept');
  if (s.kind === 'dept') expect([...s.deptIds].sort()).toEqual(['/a', '/a/b', '/a/c', '/b', '/b/d']);
});

test('scopePredicate: self filters to caller id', () => {
  const p = scopePredicate({ kind: 'self' }, 'u1');
  expect(p.where).toContain('u.id = $1');
  expect(p.params).toEqual(['u1']);
});
test('scopePredicate: dept uses ANY + concurrent-dept exists', () => {
  const p = scopePredicate({ kind: 'dept', deptIds: ['/a', '/b'] }, 'u1');
  expect(p.where).toContain('u.department_id = ANY($1)');
  expect(p.where).toContain('user_departments');
  expect(p.params).toEqual([['/a', '/b']]);
});
test('scopePredicate: all is a no-op', () => {
  const p = scopePredicate({ kind: 'all' }, 'u1');
  expect(p.where).toBe('1=1');
  expect(p.params).toEqual([]);
});
