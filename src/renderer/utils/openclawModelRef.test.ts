import { OpenClawProviderId, ProviderName } from '@shared/providers/constants';
import { describe, expect, test } from 'vitest';

import { resolveOpenClawModelRef, toOpenClawModelRef } from './openclawModelRef';

type ModelInput = {
  id: string;
  name: string;
  providerKey: string;
  openClawProviderId?: string;
  isServerModel?: boolean;
};

describe('toOpenClawModelRef', () => {
  test('server models use the catalog UUID as the ref portion', () => {
    const model: ModelInput = {
      id: '21e3e29a-a900-4574-b1bd-aaa8fb803ff1',
      name: 'Qwen3.8-27B',
      providerKey: ProviderName.GenworkServer,
      isServerModel: true,
    };
    // The identity is the catalog row UUID so two same-named rows resolve to
    // distinct refs; the display name stays the human-facing label.
    expect(toOpenClawModelRef(model)).toBe('genwork-server/21e3e29a-a900-4574-b1bd-aaa8fb803ff1');
  });

  test('non-server models use their model id', () => {
    const model: ModelInput = {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      providerKey: ProviderName.OpenAI,
      openClawProviderId: OpenClawProviderId.OpenAI,
    };
    expect(toOpenClawModelRef(model)).toBe('openai/gpt-5.4');
  });
});

describe('resolveOpenClawModelRef', () => {
  test('resolves a server-model UUID ref to its model', () => {
    const model: ModelInput = {
      id: '21e3e29a-a900-4574-b1bd-aaa8fb803ff1',
      name: 'Qwen3.8-27B',
      providerKey: ProviderName.GenworkServer,
      isServerModel: true,
    };
    expect(resolveOpenClawModelRef('genwork-server/21e3e29a-a900-4574-b1bd-aaa8fb803ff1', [model])).toBe(model);
  });

  test('resolves a legacy name ref to a unique server model by name', () => {
    // Refs saved before the identity moved to the catalog UUID carry the
    // upstream name. When the name maps to a single server model, resolve it.
    const model: ModelInput = {
      id: 'cda127a4-3b8a-4e31-854c-d6502c349253',
      name: 'Qwen3.8-27B',
      providerKey: ProviderName.GenworkServer,
      isServerModel: true,
    };
    expect(resolveOpenClawModelRef('genwork-server/Qwen3.8-27B', [model])).toBe(model);
  });

  test('an ambiguous legacy name ref (two same-named server models) resolves to null', () => {
    const a: ModelInput = {
      id: 'cda127a4-3b8a-4e31-854c-d6502c349253',
      name: 'Qwen3.8-27B',
      providerKey: ProviderName.GenworkServer,
      isServerModel: true,
    };
    const b: ModelInput = {
      id: '21e3e29a-a900-4574-b1bd-aaa8fb803ff1',
      name: 'Qwen3.8-27B',
      providerKey: ProviderName.GenworkServer,
      isServerModel: true,
    };
    // Two same-named rows: the name ref is ambiguous, so report it (null)
    // rather than guess — the user re-picks and the ref rewrites to a UUID.
    expect(resolveOpenClawModelRef('genwork-server/Qwen3.8-27B', [a, b])).toBeNull();
  });

  test('resolves legacy OpenAI Codex refs to the canonical OpenAI provider', () => {
    const model = {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      providerKey: ProviderName.OpenAI,
      openClawProviderId: OpenClawProviderId.OpenAI,
    };

    expect(resolveOpenClawModelRef('openai-codex/gpt-5.4', [model])).toBe(model);
  });

  test('keeps compatibility with old OpenAI OAuth model lists', () => {
    const model = {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      providerKey: ProviderName.OpenAI,
      openClawProviderId: OpenClawProviderId.OpenAICodex,
    };

    expect(resolveOpenClawModelRef('openai/gpt-5.4', [model])).toBe(model);
  });
});
