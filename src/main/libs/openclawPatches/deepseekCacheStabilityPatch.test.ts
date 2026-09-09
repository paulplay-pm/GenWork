import { describe, expect, test } from 'vitest';

import { readCurrentOpenClawPatch } from './patchTestUtils';

describe('OpenClaw DeepSeek tool-result cache stability patch', () => {
  test('keeps existing live prompt history byte-stable as tool results grow', () => {
    const patch = readCurrentOpenClawPatch('openclaw-live-tool-result-cache-stability.patch');

    expect(patch).toContain('+            null,');
    expect(patch).toContain('+                    null,');
    expect(patch).toContain('+  aggregateMaxCharsOverride?: number | null');
    expect(patch).toContain('+    aggregateMaxCharsOverride === null');
    expect(patch).toContain('+      ? Number.POSITIVE_INFINITY');
    expect(patch).toContain('keeps prompt projections byte-stable as history grows');
    expect(patch).toContain('second.messages.slice(0, messages.length)');
    expect(patch).not.toContain(
      'keeps aggregate-bounded prompt projections byte-stable across retry and fallback',
    );
  });
});
