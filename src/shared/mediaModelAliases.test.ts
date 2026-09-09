import { describe, expect, it } from 'vitest';

import {
  canonicalizeMediaModelId,
  GPT_IMAGE_2_MODEL_ID,
  mediaModelDisplayName,
} from './mediaModelAliases';

describe('mediaModelAliases', () => {
  it('canonicalizes legacy Canvas 20 model id', () => {
    expect(canonicalizeMediaModelId('canvas-20')).toBe(GPT_IMAGE_2_MODEL_ID);
    expect(canonicalizeMediaModelId(' gpt-image-2 ')).toBe(GPT_IMAGE_2_MODEL_ID);
  });

  it('uses gpt-image-2 as display name for Canvas 20 alias', () => {
    expect(mediaModelDisplayName('canvas-20', 'Canvas 20')).toBe(GPT_IMAGE_2_MODEL_ID);
    expect(mediaModelDisplayName('banana-2', 'Banana 2')).toBe('Banana 2');
  });
});
