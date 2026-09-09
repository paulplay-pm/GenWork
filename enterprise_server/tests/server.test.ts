import { describe, expect, test } from 'vitest';

import { serve } from '../src/server';

describe('enterprise_server entry', () => {
  test('serve() exports a callable function', () => {
    expect(typeof serve).toBe('function');
  });
});
