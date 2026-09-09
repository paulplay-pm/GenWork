import { describe, expect, test } from 'vitest';

import {
  GenworkModelRuntimeProfile,
  hasModelRuntimeProfile,
  ModelProfileTransportDecision,
  parseModelProfileMap,
  resolveModelProfileTransportDecision,
} from '../openclaw-extensions/genwork-model-compat/profileMapping';

describe('genwork-model-compat profile mapping', () => {
  test('keeps only exact valid model refs and known profiles in deterministic order', () => {
    expect(parseModelProfileMap({
      'custom_2/alias-k3': 'moonshot-kimi-k3',
      'custom_0/kimi-k3': 'moonshot-kimi-k3',
      'invalid-ref': 'moonshot-kimi-k3',
      'custom_1/other': 'unknown-profile',
    })).toEqual({
      'custom_0/kimi-k3': GenworkModelRuntimeProfile.MoonshotKimiK3,
      'custom_2/alias-k3': GenworkModelRuntimeProfile.MoonshotKimiK3,
    });
  });

  test('matches the configured provider/model ref exactly', () => {
    const profiles = parseModelProfileMap({
      'custom_0/Kimi_K3': 'moonshot-kimi-k3',
    });

    expect(hasModelRuntimeProfile(
      profiles,
      'custom_0',
      'Kimi_K3',
      GenworkModelRuntimeProfile.MoonshotKimiK3,
    )).toBe(true);
    expect(hasModelRuntimeProfile(
      profiles,
      'custom_0',
      'kimi-k3',
      GenworkModelRuntimeProfile.MoonshotKimiK3,
    )).toBe(false);
  });

  test('passes through an unmapped model under a compatibility-owned provider', () => {
    const profiles = parseModelProfileMap({
      'custom_0/my-kimi-prod': 'moonshot-kimi-k3',
    });

    expect(resolveModelProfileTransportDecision({
      modelProfiles: profiles,
      provider: 'custom_0',
      modelId: 'plain-model',
      modelApi: 'anthropic-messages',
    })).toEqual({
      kind: ModelProfileTransportDecision.Passthrough,
    });
  });

  test('accepts only the real Kimi K3 transport and rejects recursive ownership', () => {
    const profiles = parseModelProfileMap({
      'custom_0/my-kimi-prod': 'moonshot-kimi-k3',
    });

    expect(resolveModelProfileTransportDecision({
      modelProfiles: profiles,
      provider: 'custom_0',
      modelId: 'my-kimi-prod',
      modelApi: 'openai-completions',
    })).toEqual({
      kind: ModelProfileTransportDecision.MoonshotKimiK3,
    });
    expect(resolveModelProfileTransportDecision({
      modelProfiles: profiles,
      provider: 'custom_0',
      modelId: 'my-kimi-prod',
      modelApi: 'genwork-model-compat',
    })).toEqual({
      kind: ModelProfileTransportDecision.Reject,
      expectedApi: 'openai-completions',
      actualApi: 'genwork-model-compat',
    });
  });
});