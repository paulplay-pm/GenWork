import { configureStore } from '@reduxjs/toolkit';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { SSO_BINDING_IPC, type SsoConnectionWithBinding } from '../../../shared/sso/binding';
import { invoke } from '../../services/electron';
import ssoBindingsReducer, {
  fetchSsoBindings,
  setActiveTab,
  setBusy,
  setSearchQuery,
  startSsoBinding,
  unbindSsoConnection,
} from './ssoBindingsSlice';

vi.mock('../../services/electron', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const connectionA: SsoConnectionWithBinding = {
  id: 'c1',
  name: '飞书',
  providerType: 'feishu',
  sortOrder: 0,
  enabled: true,
  logoUrl: null,
  bound: true,
  externalId: 'kk@example.com',
};

const connectionB: SsoConnectionWithBinding = {
  id: 'c2',
  name: '钉钉',
  providerType: 'dingtalk',
  sortOrder: 1,
  enabled: true,
  logoUrl: null,
  bound: false,
  externalId: null,
};

describe('ssoBindingsSlice', () => {
  let store: ReturnType<typeof configureStore<{ ssoBindings: ReturnType<typeof ssoBindingsReducer> }>>;
  beforeEach(() => {
    invokeMock.mockReset();
    store = configureStore({ reducer: { ssoBindings: ssoBindingsReducer } });
  });

  describe('reducers', () => {
    test('setSearchQuery updates searchQuery', () => {
      expect(store.getState().ssoBindings.searchQuery).toBe('');

      store.dispatch(setSearchQuery('feishu'));
      expect(store.getState().ssoBindings.searchQuery).toBe('feishu');

      store.dispatch(setSearchQuery(''));
      expect(store.getState().ssoBindings.searchQuery).toBe('');
    });

    test('setActiveTab updates activeTab', () => {
      expect(store.getState().ssoBindings.activeTab).toBe('all');

      store.dispatch(setActiveTab('bound'));
      expect(store.getState().ssoBindings.activeTab).toBe('bound');

      store.dispatch(setActiveTab('unbound'));
      expect(store.getState().ssoBindings.activeTab).toBe('unbound');

      store.dispatch(setActiveTab('all'));
      expect(store.getState().ssoBindings.activeTab).toBe('all');
    });

    test('setBusy sets and clears busyConnectionId', () => {
      expect(store.getState().ssoBindings.busyConnectionId).toBeNull();

      store.dispatch(setBusy('c1'));
      expect(store.getState().ssoBindings.busyConnectionId).toBe('c1');

      store.dispatch(setBusy(null));
      expect(store.getState().ssoBindings.busyConnectionId).toBeNull();
    });
  });

  describe('fetchSsoBindings', () => {
    test('happy path: stores connections, status=ready', async () => {
      invokeMock.mockResolvedValueOnce({ connections: [connectionA, connectionB] });

      const promise = store.dispatch(fetchSsoBindings());
      expect(store.getState().ssoBindings.status).toBe('loading');
      expect(store.getState().ssoBindings.error).toBeNull();

      const result = await promise;
      expect(result.type).toBe('ssoBindings/fetch/fulfilled');
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith(SSO_BINDING_IPC.List);

      const { ssoBindings } = store.getState();
      expect(ssoBindings.status).toBe('ready');
      expect(ssoBindings.connections).toEqual([connectionA, connectionB]);
      expect(ssoBindings.error).toBeNull();
    });

    test('error path: stores error message, status=error', async () => {
      invokeMock.mockRejectedValueOnce(new Error('network down'));

      const result = await store.dispatch(fetchSsoBindings());

      expect(result.type).toBe('ssoBindings/fetch/rejected');
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith(SSO_BINDING_IPC.List);

      const { ssoBindings } = store.getState();
      expect(ssoBindings.status).toBe('error');
      expect(ssoBindings.error).toBe('network down');
      expect(ssoBindings.connections).toEqual([]);
    });
  });

  describe('startSsoBinding', () => {
    test('happy path: calls Start IPC with connectionId, clears busy', async () => {
      invokeMock.mockResolvedValueOnce(undefined);

      const promise = store.dispatch(startSsoBinding('c2'));
      // pending pins busyConnectionId to the arg immediately
      expect(store.getState().ssoBindings.busyConnectionId).toBe('c2');
      expect(store.getState().ssoBindings.error).toBeNull();

      const result = await promise;
      expect(result.type).toBe('ssoBindings/start/fulfilled');
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith(SSO_BINDING_IPC.Start, { connectionId: 'c2' });

      const { ssoBindings } = store.getState();
      expect(ssoBindings.busyConnectionId).toBeNull();
      expect(ssoBindings.error).toBeNull();
    });

    test('error path: clears busy and surfaces error', async () => {
      invokeMock.mockRejectedValueOnce(new Error('bind_oauth_failed'));

      const result = await store.dispatch(startSsoBinding('c2'));

      expect(result.type).toBe('ssoBindings/start/rejected');
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith(SSO_BINDING_IPC.Start, { connectionId: 'c2' });

      const { ssoBindings } = store.getState();
      expect(ssoBindings.busyConnectionId).toBeNull();
      expect(ssoBindings.error).toBe('bind_oauth_failed');
    });
  });

  describe('unbindSsoConnection', () => {
    test('happy path: calls Unbind IPC with no payload, clears busy', async () => {
      invokeMock.mockResolvedValueOnce(undefined);

      store.dispatch(setBusy('unbind'));

      const result = await store.dispatch(unbindSsoConnection());

      expect(result.type).toBe('ssoBindings/unbind/fulfilled');
      expect(invokeMock).toHaveBeenCalledTimes(1);
      // The server's DELETE /me/sso-binding is parameterless (one binding per
      // user); the thunk must dispatch with NO second arg.
      expect(invokeMock).toHaveBeenCalledWith(SSO_BINDING_IPC.Unbind);

      const { ssoBindings } = store.getState();
      expect(ssoBindings.busyConnectionId).toBeNull();
      expect(ssoBindings.error).toBeNull();
    });

    test('error path: clears busy and surfaces error', async () => {
      invokeMock.mockRejectedValueOnce(new Error('unbind_failed'));

      store.dispatch(setBusy('unbind'));

      const result = await store.dispatch(unbindSsoConnection());

      expect(result.type).toBe('ssoBindings/unbind/rejected');
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith(SSO_BINDING_IPC.Unbind);

      const { ssoBindings } = store.getState();
      expect(ssoBindings.busyConnectionId).toBeNull();
      expect(ssoBindings.error).toBe('unbind_failed');
    });
  });
});
