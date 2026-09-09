export const ProviderKeyStatus = {
  Unknown: 'unknown',
  Connected: 'connected',
  Failed: 'failed',
} as const;

export type ProviderKeyStatus =
  (typeof ProviderKeyStatus)[keyof typeof ProviderKeyStatus];