import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';
import { describe, expect, test } from 'vitest';

import {
  createGenworkRequestOptionsWrapper,
  GENWORK_REQUEST_OPTIONS_FIELD,
  resolveGenworkRequestThinkingLevel,
} from '../../../openclaw-extensions/genwork-model-compat/requestOptions';
import { GENWORK_REQUEST_OPTIONS_VERSION } from '../../../openclaw-extensions/genwork-model-compat/requestOptionsProtocol';
import type { GenworkThinkingProfile } from '../../../openclaw-extensions/genwork-model-compat/thinkingProfileMapping';

const profile: GenworkThinkingProfile = {
  options: [
    { level: 'off', openclawLevel: 'off' },
    { level: 'high', openclawLevel: 'high' },
    { level: 'max', openclawLevel: 'xhigh' },
  ],
  defaultLevel: 'high',
  requestOptionsVersion: 1,
};

describe('GenWork request options', () => {
  test('uses an allowed selected level and falls back to the profile default', () => {
    expect(resolveGenworkRequestThinkingLevel(profile, 'off')).toBe('off');
    expect(resolveGenworkRequestThinkingLevel(profile, 'xhigh')).toBe('max');
    expect(resolveGenworkRequestThinkingLevel(profile, 'low')).toBe('high');
    expect(resolveGenworkRequestThinkingLevel(profile, undefined)).toBe('high');
  });

  test('adds the final semantic thinking intent after the caller payload hook', async () => {
    let forwardedOptions: Parameters<StreamFn>[2] | undefined;
    const baseStreamFn: StreamFn = ((_model, _context, options) => {
      forwardedOptions = options;
      return {} as ReturnType<StreamFn>;
    }) as StreamFn;
    const wrapped = createGenworkRequestOptionsWrapper(baseStreamFn, 'off');

    await wrapped({} as never, {} as never, {
      onPayload: () => ({
        model: 'deepseek-v4-flash-GenworkInner',
        [GENWORK_REQUEST_OPTIONS_FIELD]: {
          version: 999,
          thinking: { level: 'max' },
        },
      }),
    });

    const payload = await forwardedOptions?.onPayload?.({}, {} as never);
    const expectedOptions = {
      version: GENWORK_REQUEST_OPTIONS_VERSION,
      thinking: { level: 'off' },
    };
    expect(payload).toEqual({
      model: 'deepseek-v4-flash-GenworkInner',
      [GENWORK_REQUEST_OPTIONS_FIELD]: expectedOptions,
    });
  });
});
