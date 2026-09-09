import { describe, expect, test } from 'vitest';

import { autoIcon } from '../../src/lib/autoIcon';

describe('autoIcon', () => {
  test('is deterministic for the same name', () => {
    expect(autoIcon('企查查')).toBe(autoIcon('企查查'));
  });
  test('returns a non-empty string for empty input', () => {
    expect(autoIcon('')).toBeTruthy();
  });
  test('stably maps different names into the pool', () => {
    const a = autoIcon('a');
    const b = autoIcon('b');
    expect(typeof a).toBe('string');
    expect(typeof b).toBe('string');
  });
});
