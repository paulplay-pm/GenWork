import { configureStore } from '@reduxjs/toolkit';

import enterpriseAccountReducer from '../features/enterpriseAccount/enterpriseAccountSlice';
import { libraryArtifactListener } from './libraryArtifactListener';
import agentReducer from './slices/agentSlice';
import artifactReducer from './slices/artifactSlice';
import asrQuotaReducer from './slices/asrQuotaSlice';
import authReducer from './slices/authSlice';
import coworkReducer from './slices/genworkSlice';
import imReducer from './slices/imSlice';
import kitReducer from './slices/kitSlice';
import mcpReducer from './slices/mcpSlice';
import modelReducer from './slices/modelSlice';
import quickActionReducer from './slices/quickActionSlice';
import scheduledTaskReducer from './slices/scheduledTaskSlice';
import skillReducer from './slices/skillSlice';
import ssoBindingsReducer from './slices/ssoBindingsSlice';

export const store = configureStore({
  reducer: {
    model: modelReducer,
    cowork: coworkReducer,
    skill: skillReducer,
    mcp: mcpReducer,
    im: imReducer,
    quickAction: quickActionReducer,
    scheduledTask: scheduledTaskReducer,
    agent: agentReducer,
    asrQuota: asrQuotaReducer,
    auth: authReducer,
    enterpriseAccount: enterpriseAccountReducer,
    artifact: artifactReducer,
    kit: kitReducer,
    ssoBindings: ssoBindingsReducer,
  },
  middleware: getDefaultMiddleware => (
    getDefaultMiddleware().prepend(libraryArtifactListener.middleware)
  ),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch; 
