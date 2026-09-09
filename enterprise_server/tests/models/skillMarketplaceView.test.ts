import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { skillStoreDir, stateDir } from '../../src/lib/stateDir';
import { scopeMatches, scopeSummary, UNCATEGORIZED } from '../../src/models/skillMarketplaceView';

describe('skillMarketplaceView', () => {
  test('UNCATEGORIZED is the reserved slug', () => {
    expect(UNCATEGORIZED).toBe('uncategorized');
  });
});

describe('stateDir skill storage', () => {
  test('skillStoreDir nests under the state dir', () => {
    expect(skillStoreDir('canvas-design')).toBe(
      join(stateDir(), 'skill-marketplace', 'canvas-design'),
    );
  });
});

describe('scopeMatches (skill)', () => {
  const empty = { allCompany: false, deptIds: [] as string[], userIds: [] as string[] };
  test('allCompany grants everyone', () => {
    expect(scopeMatches({ allCompany: true, deptIds: [], userIds: [] }, [], 'u1')).toBe(true);
  });
  test('member exception via userIds', () => {
    expect(scopeMatches({ allCompany: false, deptIds: [], userIds: ['u1'] }, [], 'u1')).toBe(true);
    expect(scopeMatches({ allCompany: false, deptIds: [], userIds: ['u1'] }, [], 'u2')).toBe(false);
  });
  test('dept id in the caller (already-expanded) dept set', () => {
    expect(scopeMatches({ allCompany: false, deptIds: ['d1'], userIds: [] }, ['d1', 'd2'], 'u1')).toBe(true);
    expect(scopeMatches({ allCompany: false, deptIds: ['dX'], userIds: [] }, ['d1', 'd2'], 'u1')).toBe(false);
  });
  test('union: member OR dept', () => {
    const s = { allCompany: false, deptIds: ['d1'], userIds: ['u9'] };
    expect(scopeMatches(s, ['d1'], 'u9')).toBe(true);
    expect(scopeMatches(s, ['d1'], 'u1')).toBe(true);
    expect(scopeMatches(s, [], 'u1')).toBe(false);
  });
  test('empty scope grants no one', () => {
    expect(scopeMatches(empty, ['d1'], 'u1')).toBe(false);
  });
});

describe('scopeSummary (skill)', () => {
  test('all / none / depts / depts+users', () => {
    expect(scopeSummary({ allCompany: true, deptIds: [], userIds: [] })).toBe('all');
    expect(scopeSummary({ allCompany: false, deptIds: [], userIds: [] })).toBe('none');
    expect(scopeSummary({ allCompany: false, deptIds: ['a', 'b'], userIds: [] })).toBe('depts:2');
    expect(scopeSummary({ allCompany: false, deptIds: ['a'], userIds: ['x', 'y'] })).toBe('depts:1,users:2');
  });
});
