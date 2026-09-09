import { createAccountOwnerKey } from '@shared/auth/accountOwner';
import {
  type AuthSessionChangedEvent,
  AuthSessionChangeReason,
  AuthSessionStatus,
  AuthSubscriptionStatus,
} from '@shared/auth/constants';
import { EnterpriseAccountMode } from '@shared/enterpriseAccount/constants';
import { ProviderName } from '@shared/providers';

import type { EnterpriseAccountContext } from '../../shared/enterpriseAccount/types';
import {
  applyEnterpriseAccountContext,
  refreshEnterpriseAccountContext,
} from '../features/enterpriseAccount/context';
import { store } from '../store';
import {
  setAuthExpired,
  setAuthLoading,
  setAuthTemporarilyUnavailable,
  setLoggedIn,
  setLoggedOut,
  updateQuota,
  type UserProfile,
  type UserQuota,
} from '../store/slices/authSlice';
import { clearMediaAccountState } from '../store/slices/genworkSlice';
import type { Model } from '../store/slices/modelSlice';
import {
  clearServerModels,
} from '../store/slices/modelSlice';
import { i18nService } from './i18n';
import {
  clearPendingPublishingConversionAttribution,
  reportPendingPublishingSubscriptionObserved,
} from './publishingConversionAttribution';

interface AuthStateRefreshResult {
  isLoggedIn: boolean;
  user: UserProfile | null;
  quota: UserQuota | null;
  enterpriseContext: EnterpriseAccountContext | null;
}

interface AuthQuotaCheckResult {
  success: boolean;
  enterpriseQuotaAvailable: boolean;
}

type AuthRendererLogLevel = 'debug' | 'info' | 'warn';

export interface AuthAccountRequestSnapshot {
  isLoggedIn: boolean;
  ownerAccountKey: string | null;
  accountGeneration: number;
}

export const isAuthAccountRequestCurrent = (
  expected: AuthAccountRequestSnapshot,
  current: AuthAccountRequestSnapshot,
): boolean => (
  current.isLoggedIn === expected.isLoggedIn
  && current.ownerAccountKey === expected.ownerAccountKey
  && current.accountGeneration === expected.accountGeneration
);

const writeAuthRendererLog = (
  level: AuthRendererLogLevel,
  message: string,
  error?: unknown,
): void => {
  const errorMessage = error === undefined
    ? ''
    : `: ${error instanceof Error ? error.message : String(error)}`;
  const resolvedMessage = `${message}${errorMessage}`.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (level === 'warn') {
    if (error === undefined) {
      console.warn(`[Auth] ${resolvedMessage}`);
    } else {
      console.warn(`[Auth] ${message}:`, error);
    }
  } else if (level === 'debug') {
    console.debug(`[Auth] ${resolvedMessage}`);
  } else {
    console.log(`[Auth] ${resolvedMessage}`);
  }

  try {
    window.electron?.log?.fromRenderer?.(level, 'AuthService', resolvedMessage);
  } catch {
    // Logging is best-effort and must never interrupt authentication.
  }
};

/**
 * Adapter from the enterprise catalog (`EnterpriseModelView`) shape that
 * `window.electron.enterpriseModels.list()` returns, into the renderer's
 * `Model` shape that ModelSelector consumes.
 *
 * The renderer MUST NOT see the `_k`/apiKey field — the IPC layer strips it
 * before the response reaches this code.
 */
export function mapEnterpriseModelsToModels(
  models: EnterpriseModelViewLike[],
): Model[] {
  return models.map((model) => {
    const caps = model.capabilities;
    const supportsThinking = caps?.supports_thinking === true;
    return {
      id: model.id,
      name: model.displayName ?? model.model ?? model.id,
      provider: model.provider,
      providerKey: ProviderName.GenworkServer,
      isServerModel: true,
      supportsImage: caps?.supports_image ?? false,
      supportsVideo: caps?.supports_video ?? false,
      supportsThinking,
      contextWindow: caps?.context_window ?? undefined,
      maxTokens: caps?.max_tokens ?? undefined,
      accessible: true,
    };
  });
}

