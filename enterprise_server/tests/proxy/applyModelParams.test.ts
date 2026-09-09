import { describe, expect, test } from 'vitest';

import { applyModelParams } from '../../src/proxy/applyModelParams';

describe('proxy/applyModelParams', () => {
  test('admin values override client values (admin wins)', () => {
    const out = applyModelParams(
      { model: 'gpt-4o', temperature: 0.9, top_p: 1, max_tokens: 4096 },
      { temperature: 0.2, top_p: 0.1, max_output_tokens: 100 }
    ) as Record<string, unknown>;
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.1);
    expect(out.max_tokens).toBe(100);
    // Untouched fields survive.
    expect(out.model).toBe('gpt-4o');
  });

  test('null admin values leave client values alone', () => {
    const out = applyModelParams(
      { model: 'gpt-4o', temperature: 0.7 },
      { temperature: null, top_p: null, max_output_tokens: null }
    ) as Record<string, unknown>;
    expect(out.temperature).toBe(0.7);
    expect(out.top_p).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
  });

  test('partial admin values fill only the set fields', () => {
    const out = applyModelParams(
      { model: 'gpt-4o' },
      { temperature: null, top_p: 0.5, max_output_tokens: null }
    ) as Record<string, unknown>;
    expect(out.top_p).toBe(0.5);
    expect(out.temperature).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
  });

  test('does not mutate the caller object', () => {
    const body = { model: 'gpt-4o', temperature: 1 } as const;
    const before = { ...body };
    applyModelParams(body, { temperature: 0.1, top_p: null, max_output_tokens: null });
    expect(body).toEqual(before);
  });

  test('non-object bodies are returned unchanged (same reference)', () => {
    expect(applyModelParams(null, { temperature: 1, top_p: null, max_output_tokens: null })).toBeNull();
    expect(
      applyModelParams('str', { temperature: 1, top_p: null, max_output_tokens: null })
    ).toBe('str');
    const arr = [1, 2] as unknown;
    expect(applyModelParams(arr, { temperature: 1, top_p: null, max_output_tokens: null })).toBe(arr);
  });

  test('empty body with admin values becomes a fresh object with the params', () => {
    const out = applyModelParams(
      {},
      { temperature: 0.3, top_p: 0.4, max_output_tokens: 8 }
    ) as Record<string, unknown>;
    expect(out).toEqual({ temperature: 0.3, top_p: 0.4, max_tokens: 8 });
  });
});
