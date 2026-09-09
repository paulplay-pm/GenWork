import { describe, expect, test } from 'vitest';

import {
  GenworkThinkingLevel,
  resolveOpenClawThinkingProfile,
} from '../../../openclaw-extensions/genwork-model-compat/thinkingProfileMapping';

describe('genwork model compatibility thinking profile precedence', () => {
  test('prefers a server thinking profile when a Kimi K3 runtime profile also exists', () => {
    expect(resolveOpenClawThinkingProfile({
      options: [
        { level: GenworkThinkingLevel.Off, openclawLevel: 'off' },
        { level: GenworkThinkingLevel.High, openclawLevel: 'high' },
        { level: GenworkThinkingLevel.Max, openclawLevel: 'xhigh' },
      ],
      defaultLevel: GenworkThinkingLevel.High,
    }, true)).toEqual({
      levels: [
        { id: 'off', label: 'off' },
        { id: 'high', label: 'high' },
        { id: 'xhigh', label: 'max' },
      ],
      defaultLevel: 'high',
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  test('uses the max-only Kimi K3 fallback when no server thinking profile exists', () => {
    expect(resolveOpenClawThinkingProfile(undefined, true)).toEqual({
      levels: [{ id: 'max', label: 'max' }],
      defaultLevel: 'max',
      preserveWhenCatalogReasoningFalse: true,
    });
  });
});