/** Minimal shape required by `mapEnterpriseModelsToModels`. */
export interface EnterpriseModelViewLike {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  capabilities?: {
    supports_image?: boolean;
    supports_video?: boolean;
    supports_thinking?: boolean;
    context_window?: number | null;
    max_tokens?: number | null;
  } | null;
}

class AuthService {
  private unsubQuotaChanged: (() => void) | null = null;
  private unsubSessionChanged: (() => void) | null = null;
  private unsubEnterpriseContextInvalidated: (() => void) | null = null;
  private unsubWindowState: (() => void) | null = null;
  private pendingQuotaCheck: {
    requestSnapshot: AuthAccountRequestSnapshot;
    promise: Promise<AuthQuotaCheckResult>;
  } | null = null;
  private lastRefreshTime = 0;
  private enterpriseQuotaBoundaryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTriggeredEnterpriseQuotaBoundary = '';

  private applyAuthenticatedState(
    user: UserProfile,
    quota: UserQuota | null | undefined,
    enterpriseContext: EnterpriseAccountContext | null | undefined,
  ): void {
    const isEnterpriseAccount = (
      user.accountMode === EnterpriseAccountMode.Enterprise
      || quota?.accountMode === EnterpriseAccountMode.Enterprise
      || quota?.subscriptionStatus === AuthSubscriptionStatus.Enterprise
    );
    const hasMismatchedEnterpriseId = (
      enterpriseContext !== null
      && enterpriseContext !== undefined
      && typeof quota?.enterpriseId === 'number'
      && quota.enterpriseId !== enterpriseContext.enterpriseId
    );
    const ownerAccountKey = createAccountOwnerKey({
      user,
      enterpriseId: enterpriseContext?.enterpriseId,
    });
    if (
      !ownerAccountKey
      || (isEnterpriseAccount && !enterpriseContext)
      || hasMismatchedEnterpriseId
    ) {
      this.clearAuthenticatedAccountState();
      throw new Error('Authenticated account context is missing or inconsistent');
    }
    if (store.getState().auth.ownerAccountKey !== ownerAccountKey) {
      store.dispatch(clearMediaAccountState());
      // Only drop the current list when the account actually changed. Clearing
      // on every refresh turns a failed reload into an empty plan model group,
      // while setServerModels replaces the list atomically on success.
      store.dispatch(clearServerModels());
    }
    store.dispatch(setLoggedIn({
      user,
      quota: quota ?? null,
      ownerAccountKey,
    }));
    void reportPendingPublishingSubscriptionObserved(quota?.subscriptionStatus);
    const context = applyEnterpriseAccountContext(enterpriseContext);
    this.scheduleEnterpriseQuotaBoundary(context);
  }

  private clearAuthenticatedAccountState(): void {
    this.clearEnterpriseQuotaBoundaryTimer();
    store.dispatch(setLoggedOut());
    applyEnterpriseAccountContext(null);
    store.dispatch(clearServerModels());
    store.dispatch(clearMediaAccountState());
  }

