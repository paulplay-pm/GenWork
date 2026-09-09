export const DefaultKeyfrom = {
  Official: 'official',
} as const;

export type DefaultKeyfrom = (typeof DefaultKeyfrom)[keyof typeof DefaultKeyfrom];

export const KeyfromStoreKey = {
  Attribution: 'keyfrom.attribution.v1',
} as const;

export type KeyfromStoreKey = (typeof KeyfromStoreKey)[keyof typeof KeyfromStoreKey];

export const KeyfromEnv = {
  Keyfrom: 'KEYFROM',
} as const;

export type KeyfromEnv = (typeof KeyfromEnv)[keyof typeof KeyfromEnv];

export const KeyfromBuildResource = {
  Directory: 'keyfrom',
  Filename: 'keyfrom.json',
} as const;
