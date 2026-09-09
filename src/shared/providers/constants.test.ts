import { describe, expect, test } from 'vitest';

import { ProviderName } from './constants';

describe('ProviderName constants', () => {
  test('contains expected provider keys', () => {
    expect(ProviderName.OpenAI).toBe('openai');
    expect(ProviderName.DeepSeek).toBe('deepseek');
    expect(ProviderName.Custom).toBe('custom');
    expect(ProviderName.GenworkServer).toBe('genwork-server');
  });
});