  /**
   * Initialize: try to restore login state from persisted token.
   */
  async init() {
    // Clean up any existing listeners to prevent stacking on repeated init()
    this.destroy();

    store.dispatch(setAuthLoading(true));

    // Listen for OAuth session changes from main process
    this.unsubSessionChanged = window.electron.auth.onSessionChanged(event => {
      void this.handleSessionChanged(event);
    });
    this.unsubEnterpriseContextInvalidated = window.electron.enterpriseAccount.onContextInvalidated(() => {
      this.clearAuthenticatedAccountState();
      writeAuthRendererLog(
        'warn',
        'Enterprise account context was invalidated by the server; account-scoped media state was cleared',
      );
    });

    try {
      await this.refreshAuthState({
        clearOnFailure: true,
      });
    } catch {
      store.dispatch(setAuthTemporarilyUnavailable({ hasCredentials: false }));
    }

    // Listen for quota changes (e.g. after cowork session using server model)
    this.unsubQuotaChanged = window.electron.auth.onQuotaChanged(() => {
      void this.checkQuota();
    });

    // Refresh quota and models when Electron window gains focus — user may have purchased on portal
    this.unsubWindowState = window.electron.window.onStateChanged((state) => {
      if (state.isFocused && store.getState().auth.isLoggedIn) {
        const now = Date.now();
        const enterpriseContext = store.getState().enterpriseAccount.context;
        const periodEnd = enterpriseContext?.memberQuota.periodEndExclusive
          ? Date.parse(enterpriseContext.memberQuota.periodEndExclusive)
          : Number.NaN;
        const quotaBoundaryReached = Number.isFinite(periodEnd) && now >= periodEnd;
        if (quotaBoundaryReached || now - this.lastRefreshTime > 30_000) {
          this.lastRefreshTime = now;
          void this.checkQuota();
        }
      }
    });
  }

  /**
   * Refresh the full auth snapshot from persisted tokens.
   */
  async refreshAuthState(
    options: {
      clearOnFailure?: boolean;
    } = {},
  ): Promise<AuthStateRefreshResult> {
    const authStateAtStart = store.getState().auth;
    try {
      const result = await window.electron.auth.getUser();
      if (!isAuthAccountRequestCurrent(authStateAtStart, store.getState().auth)) {
        writeAuthRendererLog(
          'debug',
          'discarded stale auth restoration response after auth state changed',
        );
        const current = store.getState().auth;
        return {
          isLoggedIn: current.isLoggedIn,
          user: current.user,
          quota: current.quota,
          enterpriseContext: store.getState().enterpriseAccount.context,
        };
      }
      if (result.success && result.user) {
        const enterpriseContext = result.enterpriseContext === undefined
          ? await refreshEnterpriseAccountContext({
            shouldApply: () => (
              isAuthAccountRequestCurrent(authStateAtStart, store.getState().auth)
            ),
          })
          : result.enterpriseContext;
        if (!isAuthAccountRequestCurrent(authStateAtStart, store.getState().auth)) {
          writeAuthRendererLog(
            'debug',
            'discarded stale auth restoration response after enterprise context refresh',
          );
          const current = store.getState().auth;
          return {
            isLoggedIn: current.isLoggedIn,
            user: current.user,
            quota: current.quota,
            enterpriseContext: store.getState().enterpriseAccount.context,
          };
        }
        this.applyAuthenticatedState(result.user, result.quota, enterpriseContext);
        return {
          isLoggedIn: true,
          user: result.user,
          quota: result.quota ?? null,
          enterpriseContext: enterpriseContext ?? null,
        };
      }

      const status = result.status ?? (
        result.hasCredentials
          ? AuthSessionStatus.TemporarilyUnavailable
          : AuthSessionStatus.Unauthenticated
      );

      if (status === AuthSessionStatus.TemporarilyUnavailable) {
        store.dispatch(setAuthTemporarilyUnavailable({
          hasCredentials: result.hasCredentials === true,
          cachedUser: result.cachedUser ?? null,
        }));
      } else if (status === AuthSessionStatus.Expired) {
        await this.applyLoggedOutState(true);
      } else if (options.clearOnFailure) {
        await this.applyLoggedOutState(false);
      }
    } catch {
      store.dispatch(setAuthTemporarilyUnavailable({
        hasCredentials: store.getState().auth.isLoggedIn,
      }));
    }

    const current = store.getState().auth;
    return {
      isLoggedIn: current.isLoggedIn,
      user: current.user,
      quota: current.quota,
      enterpriseContext: store.getState().enterpriseAccount.context,
    };
  }

