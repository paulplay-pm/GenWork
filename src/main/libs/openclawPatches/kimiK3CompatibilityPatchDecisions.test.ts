import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('Kimi K3 OpenClaw compatibility patch decisions', () => {
  test('backports the Moonshot K3 request and replay contract from upstream PR 109202', () => {
    expectPatchContains('openclaw-kimi-k3-support.patch', [
      'createMoonshotKimiK3Wrapper',
      'ensureMoonshotToolCallReasoningContent',
      'reasoning_effort = "max"',
      'thinkingLevelMap',
      'Type.Literal("video")',
      'Type.Literal("audio")',
      'rejects an invalid thinking-level map: $label',
      'reapplies the K3 payload contract after an async caller replacement',
    ]);
  });

  test('keeps the plugin API owner separate from concrete model transports', () => {
    expectPatchContains('openclaw-genwork-model-compat-api.patch', [
      'GENWORK_MODEL_COMPAT_API = "genwork-model-compat"',
      'MODEL_TRANSPORT_APIS',
      'ModelTransportApiSchema',
      'keeps a provider API owner out of model transport resolution',
      'rejects arbitrary provider API owner strings',
      'rejects recursive model-level compatibility ownership',
    ]);
  });

  test('backports OpenAI-compatible replay and provider error fidelity from upstream PR 109556', () => {
    expectPatchContains('openclaw-openai-compatible-replay-errors.patch', [
      'formatProviderError',
      'normalizes null or missing content before provider transforms',
      'surfaces HTTP response body text from OpenAI-compatible errors',
      'surfaces HTTP response body text from Google-compatible errors',
    ]);
  });

  test('backports occurrence-aware repeated tool-call pairing from upstream PR 110518', () => {
    expectPatchContains('openclaw-repeated-tool-call-id.patch', [
      'type ToolCallOccurrence = {',
      'function buildToolUseFrames',
      'sanitizeToolCallIds: false',
      'const pairedToolCalls =',
      'pairs repeated raw ids before assigning provider-safe occurrence ids',
      "does not reassign a dropped errored turn's repeated-id result to an older turn",
    ]);
  });
});
