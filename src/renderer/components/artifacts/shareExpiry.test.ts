import { describe, expect, test } from 'vitest';

import { computeShareExpiryIso, ShareExpiryPreset } from './shareExpiry';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('computeShareExpiryIso', () => {
  test('returns undefined for the forever preset', () => {
    expect(computeShareExpiryIso(ShareExpiryPreset.Forever, undefined, NOW)).toBeUndefined();
  });

  test('computes a future instant for day-based presets', () => {
    expect(computeShareExpiryIso(ShareExpiryPreset.OneDay, undefined, NOW))
      .toBe(new Date(NOW + DAY_MS).toISOString());
    expect(computeShareExpiryIso(ShareExpiryPreset.SevenDays, undefined, NOW))
      .toBe(new Date(NOW + 7 * DAY_MS).toISOString());
    expect(computeShareExpiryIso(ShareExpiryPreset.NinetyDays, undefined, NOW))
      .toBe(new Date(NOW + 90 * DAY_MS).toISOString());
  });

  test('uses the custom date when it is in the future', () => {
    const custom = '2030-01-01T12:00:00Z';
    expect(computeShareExpiryIso(ShareExpiryPreset.Custom, custom, NOW))
      .toBe(new Date(Date.parse(custom)).toISOString());
  });

  test('returns undefined for a custom date that is missing, invalid, or in the past', () => {
    expect(computeShareExpiryIso(ShareExpiryPreset.Custom, undefined, NOW)).toBeUndefined();
    expect(computeShareExpiryIso(ShareExpiryPreset.Custom, 'not-a-date', NOW)).toBeUndefined();
    // Past relative to NOW (2023-11-14), so it must be rejected.
    expect(computeShareExpiryIso(ShareExpiryPreset.Custom, '2000-01-01T00:00:00Z', NOW)).toBeUndefined();
  });
});
