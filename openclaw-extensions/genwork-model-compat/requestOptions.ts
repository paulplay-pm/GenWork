import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';

import {
  GENWORK_REQUEST_OPTIONS_FIELD,
  GENWORK_REQUEST_OPTIONS_VERSION,
} from './requestOptionsProtocol';
import type {
  GenworkThinkingLevel,
  GenworkThinkingProfile,
} from './thinkingProfileMapping';

export {
  GENWORK_REQUEST_OPTIONS_FIELD,
  GENWORK_REQUEST_OPTIONS_VERSION,
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const loadDefaultStreamFn = async (): Promise<StreamFn> => {
  const { streamSimple } = await import('openclaw/plugin-sdk/llm');
  return streamSimple as StreamFn;
};

export const resolveGenworkRequestThinkingLevel = (
  profile: GenworkThinkingProfile,
  requestedLevel: string | undefined,
): GenworkThinkingLevel => (
  profile.options.find(option => option.openclawLevel === requestedLevel)?.level
    ?? profile.defaultLevel
);

const applyRequestOptions = (
  payload: unknown,
  thinkingLevel: GenworkThinkingLevel,
): unknown => {
  if (!isRecord(payload)) return payload;
  // Single-write emit under the genwork_options wire field. After Phase 3,
  // the legacy genwork_options field is no longer written or accepted.
  const options = {
    version: GENWORK_REQUEST_OPTIONS_VERSION,
    thinking: { level: thinkingLevel },
  };
  payload[GENWORK_REQUEST_OPTIONS_FIELD] = options;
  return payload;
};

export const createGenworkRequestOptionsWrapper = (
  baseStreamFn: StreamFn | undefined,
  thinkingLevel: GenworkThinkingLevel,
): StreamFn => {
  return async (model, context, options) => {
    const underlying = baseStreamFn ?? (await loadDefaultStreamFn());
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload, payloadModel) => {
        const result = originalOnPayload?.(payload, payloadModel);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return Promise.resolve(result).then(resolved => (
            applyRequestOptions(resolved ?? payload, thinkingLevel)
          ));
        }
        return applyRequestOptions(result ?? payload, thinkingLevel);
      },
    });
  };
};
