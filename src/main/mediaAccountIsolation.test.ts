import { describe, expect, test } from 'vitest';

import * as mediaAccountIsolation from './mediaAccountIsolation';
import {
  canAccessTrackedMediaTask,
  clearMediaTaskOwnerAliasesForOwner,
  isAuthExchangeIntentCurrent,
  isAuthStateSnapshotCurrent,
  type MediaTurnAccountScope,
  rememberMediaTaskOwnerAliases,
  shouldRemoveMediaTaskAfterPoll,
} from './mediaAccountIsolation';

const enterpriseScope: MediaTurnAccountScope = {
  ownerAccountKey: 'enterprise:6:1001',
  accountGeneration: 3,
};

test('MediaAccountScope is no longer exported', () => {
  expect('MediaAccountScope' in mediaAccountIsolation).toBe(false);
});

test('publisher-era account-scope helpers are no longer exported', () => {
  expect((mediaAccountIsolation as Record<string, unknown>).isMediaAccountScopeCurrent).toBeUndefined();
  expect((mediaAccountIsolation as Record<string, unknown>).isMediaAccountScopeSnapshotCurrent).toBeUndefined();
  expect((mediaAccountIsolation as Record<string, unknown>).createAccountScopedFetch).toBeUndefined();
  expect((mediaAccountIsolation as Record<string, unknown>).rebindMediaAccountScope).toBeUndefined();
  expect((mediaAccountIsolation as Record<string, unknown>).bindAccountValue).toBeUndefined();
  expect((mediaAccountIsolation as Record<string, unknown>).resolveAccountBoundValue).toBeUndefined();
  expect((mediaAccountIsolation as Record<string, unknown>).AccountBoundValue).toBeUndefined();
});

describe('canAccessTrackedMediaTask', () => {
  test('blocks status and cancel calls when a pending task belongs to another account', () => {
    expect(canAccessTrackedMediaTask(enterpriseScope.ownerAccountKey, enterpriseScope)).toBe(true);
    expect(canAccessTrackedMediaTask(enterpriseScope.ownerAccountKey, {
      ownerAccountKey: 'enterprise:6:1002',
      accountGeneration: enterpriseScope.accountGeneration,
    })).toBe(false);
    expect(canAccessTrackedMediaTask(enterpriseScope.ownerAccountKey, null)).toBe(false);
    expect(canAccessTrackedMediaTask(undefined, enterpriseScope)).toBe(false);
  });

  test('registers both internal and upstream task ids as explicit owner evidence', () => {
    const registry = new Map<string, string>();
    rememberMediaTaskOwnerAliases(
      registry,
      enterpriseScope.ownerAccountKey,
      [123, 'upstream-task-123'],
    );

    expect(registry.get('123')).toBe(enterpriseScope.ownerAccountKey);
    expect(registry.get('upstream-task-123')).toBe(enterpriseScope.ownerAccountKey);
    expect(registry.get('unknown-task')).toBeUndefined();
  });

  test('removes only aliases owned by the account being cleared', () => {
    const registry = new Map([
      ['task-a', enterpriseScope.ownerAccountKey],
      ['task-b', 'enterprise:6:1002'],
      ['task-c', enterpriseScope.ownerAccountKey],
    ]);

    clearMediaTaskOwnerAliasesForOwner(registry, enterpriseScope.ownerAccountKey);

    expect([...registry.entries()]).toEqual([
      ['task-b', 'enterprise:6:1002'],
    ]);
  });
});

describe('shouldRemoveMediaTaskAfterPoll', () => {
  test('keeps a tracker when the account switches during a terminal poll response', () => {
    expect(shouldRemoveMediaTaskAfterPoll(enterpriseScope, {
      ownerAccountKey: 'enterprise:6:1002',
      accountGeneration: 4,
    }, true)).toBe(false);
    expect(shouldRemoveMediaTaskAfterPoll(enterpriseScope, null, true)).toBe(false);
    expect(shouldRemoveMediaTaskAfterPoll(enterpriseScope, enterpriseScope, true)).toBe(true);
  });
});

describe('isAuthStateSnapshotCurrent', () => {
  const snapshot = {
    accountGeneration: 7,
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
  };

  test('rejects late auth responses after account or token changes', () => {
    expect(isAuthStateSnapshotCurrent(snapshot, 7, {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })).toBe(true);
    expect(isAuthStateSnapshotCurrent(snapshot, 8, {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })).toBe(false);
    expect(isAuthStateSnapshotCurrent(snapshot, 7, {
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
    })).toBe(false);
    expect(isAuthStateSnapshotCurrent(snapshot, 7, null)).toBe(false);
  });
});

describe('isAuthExchangeIntentCurrent', () => {
  test('allows only the latest request-start intent to commit', () => {
    const intent = {
      intentId: 4,
      accountGeneration: 7,
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    };

    expect(isAuthExchangeIntentCurrent(intent, 4, 7, {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })).toBe(true);
    expect(isAuthExchangeIntentCurrent(intent, 5, 7, {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })).toBe(false);
    expect(isAuthExchangeIntentCurrent(intent, 4, 8, {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    })).toBe(false);
    expect(isAuthExchangeIntentCurrent(intent, 4, 7, null)).toBe(false);
  });

  test('invalidates a logged-out exchange when logout or another exchange starts', () => {
    const intent = {
      intentId: 1,
      accountGeneration: 0,
      accessToken: null,
      refreshToken: null,
    };

    expect(isAuthExchangeIntentCurrent(intent, 1, 0, null)).toBe(true);
    expect(isAuthExchangeIntentCurrent(intent, null, 1, null)).toBe(false);
    expect(isAuthExchangeIntentCurrent(intent, 2, 0, null)).toBe(false);
  });
});
