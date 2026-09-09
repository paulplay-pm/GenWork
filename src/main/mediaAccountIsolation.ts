export interface MediaTurnAccountScope {
  ownerAccountKey: string;
  accountGeneration: number;
}

export type AuthenticatedFetch = (url: string, options?: RequestInit) => Promise<Response>;

export interface AuthStateSnapshot {
  accountGeneration: number;
  accessToken: string;
  refreshToken: string;
}

export interface AuthExchangeIntentSnapshot {
  intentId: number;
  accountGeneration: number;
  accessToken: string | null;
  refreshToken: string | null;
}

export const canAccessTrackedMediaTask = (
  trackedOwnerAccountKey: string | null | undefined,
  requestScope: MediaTurnAccountScope | null,
): boolean => (
  trackedOwnerAccountKey != null
  && requestScope?.ownerAccountKey === trackedOwnerAccountKey
);

export const rememberMediaTaskOwnerAliases = (
  registry: Map<string, string>,
  ownerAccountKey: string,
  taskIds: readonly unknown[],
  maxAliases = 2_000,
): void => {
  for (const rawTaskId of taskIds) {
    if (rawTaskId === null || rawTaskId === undefined) continue;
    const taskId = String(rawTaskId).trim();
    if (!taskId) continue;
    registry.delete(taskId);
    registry.set(taskId, ownerAccountKey);
  }

  while (registry.size > maxAliases) {
    const oldestTaskId = registry.keys().next().value as string | undefined;
    if (!oldestTaskId) break;
    registry.delete(oldestTaskId);
  }
};

export const clearMediaTaskOwnerAliasesForOwner = (
  registry: Map<string, string>,
  ownerAccountKey: string,
): void => {
  for (const [taskId, trackedOwnerAccountKey] of registry) {
    if (trackedOwnerAccountKey === ownerAccountKey) {
      registry.delete(taskId);
    }
  }
};

export const shouldRemoveMediaTaskAfterPoll = (
  responseScope: MediaTurnAccountScope,
  currentScope: MediaTurnAccountScope | null,
  terminal: boolean,
): boolean => (
  terminal
  && currentScope !== null
  && currentScope.ownerAccountKey === responseScope.ownerAccountKey
  && currentScope.accountGeneration === responseScope.accountGeneration
);

export const isAuthStateSnapshotCurrent = (
  expected: AuthStateSnapshot,
  currentGeneration: number,
  currentTokens: { accessToken: string; refreshToken: string } | null,
): boolean => (
  currentGeneration === expected.accountGeneration
  && currentTokens?.accessToken === expected.accessToken
  && currentTokens.refreshToken === expected.refreshToken
);

export const isAuthExchangeIntentCurrent = (
  expected: AuthExchangeIntentSnapshot,
  activeIntentId: number | null,
  currentGeneration: number,
  currentTokens: { accessToken: string; refreshToken: string } | null,
): boolean => (
  activeIntentId === expected.intentId
  && currentGeneration === expected.accountGeneration
  && currentTokens?.accessToken === (expected.accessToken ?? undefined)
  && currentTokens?.refreshToken === (expected.refreshToken ?? undefined)
  && (
    currentTokens !== null
    || (expected.accessToken === null && expected.refreshToken === null)
  )
);
