import { describe, expect, test } from 'vitest';
import { MODEL_TYPE_VALUES } from '../../src/api/models';
import { BUILTIN_SLUGS, BRAND_COLORS } from '../../src/data/providerCatalog';

describe('model/provider shared types', () => {
  test('MODEL_TYPE_VALUES has exactly the 8 PRD values', () => {
    expect([...MODEL_TYPE_VALUES].sort()).toEqual(
      ['asr', 'chat', 'embedding', 'image-gen', 'reasoning', 'rerank', 'tts', 'vision'].sort(),
    );
  });
  test('BUILTIN_SLUGS are the 9 PRD providers', () => {
    expect(BUILTIN_SLUGS).toHaveLength(9);
    expect(BUILTIN_SLUGS).toContain('volc');
    expect(BUILTIN_SLUGS).toContain('minimax');
    expect(BUILTIN_SLUGS).not.toContain('gemini');
  });
  test('every builtin slug has a brand color', () => {
    for (const s of BUILTIN_SLUGS) expect(BRAND_COLORS[s]).toBeTruthy();
  });
});
