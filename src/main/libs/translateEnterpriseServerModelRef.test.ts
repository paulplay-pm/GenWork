import { describe, expect, test } from 'vitest';

import { translateEnterpriseServerModelRef } from './agentEnterpriseSync';

const serverModels = [
  { provider: 'deepseek', model: 'deepseek-flash', displayName: null },
  { provider: 'openai', model: 'gpt-5', displayName: 'GPT-5' },
  { provider: 'genwork', model: 'Qwen3.8-27B', displayName: null },
];

const DEFAULT_REF = 'genwork-server/deepseek-flash';

describe('translateEnterpriseServerModelRef', () => {
  test('empty ref → no model configured, matched', () => {
    expect(translateEnterpriseServerModelRef('', serverModels, DEFAULT_REF))
      .toEqual({ ref: '', matched: true });
    expect(translateEnterpriseServerModelRef('   ', serverModels, DEFAULT_REF))
      .toEqual({ ref: '', matched: true });
  });

  test('org ref with a loaded model (no display name) → genwork-server/<model>', () => {
    // deepseek/deepseek-flash has no display_name, so the ref uses the model id.
    expect(translateEnterpriseServerModelRef('deepseek/deepseek-flash', serverModels, DEFAULT_REF))
      .toEqual({ ref: 'genwork-server/deepseek-flash', matched: true });
  });

  test('org ref with a loaded model (display name present) → genwork-server/<displayName>', () => {
    // toOpenClawModelRef uses `name` (= displayName ?? model) for server models,
    // so the stored ref must carry the display name.
    expect(translateEnterpriseServerModelRef('openai/gpt-5', serverModels, DEFAULT_REF))
      .toEqual({ ref: 'genwork-server/GPT-5', matched: true });
  });

  test('configured ref with no matching loaded model → defaultRef, not matched', () => {
    expect(translateEnterpriseServerModelRef('unknown/model-x', serverModels, DEFAULT_REF))
      .toEqual({ ref: DEFAULT_REF, matched: false });
  });

  test('malformed ref (no usable slash) → defaultRef, not matched', () => {
    expect(translateEnterpriseServerModelRef('noslash', serverModels, DEFAULT_REF))
      .toEqual({ ref: DEFAULT_REF, matched: false });
    expect(translateEnterpriseServerModelRef('/trailing', serverModels, DEFAULT_REF))
      .toEqual({ ref: DEFAULT_REF, matched: false });
    expect(translateEnterpriseServerModelRef('leading/', serverModels, DEFAULT_REF))
      .toEqual({ ref: DEFAULT_REF, matched: false });
  });

  test('matches on the exact org provider+model, not substring', () => {
    // 'deepseek/deepseek' is a different model than 'deepseek/deepseek-flash'.
    expect(translateEnterpriseServerModelRef('deepseek/deepseek', serverModels, DEFAULT_REF))
      .toEqual({ ref: DEFAULT_REF, matched: false });
  });

  test('uses the catalog UUID for the ref when the entry carries an id', () => {
    const withIds = [
      { provider: 'vllm', model: 'Qwen3.8-27B', displayName: 'Qwen A', id: 'uuid-a' },
      { provider: 'custom-1789221049302', model: 'Qwen3.8-27B', displayName: 'Qwen B', id: 'uuid-b' },
    ];
    // The desktop identity is the catalog UUID so two same-named rows under
    // different provider keys resolve to distinct, switchable refs.
    expect(translateEnterpriseServerModelRef('vllm/Qwen3.8-27B', withIds, DEFAULT_REF))
      .toEqual({ ref: 'genwork-server/uuid-a', matched: true });
    expect(translateEnterpriseServerModelRef('custom-1789221049302/Qwen3.8-27B', withIds, DEFAULT_REF))
      .toEqual({ ref: 'genwork-server/uuid-b', matched: true });
  });

  test('falls back to the display name when the entry has no id (legacy)', () => {
    const noIds = [{ provider: 'openai', model: 'gpt-5', displayName: 'GPT-5' }];
    expect(translateEnterpriseServerModelRef('openai/gpt-5', noIds, DEFAULT_REF))
      .toEqual({ ref: 'genwork-server/GPT-5', matched: true });
  });
});
