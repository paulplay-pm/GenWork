import { describe, expect, test } from 'vitest';

import { resolveOpenClawThinkingLevelForModel } from './openclawModelThinkingLevels';

describe('resolveOpenClawThinkingLevelForModel', () => {
  test('does not rewrite other providers or unconfigured levels', () => {
    expect(resolveOpenClawThinkingLevelForModel('openai/gpt-5', 'max')).toBe('max');
    expect(resolveOpenClawThinkingLevelForModel(
      'genwork-server/deepseek-v4-flash',
      'high',
    )).toBe('high');
  });
});
