/**
 * Share expiry presets for the artifact-file share dialog.
 *
 * The enterprise server stores `expires_at` and the page endpoint 410s once
 * past it; the desktop just picks an instant and passes it at create time.
 * These presets keep the UI simple (no free-text typing) while still allowing
 * a specific date/time via the `custom` preset.
 */
export const ShareExpiryPreset = {
  Forever: 'forever',
  OneDay: '1d',
  SevenDays: '7d',
  ThirtyDays: '30d',
  NinetyDays: '90d',
  Custom: 'custom',
} as const;

export type ShareExpiryPreset =
  (typeof ShareExpiryPreset)[keyof typeof ShareExpiryPreset];

const DAY_MS = 24 * 60 * 60 * 1000;

function presetToDays(
  preset: Exclude<
    ShareExpiryPreset,
    typeof ShareExpiryPreset.Forever | typeof ShareExpiryPreset.Custom
  >,
): number {
  switch (preset) {
    case ShareExpiryPreset.OneDay:
      return 1;
    case ShareExpiryPreset.SevenDays:
      return 7;
    case ShareExpiryPreset.ThirtyDays:
      return 30;
    case ShareExpiryPreset.NinetyDays:
      return 90;
  }
}

/**
 * Resolve a preset + optional custom date into an ISO 8601 expiry instant,
 * or `undefined` when the share should not expire. A non-parseable or
 * past-dated custom value yields `undefined` rather than an invalid
 * already-expired share. `nowMs` is injected so the function is deterministic
 * in tests.
 */
export function computeShareExpiryIso(
  preset: ShareExpiryPreset,
  customIso: string | undefined,
  nowMs: number,
): string | undefined {
  if (preset === ShareExpiryPreset.Forever) return undefined;
  if (preset === ShareExpiryPreset.Custom) {
    const parsed = customIso ? Date.parse(customIso) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= nowMs) return undefined;
    return new Date(parsed).toISOString();
  }
  return new Date(nowMs + presetToDays(preset) * DAY_MS).toISOString();
}