  /**
   * Logout.
   */
  async logout() {
    clearPendingPublishingConversionAttribution();
    await window.electron.auth.logout();
    await this.applyLoggedOutState(false);
  }

  /**
   * Refresh quota information.
   */
  async refreshQuota(): Promise<boolean> {
    const authStateAtStart = store.getState().auth;
    if (
      !authStateAtStart.isLoggedIn
      || !authStateAtStart.user
      || !authStateAtStart.ownerAccountKey
    ) {
      return false;
    }
    try {
      const result = await window.electron.auth.getQuota();
      const currentAuthState = store.getState().auth;
      if (
        !currentAuthState.isLoggedIn
        || currentAuthState.ownerAccountKey !== authStateAtStart.ownerAccountKey
        || currentAuthState.accountGeneration !== authStateAtStart.accountGeneration
      ) {
        writeAuthRendererLog('debug', 'discarded stale quota response after auth state changed');
        return false;
      }
      if (result.success) {
        if (result.quota) {
          store.dispatch(updateQuota(result.quota));
          void reportPendingPublishingSubscriptionObserved(result.quota.subscriptionStatus);
        }
        if (result.enterpriseContext !== undefined) {
          const context = applyEnterpriseAccountContext(result.enterpriseContext);
          this.scheduleEnterpriseQuotaBoundary(context);
        }
        return true;
      }
      return false;
    } catch (error) {
      writeAuthRendererLog('warn', 'quota refresh failed', error);
      return false;
    }
  }

  async checkQuota(): Promise<AuthQuotaCheckResult> {
    const requestSnapshot = store.getState().auth;
    if (
      this.pendingQuotaCheck
      && isAuthAccountRequestCurrent(
        this.pendingQuotaCheck.requestSnapshot,
        requestSnapshot,
      )
    ) {
      writeAuthRendererLog('debug', 'joining the in-flight quota check');
      return this.pendingQuotaCheck.promise;
    }

    const check = this.performQuotaCheck(requestSnapshot);
    this.pendingQuotaCheck = { requestSnapshot, promise: check };
    try {
      return await check;
    } finally {
      if (this.pendingQuotaCheck?.promise === check) {
        this.pendingQuotaCheck = null;
      }
    }
  }

  private async performQuotaCheck(
    requestSnapshot: AuthAccountRequestSnapshot,
  ): Promise<AuthQuotaCheckResult> {
    writeAuthRendererLog('debug', 'quota check started');
    try {
      const refreshed = await this.refreshQuota();
      if (!refreshed) {
        writeAuthRendererLog('warn', 'quota check could not refresh quota state');
        return {
          success: false,
          enterpriseQuotaAvailable: false,
        };
      }
      if (!isAuthAccountRequestCurrent(requestSnapshot, store.getState().auth)) {
        writeAuthRendererLog('debug', 'discarded quota check result after auth state changed');
        return {
          success: false,
          enterpriseQuotaAvailable: false,
        };
      }
      const enterpriseContext = store.getState().enterpriseAccount.context;
      const enterpriseQuotaAvailable = (
        !enterpriseContext
        || enterpriseContext.quotaStatus.available !== false
      );
      writeAuthRendererLog(
        'debug',
        `quota check completed (enterprise quota available: ${enterpriseQuotaAvailable})`,
      );
      return {
        success: true,
        enterpriseQuotaAvailable,
      };
    } catch (error) {
      writeAuthRendererLog('warn', 'quota check failed unexpectedly', error);
      return {
        success: false,
        enterpriseQuotaAvailable: false,
      };
    }
  }

  /**
   * Get current access token (for proxy API calls).
   */
  async getAccessToken(): Promise<string | null> {
    try {
      return await window.electron.auth.getAccessToken();
    } catch {
      return null;
    }
  }

