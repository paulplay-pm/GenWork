export const GenworkModelRuntimeProfile = {
  MoonshotKimiK3: 'moonshot-kimi-k3',
} as const;

export type GenworkModelRuntimeProfile =
  typeof GenworkModelRuntimeProfile[keyof typeof GenworkModelRuntimeProfile];

export type GenworkModelProfileMap = Record<string, GenworkModelRuntimeProfile>;

export const ModelProfileTransportDecision = {
  Passthrough: 'passthrough',
  MoonshotKimiK3: 'moonshot-kimi-k3',
  Reject: 'reject',
} as const;

export type ModelProfileTransportDecision =
  | { kind: typeof ModelProfileTransportDecision.Passthrough }
  | { kind: typeof ModelProfileTransportDecision.MoonshotKimiK3 }
  | {
      kind: typeof ModelProfileTransportDecision.Reject;
      expectedApi: 'openai-completions';
      actualApi: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const isModelRef = (value: string): boolean => {
  const separatorIndex = value.indexOf('/');
  return separatorIndex > 0
    && separatorIndex < value.length - 1
    && !/\s/.test(value);
};

export const parseModelProfileMap = (value: unknown): GenworkModelProfileMap => {
  if (!isRecord(value)) return {};
  const result: GenworkModelProfileMap = {};
  for (const [modelRef, profile] of Object.entries(value).sort(([a], [b]) =>
    a.localeCompare(b))) {
    if (
      isModelRef(modelRef)
      && profile === GenworkModelRuntimeProfile.MoonshotKimiK3
    ) {
      result[modelRef] = profile;
    }
  }
  return result;
};

export const hasModelRuntimeProfile = (
  modelProfiles: GenworkModelProfileMap,
  provider: string,
  modelId: string,
  profile: GenworkModelRuntimeProfile,
): boolean => modelProfiles[`${provider}/${modelId}`] === profile;

export const resolveModelProfileTransportDecision = (params: {
  modelProfiles: GenworkModelProfileMap;
  provider: string;
  modelId: string;
  modelApi?: string;
}): ModelProfileTransportDecision => {
  if (!hasModelRuntimeProfile(
    params.modelProfiles,
    params.provider,
    params.modelId,
    GenworkModelRuntimeProfile.MoonshotKimiK3,
  )) {
    return { kind: ModelProfileTransportDecision.Passthrough };
  }
  if (params.modelApi !== 'openai-completions') {
    return {
      kind: ModelProfileTransportDecision.Reject,
      expectedApi: 'openai-completions',
      actualApi: params.modelApi ?? 'missing',
    };
  }
  return { kind: ModelProfileTransportDecision.MoonshotKimiK3 };
};
