import { describe, expect, test } from 'vitest';

import { brandColor, BRAND_COLORS } from '../../src/data/providerCatalog';

// `BUILTIN_SLUGS` (9 slugs) and `BRAND_COLORS` coverage lives in
// tests/api/modelTypes.test.ts; this file covers the surviving `brandColor`
// helper (the rail's brand-square color lookup).
describe('data/providerCatalog.brandColor', () => {
  test('returns the brand color for a known slug', () => {
    expect(brandColor('openai')).toBe(BRAND_COLORS.openai);
    expect(brandColor('anthropic')).toBe('#D97757');
    expect(brandColor('volc')).toBe('#0D8AFF');
  });

  test('falls back to the neutral gray for unknown slugs', () => {
    expect(brandColor('not-a-real-provider')).toBe('#6B7280');
    expect(brandColor('')).toBe('#6B7280');
  });
});
