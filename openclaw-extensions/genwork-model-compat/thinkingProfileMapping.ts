import { GENWORK_REQUEST_OPTIONS_VERSION } from './requestOptionsProtocol';

export const GenworkThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
  Max: 'max',
} as const;

export type GenworkThinkingLevel =
  typeof GenworkThinkingLevel[keyof typeof GenworkThinkingLevel];

export const GenworkOpenClawThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
} as const;

export type GenworkOpenClawThinkingLevel =
  typeof GenworkOpenClawThinkingLevel[keyof typeof GenworkOpenClawThinkingLevel];

export type GenworkThinkingOption = {
  level: GenworkThinkingLevel;
  openclawLevel: GenworkOpenClawThinkingLevel;
};

export type GenworkThinkingProfile = {
  options: GenworkThinkingOption[];
  defaultLevel: GenworkThinkingLevel;
  requestOptionsVersion?: typeof GENWORK_REQUEST_OPTIONS_VERSION;
};

export type GenworkThinkingProfileMap = Record<string, GenworkThinkingProfile>;

export type GenworkOpenClawThinkingProfile = {
  levels: Array<{ id: string; label: string }>;
  defaultLevel: string;
  preserveWhenCatalogReasoningFalse: true;
};

const LEVELS = new Set<string>(Object.values(GenworkThinkingLevel));
const OPENCLAW_LEVELS = new Set<string>(Object.values(GenworkOpenClawThinkingLevel));

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const isModelRef = (value: string): boolean => {
  const separatorIndex = value.indexOf('/');
  return separatorIndex > 0
    && separatorIndex < value.length - 1
    && !/\s/.test(value);
};

const parseThinkingProfile = (value: unknown): GenworkThinkingProfile | undefined => {
  if (!isRecord(value) || !Array.isArray(value.options) || value.options.length === 0) {
    return undefined;
  }
  const options: GenworkThinkingOption[] = [];
  const seenLevels = new Set<string>();
  const seenOpenClawLevels = new Set<string>();
  for (const rawOption of value.options) {
    if (!isRecord(rawOption)) {
      return undefined;
    }
    const { level, openclawLevel } = rawOption;
    if (
      typeof level !== 'string'
      || !LEVELS.has(level)
      || seenLevels.has(level)
      || typeof openclawLevel !== 'string'
      || !OPENCLAW_LEVELS.has(openclawLevel)
      || seenOpenClawLevels.has(openclawLevel)
      || (level === GenworkThinkingLevel.Off)
        !== (openclawLevel === GenworkOpenClawThinkingLevel.Off)
    ) {
      return undefined;
    }
    seenLevels.add(level);
    seenOpenClawLevels.add(openclawLevel);
    options.push({
      level: level as GenworkThinkingLevel,
      openclawLevel: openclawLevel as GenworkOpenClawThinkingLevel,
    });
  }
  if (options.length === 1 && options[0]?.level === GenworkThinkingLevel.Off) {
    return undefined;
  }
  if (typeof value.defaultLevel !== 'string' || !seenLevels.has(value.defaultLevel)) {
    return undefined;
  }
  return {
    options,
    defaultLevel: value.defaultLevel as GenworkThinkingLevel,
    ...(value.requestOptionsVersion === GENWORK_REQUEST_OPTIONS_VERSION
      ? { requestOptionsVersion: GENWORK_REQUEST_OPTIONS_VERSION }
      : {}),
  };
};

export const parseThinkingProfileMap = (value: unknown): GenworkThinkingProfileMap => {
  if (!isRecord(value)) return {};
  const result: GenworkThinkingProfileMap = {};
  for (const [modelRef, rawProfile] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right))) {
    const profile = parseThinkingProfile(rawProfile);
    if (isModelRef(modelRef) && profile) {
      result[modelRef] = profile;
    }
  }
  return result;
};

export const resolveOpenClawThinkingProfile = (
  profile: GenworkThinkingProfile | undefined,
  hasKimiK3RuntimeProfile: boolean,
): GenworkOpenClawThinkingProfile | undefined => {
  if (profile) {
    const defaultOpenClawLevel = profile.options.find(
      option => option.level === profile.defaultLevel,
    )?.openclawLevel;
    if (!defaultOpenClawLevel) return undefined;
    return {
      levels: profile.options.map(option => ({
        id: option.openclawLevel,
        label: option.level,
      })),
      defaultLevel: defaultOpenClawLevel,
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  if (!hasKimiK3RuntimeProfile) return undefined;
  return {
    levels: [{ id: 'max', label: 'max' }],
    defaultLevel: 'max',
    preserveWhenCatalogReasoningFalse: true,
  };
};
