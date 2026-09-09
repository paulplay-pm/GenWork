import { describe, expect, test } from 'vitest';

import { computeRevokedSkillNames, SkillAccessGate } from './skillAccessGate';

describe('computeRevokedSkillNames', () => {
  test('flags installed skills absent from the visible list', () => {
    const installed = [
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta' },
      { id: 'c', name: 'gamma' },
    ];
    const visible = [{ id: 'a' }, { id: 'b' }];
    expect(computeRevokedSkillNames(installed, visible)).toEqual(['gamma']);
  });

  test('no revocation when all installed are visible', () => {
    expect(computeRevokedSkillNames([{ id: 'a', name: 'alpha' }], [{ id: 'a' }])).toEqual([]);
  });

  test('empty visible list revokes all installed', () => {
    expect(computeRevokedSkillNames([{ id: 'a', name: 'alpha' }], [])).toEqual(['alpha']);
  });
});

describe('SkillAccessGate.sync', () => {
  test('only mutates on a successful recompute', () => {
    const gate = new SkillAccessGate();

    // First successful sync establishes the disabled set.
    const first = gate.sync([
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta' },
    ], [{ id: 'a' }]);
    expect(first.changed).toBe(true);
    expect([...gate.disabledNames()].sort()).toEqual(['beta']);

    // A second identical successful sync is a no-op (no churn).
    const second = gate.sync([
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta' },
    ], [{ id: 'a' }]);
    expect(second.changed).toBe(false);
    expect([...gate.disabledNames()].sort()).toEqual(['beta']);
  });

  test('a failed recompute (null) keeps the last known set', () => {
    const gate = new SkillAccessGate();
    gate.sync([{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }], [{ id: 'a' }]);
    expect([...gate.disabledNames()]).toEqual(['beta']);

    // Simulate a fetch failure: sync(_, null) must NOT clear the last-known set.
    const result = gate.sync([{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }], null);
    expect(result.changed).toBe(false);
    expect([...gate.disabledNames()]).toEqual(['beta']);
  });

  test('a successful recompute can clear a previously revoked skill', () => {
    const gate = new SkillAccessGate();
    gate.sync([{ id: 'a', name: 'alpha' }], []);
    expect([...gate.disabledNames()]).toEqual(['alpha']);

    // Admin re-enables the skill: it reappears in the visible list.
    const result = gate.sync([{ id: 'a', name: 'alpha' }], [{ id: 'a' }]);
    expect(result.changed).toBe(true);
    expect([...gate.disabledNames()]).toEqual([]);
  });
});
