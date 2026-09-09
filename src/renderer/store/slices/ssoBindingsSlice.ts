import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { SsoConnectionWithBinding } from '../../../shared/sso/binding';
import { SSO_BINDING_IPC } from '../../../shared/sso/binding';
import { invoke } from '../../services/electron';

export type SsoBindingsStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SsoBindingsTab = 'all' | 'bound' | 'unbound';

export interface SsoBindingsState {
  connections: SsoConnectionWithBinding[];
  status: SsoBindingsStatus;
  error: string | null;
  searchQuery: string;
  activeTab: SsoBindingsTab;
  busyConnectionId: string | null;
}

const initialState: SsoBindingsState = {
  connections: [],
  status: 'idle',
  error: null,
  searchQuery: '',
  activeTab: 'all',
  busyConnectionId: null,
};

export const fetchSsoBindings = createAsyncThunk(
  'ssoBindings/fetch',
  async () => {
    const res = await invoke<{ connections: SsoConnectionWithBinding[] }>(SSO_BINDING_IPC.List);
    return res.connections;
  },
);

export const startSsoBinding = createAsyncThunk(
  'ssoBindings/start',
  async (connectionId: string) => {
    await invoke(SSO_BINDING_IPC.Start, { connectionId });
  },
);

export const unbindSsoConnection = createAsyncThunk(
  'ssoBindings/unbind',
  async () => {
    await invoke(SSO_BINDING_IPC.Unbind);
  },
);

const slice = createSlice({
  name: 'ssoBindings',
  initialState,
  reducers: {
    setSearchQuery(state, action: PayloadAction<string>) {
      state.searchQuery = action.payload;
    },
    setActiveTab(state, action: PayloadAction<SsoBindingsTab>) {
      state.activeTab = action.payload;
    },
    setBusy(state, action: PayloadAction<string | null>) {
      state.busyConnectionId = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSsoBindings.pending, (state) => {
        state.status = 'loading';
        state.error = null;
      })
      .addCase(fetchSsoBindings.fulfilled, (state, action) => {
        state.status = 'ready';
        state.connections = action.payload;
      })
      .addCase(fetchSsoBindings.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.error.message ?? 'fetch_failed';
      })
      .addCase(startSsoBinding.pending, (state, action) => {
        state.busyConnectionId = action.meta.arg;
        state.error = null;
      })
      .addCase(startSsoBinding.fulfilled, (state) => {
        state.busyConnectionId = null;
      })
      .addCase(startSsoBinding.rejected, (state, action) => {
        state.busyConnectionId = null;
        state.error = action.error.message ?? 'bind_failed';
      })
      .addCase(unbindSsoConnection.pending, (_state) => {
        // busy is owned by the caller (set via setBusy before dispatching).
      })
      .addCase(unbindSsoConnection.fulfilled, (state) => {
        state.busyConnectionId = null;
      })
      .addCase(unbindSsoConnection.rejected, (state, action) => {
        state.busyConnectionId = null;
        state.error = action.error.message ?? 'unbind_failed';
      });
  },
});

export const { setSearchQuery, setActiveTab, setBusy } = slice.actions;
export default slice.reducer;