  destroy() {
    this.pendingQuotaCheck = null;
    this.clearEnterpriseQuotaBoundaryTimer();
    this.unsubQuotaChanged?.();
    this.unsubQuotaChanged = null;
    this.unsubSessionChanged?.();
    this.unsubSessionChanged = null;
    this.unsubEnterpriseContextInvalidated?.();
    this.unsubEnterpriseContextInvalidated = null;
    this.unsubWindowState?.();
    this.unsubWindowState = null;
  }

  private async handleSessionChanged(event: AuthSessionChangedEvent): Promise<void> {
    if (event.status !== AuthSessionStatus.Expired) return;
    writeAuthRendererLog('warn', `login session expired (${event.reason})`);
    const cleanup = this.applyLoggedOutState(true);
    const toastKey = event.reason === AuthSessionChangeReason.EnterpriseMembershipRevoked
      ? 'coworkErrorEnterpriseMembershipRevoked'
      : 'coworkErrorGenWorkLoginExpired';
    window.dispatchEvent(new CustomEvent('app:showToast', {
      detail: i18nService.t(toastKey),
    }));
    await cleanup;
  }

  private async applyLoggedOutState(expired: boolean): Promise<void> {
    const targetStatus = expired
      ? AuthSessionStatus.Expired
      : AuthSessionStatus.Unauthenticated;
    const current = store.getState().auth;
    if (
      !current.isLoggedIn
      && !current.isLoading
      && current.sessionStatus === targetStatus
      && !store.getState().enterpriseAccount.context
    ) {
      return;
    }

    this.clearEnterpriseQuotaBoundaryTimer();
    store.dispatch(expired ? setAuthExpired() : setLoggedOut());
    applyEnterpriseAccountContext(null);
    store.dispatch(clearServerModels());
    store.dispatch(clearMediaAccountState());
  }

  private clearEnterpriseQuotaBoundaryTimer(): void {
    if (this.enterpriseQuotaBoundaryTimer !== null) {
      clearTimeout(this.enterpriseQuotaBoundaryTimer);
      this.enterpriseQuotaBoundaryTimer = null;
    }
  }

  private scheduleEnterpriseQuotaBoundary(
    context: EnterpriseAccountContext | null | undefined,
  ): void {
    this.clearEnterpriseQuotaBoundaryTimer();
    const endExclusive = context?.memberQuota.periodEndExclusive;
    const ownerAccountKey = store.getState().auth.ownerAccountKey;
    if (!context || !endExclusive || !ownerAccountKey) return;

    const boundary = Date.parse(endExclusive);
    if (!Number.isFinite(boundary)) return;
    const boundaryKey = `${ownerAccountKey}:${context.enterpriseId}:${endExclusive}`;
    const maxTimerDelay = 2_147_000_000;

    const fire = () => {
      this.enterpriseQuotaBoundaryTimer = null;
      const currentAuth = store.getState().auth;
      const currentContext = store.getState().enterpriseAccount.context;
      if (currentAuth.ownerAccountKey !== ownerAccountKey
        || currentContext?.enterpriseId !== context.enterpriseId) {
        return;
      }
      if (this.lastTriggeredEnterpriseQuotaBoundary === boundaryKey) return;
      this.lastTriggeredEnterpriseQuotaBoundary = boundaryKey;
      this.lastRefreshTime = Date.now();
      void this.checkQuota();
    };

    const arm = () => {
      const remaining = boundary - Date.now() + 1_000;
      if (remaining <= 0) {
        if (this.lastTriggeredEnterpriseQuotaBoundary !== boundaryKey) {
          this.enterpriseQuotaBoundaryTimer = setTimeout(fire, 0);
        }
        return;
      }
      if (remaining > maxTimerDelay) {
        this.enterpriseQuotaBoundaryTimer = setTimeout(arm, maxTimerDelay);
        return;
      }
      this.enterpriseQuotaBoundaryTimer = setTimeout(fire, remaining);
    };
    arm();
  }

}

export const authService = new AuthService();
