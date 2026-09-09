import { expect, test } from 'vitest';

import {
  MediaGenerationGateReason,
  MediaGenerationTool,
  MediaSelectionMode,
  resolveMediaGenerationGate,
} from './mediaGenerationPolicy';

test('media generation gate blocks generate without selection or explicit model', () => {
  expect(resolveMediaGenerationGate({
    action: 'generate',
    tool: MediaGenerationTool.Image,
  })).toEqual({
    allowed: false,
    reason: MediaGenerationGateReason.MediaNotEnabled,
    message: 'Tool unavailable: This media generation tool is not available in this session. No media generation model has been selected by the user. Do not retry.',
  });
});

test('media generation gate blocks generate with explicit model but no UI selection', () => {
  expect(resolveMediaGenerationGate({
    action: 'generate',
    tool: MediaGenerationTool.Image,
  })).toEqual({
    allowed: false,
    reason: MediaGenerationGateReason.MediaNotEnabled,
    message: 'Tool unavailable: This media generation tool is not available in this session. No media generation model has been selected by the user. Do not retry.',
  });
});

test('media generation gate allows generate when UI selection is present', () => {
  expect(resolveMediaGenerationGate({
    action: 'generate',
    tool: MediaGenerationTool.Image,
    selection: { mode: MediaSelectionMode.Image, modelId: 'doubao-seedream-5-0-260128' },
  })).toEqual({ allowed: true });
});

test('media generation gate blocks wrong media type from selected turn model', () => {
  expect(resolveMediaGenerationGate({
    action: 'generate',
    tool: MediaGenerationTool.Image,
    selection: { mode: MediaSelectionMode.Video, modelId: 'doubao-seedance-2-0-260128' },
  })).toEqual({
    allowed: false,
    reason: MediaGenerationGateReason.WrongMediaType,
    message: 'Image generation is not available. The user selected a video generation model for this turn.',
  });
});
