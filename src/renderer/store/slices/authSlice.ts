import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import {
  AuthSessionStatus,
  type AuthSessionStatus as AuthSessionStatusValue,
} from '@shared/auth/constants';

export interface UserProfile {
  yid: string;
  nickname: string;
  avatarUrl: string | null;
  phone?: string | null;   // exchange endpoint only, always null currently
  userId?: string;         // exchange endpoint only (string "6")
  id?: number;             // profile endpoint only (number 6)
  status?: number;         // profile endpoint only
  accountMode?: 'personal' | 'enterprise';
}

export interface UserQuota {
  planName: string;           // "免费", "标准", "进阶", "专业"
  subscriptionStatus: string; // "free" | "active" | "enterprise"
  creditsLimit: number;       // total credits limit
  creditsUsed: number;        // credits used
  creditsRemaining: number;   // credits remaining
  hasPaidCredits?: boolean;   // true if user has subscription, boost, or invitation credits
  mediaGenerationEntitled?: boolean; // explicit server-computed media entitlement
  shareEntitled?: boolean;    // explicit server-computed sharing entitlement
  deploymentEntitled?: boolean; // explicit server-computed deployment entitlement
  accountMode?: 'personal' | 'enterprise';
  enterpriseId?: number;
}

interface AuthState {
  isLoggedIn: boolean;
  isLoading: boolean;
  sessionStatus: AuthSessionStatusValue;
  user: UserProfile | null;
  quota: UserQuota | null;
  ownerAccountKey: string | null;
  accountGeneration: number;
}

const initialState: AuthState = {
  isLoggedIn: false,
  isLoading: true,
  sessionStatus: AuthSessionStatus.Unauthenticated,
  user: null,
  quota: null,
  ownerAccountKey: null,
  accountGeneration: 0,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setAuthLoading(state, action: PayloadAction<boolean>) {
      state.isLoading = action.payload;
    },
    setLoggedIn(state, action: PayloadAction<{
      user: UserProfile;
      quota: UserQuota | null;
      ownerAccountKey: string;
    }>) {
      if (state.ownerAccountKey !== action.payload.ownerAccountKey) {
        state.accountGeneration += 1;
      }
      state.isLoggedIn = true;
      state.isLoading = false;
      state.sessionStatus = AuthSessionStatus.Authenticated;
      state.user = action.payload.user;
      state.quota = action.payload.quota;
      state.ownerAccountKey = action.payload.ownerAccountKey;
    },
    setLoggedOut(state) {
      if (state.ownerAccountKey !== null) {
        state.accountGeneration += 1;
      }
      state.isLoggedIn = false;
      state.isLoading = false;
      state.sessionStatus = AuthSessionStatus.Unauthenticated;
      state.user = null;
      state.quota = null;
      state.ownerAccountKey = null;
    },
    invalidateAuthAccountContext(state) {
      state.accountGeneration += 1;
      state.quota = null;
    },
    setAuthExpired(state) {
      if (state.ownerAccountKey !== null) {
        state.accountGeneration += 1;
      }
      state.isLoggedIn = false;
      state.isLoading = false;
      state.sessionStatus = AuthSessionStatus.Expired;
      state.user = null;
      state.quota = null;
      state.ownerAccountKey = null;
    },
    setAuthTemporarilyUnavailable(
      state,
      action: PayloadAction<{
        hasCredentials: boolean;
        cachedUser?: UserProfile | null;
      }>,
    ) {
      state.isLoading = false;
      state.sessionStatus = AuthSessionStatus.TemporarilyUnavailable;
      if (action.payload.hasCredentials) {
        state.isLoggedIn = true;
      }
      if (action.payload.cachedUser) {
        state.user = action.payload.cachedUser;
      }
    },
    updateQuota(state, action: PayloadAction<UserQuota>) {
      state.quota = action.payload;
    },
  },
});

export const {
  setAuthExpired,
  invalidateAuthAccountContext,
  setAuthLoading,
  setAuthTemporarilyUnavailable,
  setLoggedIn,
  setLoggedOut,
  updateQuota,
} = authSlice.actions;
export default authSlice.reducer;
