import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { ProviderName } from '@shared/providers';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import {
  APP_UPDATE_HEARTBEAT_INTERVAL_MS,
  APP_UPDATE_POLL_INTERVAL_MS,
  type AppUpdateInfo,
  type AppUpdateRuntimeState,
  AppUpdateStatus,
  isManualDownloadUrl,
} from '../shared/appUpdate/constants';
import {
  LibraryNavigationEvent,
  LibrarySourceFilter,
} from '../shared/library/constants';
import type { LibrarySessionRef } from '../shared/library/types';
import { SIDEBAR_TASK_FILTER_ENABLED } from './components/agentSidebar/SidebarTaskFilterButton';
import { GenWorkView } from './components/genwork';
import {
  CoworkShortcutDirection,
  type CoworkTaskSearchRequestEventDetail,
  CoworkTaskSearchRequestSource,
  CoworkUiEvent,
} from './components/genwork/constants';
import {
  ConversationSearchShortcutTarget,
  resolveConversationSearchShortcutTarget,
} from './components/genwork/conversationSearchShortcut';
import CoworkPermissionModal from './components/genwork/CoworkPermissionModal';
import CoworkQuestionWizard from './components/genwork/CoworkQuestionWizard';
import EngineFailureOverlay from './components/genwork/EngineFailureOverlay';
import EngineStartupOverlay from './components/genwork/EngineStartupOverlay';
import KitsView from './components/kits/KitsView';
import LibraryView from './components/library/LibraryView';
import { ScheduledTasksView } from './components/scheduledTasks';
import Settings, { type SettingsOpenOptions } from './components/Settings';
import Sidebar from './components/Sidebar';
import { SkillsAndConnectorsView, SkillsConnectorsSection } from './components/skillsAndConnectors';
import SkinBackdrop, { SkinBackdropVariant } from './components/skin/SkinBackdrop';
import SkinPresentationScope from './components/skin/SkinPresentationScope';
import SsoBindingsPage from './components/ssoBindings/SsoBindingsPage';
import Toast, { type ToastEventDetail } from './components/Toast';
import AppUpdateBadge from './components/update/AppUpdateBadge';
import AppUpdateBlockingPanel from './components/update/AppUpdateBlockingPanel';
import AppUpdateCard from './components/update/AppUpdateCard';
import { formatAppUpdateError } from './components/update/appUpdateErrorText';
import AppUpdateInteractionOverlay from './components/update/AppUpdateInteractionOverlay';
import {
  isAppUpdateInteractionBlockingStatus,
  shouldBlockAppInteractionForUpdate,
} from './components/update/appUpdateInteractionState';
import AppUpdateModal from './components/update/AppUpdateModal';
import WindowsAppTitleBar from './components/window/WindowsAppTitleBar';
import { defaultConfig, ShortcutAction } from './config';
import { LoginPage } from './login/LoginPage';
import { SkinProvider } from './providers/SkinProvider';
import type { ApiConfig } from './services/api';
import { apiService } from './services/api';
import { authService } from './services/auth';
import { configService } from './services/config';
import { genworkService } from './services/genwork';
import { i18nService } from './services/i18n';
import {
  beginLatestAsyncRequest,
  isLatestAsyncRequest,
} from './services/latestAsyncRequest';
import { scheduledTaskService } from './services/scheduledTask';
import { isTextEditingSafeShortcut, matchesShortcut } from './services/shortcuts';
import { themeService } from './services/theme';
import { applyTypographyPreferences } from './services/typography';
import { EnterpriseSetupModal } from './setup/EnterpriseSetupModal';
import { RootState, store } from './store';
import {
  selectCurrentSessionId,
  selectFirstCurrentSessionPendingPermission,
  selectPendingPermissions,
} from './store/selectors/coworkSelectors';
import { openArtifactPreviewTab } from './store/slices/artifactSlice';
import {
  clearDraftAttachments,
  clearDraftSelectedTextSnippets,
  setDraftCollaborationMode,
  setDraftKitIds,
  setDraftPrompt,
  setDraftSkillIds,
} from './store/slices/genworkSlice';
import { setActiveKitIds } from './store/slices/kitSlice';
import { setAvailableModels, setDefaultSelectedModel } from './store/slices/modelSlice';
import { clearSelection } from './store/slices/quickActionSlice';
import { setActiveSkillIds } from './store/slices/skillSlice';
import { GenWorkCollaborationMode, type GenWorkPermissionResult } from './types/genwork';

const AGENT_TASK_SLOT_SHORTCUT_ACTIONS = [
  ShortcutAction.OpenAgentTask1,
  ShortcutAction.OpenAgentTask2,
  ShortcutAction.OpenAgentTask3,
  ShortcutAction.OpenAgentTask4,
  ShortcutAction.OpenAgentTask5,
  ShortcutAction.OpenAgentTask6,
  ShortcutAction.OpenAgentTask7,
  ShortcutAction.OpenAgentTask8,
  ShortcutAction.OpenAgentTask9,
] as const;

const SETTINGS_TAB_SHORTCUT_ACTIONS: Array<{
  action: ShortcutAction;
  initialTab: NonNullable<SettingsOpenOptions['initialTab']>;
}> = [
  { action: ShortcutAction.OpenSettingsGeneral, initialTab: 'general' },
  { action: ShortcutAction.OpenSettingsAppearance, initialTab: 'appearance' },
  { action: ShortcutAction.OpenSettingsAgentEngine, initialTab: 'coworkAgentEngine' },
  { action: ShortcutAction.OpenSettingsIm, initialTab: 'im' },
  { action: ShortcutAction.OpenSettingsBrowser, initialTab: 'browserWebAccess' },
  { action: ShortcutAction.OpenSettingsEmail, initialTab: 'email' },
  { action: ShortcutAction.OpenSettingsMemory, initialTab: 'coworkMemory' },
  { action: ShortcutAction.OpenSettingsDreaming, initialTab: 'coworkDreaming' },
  { action: ShortcutAction.OpenSettingsPlugins, initialTab: 'plugins' },
  { action: ShortcutAction.OpenSettingsAbout, initialTab: 'about' },
];

/** Used for config + i18n init; longer on Windows where main-process IPC can stall during cold start. */
const INIT_STEP_TIMEOUT_MS_WINDOWS = 24_000;
const INIT_STEP_TIMEOUT_MS_DEFAULT = 16_000;
/** Field evidence (2026-08): early renderer↔main invokes can stall ~25-30s and
 * then recover, so retries with fresh invokes rescue startup where a single
 * long timeout cannot. */
const INIT_STEP_RETRY_TIMEOUT_MS = 8_000;
const INIT_CONFIG_MAX_ATTEMPTS = 3;
const INIT_AUTO_RETRY_DELAY_MS = 8_000;
const INIT_AUTO_RETRY_MAX = 2;
const INIT_CONFIG_REPAIR_DELAY_MS = 15_000;
const INIT_CONFIG_REPAIR_MAX = 4;
const INIT_REQUIRED_GATE_MAX_ATTEMPTS = 2;

export const InitPassMode = {
  Startup: 'startup',
  Retry: 'retry',
  Repair: 'repair',
} as const;
export type InitPassMode = typeof InitPassMode[keyof typeof InitPassMode];

const logAppUpdateRendererLifecycle = (
  message: string,
  level: 'debug' | 'warn' = 'debug',
): void => {
  if (level === 'warn') {
    console.warn(`[AppUpdate] ${message}`);
  } else {
    console.debug(`[AppUpdate] ${message}`);
  }
  try {
    window.electron?.log?.fromRenderer?.(level, 'AppUpdate', message);
  } catch {
    // Best-effort diagnostic only.
  }
};

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions & { requestId: number }>({ requestId: 0 });
  const [mainView, setMainView] = useState<'cowork' | 'skills' | 'scheduledTasks' | 'kits' | 'mcp' | 'library' | 'ssoBindings'>('cowork');
  const [libraryNavigationRequest, setLibraryNavigationRequest] = useState<{
    source: LibrarySourceFilter;
    requestId: number;
  }>({
    source: LibrarySourceFilter.Local,
    requestId: 0,
  });
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [enterpriseMtLoggedIn, setEnterpriseMtLoggedIn] = useState<boolean | null>(null);
  const [enterpriseBootstrapStatus, setEnterpriseBootstrapStatus] = useState<{
    configured: boolean;
    url: string | null;
  } | null>(null);
  const [toastMessage, setToastMessage] = useState<ToastEventDetail | null>(null);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isTaskFilterActive, setIsTaskFilterActive] = useState(false);
  const [hasUnreadCompletedTasks, setHasUnreadCompletedTasks] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(244);
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateRuntimeState>({
    status: AppUpdateStatus.Idle,
    source: null,
    info: null,
    progress: null,
    readyFilePath: null,
    readyFileHash: null,
    errorMessage: null,
  });
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUserInitiatedUpdateFlowActive, setIsUserInitiatedUpdateFlowActive] = useState(false);
  const [enterpriseConfig, setEnterpriseConfig] = useState<{
    ui?: Record<string, 'hide' | 'disable' | 'readonly'>;
    disableUpdate?: boolean;
  } | null>(null);
  const [enterpriseConfigLoaded, setEnterpriseConfigLoaded] = useState(false);
  const toastTimerRef = useRef<number | null>(null);
  const askAiFocusTimerRef = useRef<number | null>(null);
  const hasInitialized = useRef(false);
  const hasReportedAppStartedRef = useRef(false);
  const initPassRunningRef = useRef(false);
  const initRetryTimerRef = useRef<number | null>(null);
  const initAutoRetryCountRef = useRef(0);
  const initRepairCountRef = useRef(0);
  const requiredStartupGatesReadyRef = useRef(false);
  const coreStartupServicesInitializedRef = useRef(false);
  const enterpriseGateRequestIdRef = useRef(0);
  const previousUpdateStatusRef = useRef<AppUpdateRuntimeState['status']>(AppUpdateStatus.Idle);
  const shouldInstallReadyUpdateRef = useRef(false);
  const isUserInitiatedUpdateFlowActiveRef = useRef(false);
  const dispatch = useDispatch();
  const defaultSelectedModel = useSelector((state: RootState) => state.model.defaultSelectedModel);
  const currentSessionId = useSelector(selectCurrentSessionId);
  const pendingPermission = useSelector(selectFirstCurrentSessionPendingPermission);
  const pendingPermissions = useSelector(selectPendingPermissions);
  const authUser = useSelector((state: RootState) => state.auth.user);
  const isWindows = window.electron.platform === 'win32';
  const [minimizedPermissionIds, setMinimizedPermissionIds] = useState<string[]>([]);
  const isPendingPermissionMinimized = pendingPermission
    ? minimizedPermissionIds.includes(pendingPermission.requestId)
    : false;
  const isPermissionModalOpen = pendingPermission !== null && !isPendingPermissionMinimized;
  const isUpdateInteractionBlocked = shouldBlockAppInteractionForUpdate(
    isUserInitiatedUpdateFlowActive,
    appUpdateState.status,
  );

  const waitWithTimeout = useCallback(
    async <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
      return await new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        promise.then(
          (value) => {
            window.clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            window.clearTimeout(timer);
            reject(error);
          }
        );
      });
    },
    []
  );

  // 初始化应用
  const applyConfigToApp = useCallback((_log?: (label: string) => void) => {
    const config = configService.getConfig();
    applyTypographyPreferences(config);
    const apiConfig: ApiConfig = {
      apiKey: config.api.key,
      baseUrl: config.api.baseUrl,
    };
    apiService.setConfig(apiConfig);

    // The legacy `config.providers` map is no longer authoritative; the
    // enterprise model catalog drives the ModelSelector (see Task C.4).
    // We still call setAvailableModels with an empty list so any leftover
    // user-configured models are cleared on startup.
    const providerModels: { id: string; name: string; provider?: string; providerKey?: string; openClawProviderId?: string; supportsImage?: boolean }[] = [];
    dispatch(setAvailableModels(providerModels));
    const allModels = store.getState().model.availableModels;
    const preferredModel = allModels.find(
      model => model.id === config.model.defaultModel
        && (!config.model.defaultModelProvider || model.providerKey === config.model.defaultModelProvider)
    ) ?? allModels[0];
    if (preferredModel) {
      dispatch(setDefaultSelectedModel(preferredModel));
    }
    return providerModels;
  }, [dispatch]);

  const runInitPassRef = useRef<(mode: InitPassMode) => void>(() => {});

  const runInitPass = useCallback(async (mode: InitPassMode): Promise<void> => {
    if (initPassRunningRef.current) {
      return;
    }
    initPassRunningRef.current = true;
    if (initRetryTimerRef.current !== null) {
      window.clearTimeout(initRetryTimerRef.current);
      initRetryTimerRef.current = null;
    }

    const t0 = performance.now();
    const log = (level: 'info' | 'error', label: string) => {
      const elapsed = Math.round(performance.now() - t0);
      const msg = `initializeApp: ${label} (+${elapsed}ms)`;
      if (level === 'error') {
        console.error(`[App] ${msg}`);
      } else {
        console.info(`[App] ${msg}`);
      }
      try { window.electron?.log?.fromRenderer?.(level, 'App', msg); } catch { /* preload may not expose this yet */ }
    };
    const mark = (label: string) => log('info', label);
    const markError = (label: string) => log('error', label);

    const scheduleNextPass = (nextMode: InitPassMode, delayMs: number) => {
      initRetryTimerRef.current = window.setTimeout(() => {
        initRetryTimerRef.current = null;
        runInitPassRef.current(nextMode);
      }, delayMs);
    };

    // Runs one init step; retries issue a FRESH invoke because a timed-out
    // promise is left running (its late completion must stay harmless).
    const runStep = async (
      label: string,
      run: () => Promise<unknown>,
      opts: { attempts: number; firstTimeoutMs: number },
    ): Promise<boolean> => {
      for (let attempt = 1; attempt <= opts.attempts; attempt++) {
        const timeoutMs = attempt === 1 ? opts.firstTimeoutMs : INIT_STEP_RETRY_TIMEOUT_MS;
        try {
          await waitWithTimeout(run(), timeoutMs, label);
          if (attempt > 1) {
            mark(`${label} recovered on attempt ${attempt}`);
          }
          return true;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          markError(`${label} attempt ${attempt}/${opts.attempts} failed: ${msg}`);
        }
      }
      return false;
    };

    const finishShell = (_providerModelCount: number, readyLabel: string) => {
      if (!requiredStartupGatesReadyRef.current) {
        throw new Error('Required privacy and enterprise startup gates are unresolved.');
      }
      setIsInitialized(true);
      setInitError(null);
      mark(readyLabel);
      if (!hasReportedAppStartedRef.current) {
        hasReportedAppStartedRef.current = true;
      }
    };

    try {
      mark(`start (mode=${mode})`);
      document.documentElement.classList.add(`platform-${window.electron.platform}`);

      const initTimeoutMs =
        window.electron.platform === 'win32'
          ? INIT_STEP_TIMEOUT_MS_WINDOWS
          : INIT_STEP_TIMEOUT_MS_DEFAULT;
      const isRepair = mode === InitPassMode.Repair;

      // Privacy consent and enterprise UI policy are authorization gates, not
      // optional startup data. Resolve them before any degraded/default-config
      // path can expose the application shell. Both calls run in parallel and
      // use fresh IPC invokes on retry to recover from an early renderer/main
      // handshake stall.
      if (!requiredStartupGatesReadyRef.current) {
        const [enterpriseReady] = await Promise.all([
          runStep('enterprise.getConfig', async () => {
            const requestId = beginLatestAsyncRequest(enterpriseGateRequestIdRef);
            const result = await window.electron.enterprise.getConfig();
            if (!isLatestAsyncRequest(enterpriseGateRequestIdRef, requestId)) return;
            if (!result.success) {
              throw new Error(result.error || 'Enterprise UI config is unavailable.');
            }
            setEnterpriseConfig(result.config);
            setEnterpriseConfigLoaded(true);
          }, {
            attempts: INIT_REQUIRED_GATE_MAX_ATTEMPTS,
            firstTimeoutMs: INIT_STEP_RETRY_TIMEOUT_MS,
          }),
        ]);
        if (!enterpriseReady) {
          throw new Error(
            `Required startup gates unavailable (enterprise=${enterpriseReady}).`,
          );
        }
        requiredStartupGatesReadyRef.current = true;
        mark('required enterprise gate done');
      }

      mark('configService.init begin');
      const configReady = await runStep('configService.init', () => configService.init(), {
        attempts: isRepair ? 2 : INIT_CONFIG_MAX_ATTEMPTS,
        firstTimeoutMs: isRepair ? INIT_STEP_RETRY_TIMEOUT_MS : initTimeoutMs,
      });

      if (!configReady) {
        if (isRepair) {
          if (initRepairCountRef.current < INIT_CONFIG_REPAIR_MAX) {
            initRepairCountRef.current += 1;
            markError(`config repair still failing — retry ${initRepairCountRef.current}/${INIT_CONFIG_REPAIR_MAX} in ${INIT_CONFIG_REPAIR_DELAY_MS}ms`);
            scheduleNextPass(InitPassMode.Repair, INIT_CONFIG_REPAIR_DELAY_MS);
          } else {
            markError('config repair attempts exhausted — app keeps default config until next launch');
          }
          return;
        }
        // Keep the application usable on defaults while a background pass
        // repairs persisted config. Core services still initialize below so
        // auth/listeners and scheduled tasks are never skipped.
        markError('configService.init unavailable — starting with default config, background repair scheduled');
        initRepairCountRef.current = 1;
      } else {
        mark('configService.init done');
      }

      if (isRepair) {
        const repairedModels = applyConfigToApp(mark);
        const repairedConfig = configService.getConfig();
        themeService.applyPersistedSelection({
          mode: repairedConfig.theme,
          themeId: repairedConfig.themeId,
        });
        i18nService.setLanguage(repairedConfig.language, { persist: false });
        mark(`config repaired and applied (${repairedModels.length} provider models)`);
        return;
      }

      if (!coreStartupServicesInitializedRef.current) {
        themeService.initialize();
        mark('themeService done');

        mark('i18nService.initialize begin');
        const i18nReady = await runStep('i18nService.initialize', () => i18nService.initialize(), {
          // Keep one invocation alive after a timeout. Starting a concurrent
          // locale initialization would let late IPC results race each other.
          attempts: 1,
          firstTimeoutMs: initTimeoutMs,
        });
        mark(i18nReady ? 'i18nService.initialize done' : 'i18nService.initialize degraded — using persisted language hint');

        // Single attempt: authService.init() re-entry tears down listeners, so a
        // concurrent retry could stack them; its in-flight run self-completes
        // once IPC recovers.
        mark('authService.init begin');
        const authReady = await runStep('authService.init', () => authService.init(), {
          attempts: 1,
          firstTimeoutMs: INIT_STEP_RETRY_TIMEOUT_MS,
        });
        mark(authReady ? 'authService.init done' : 'authService.init pending (auth restore completes in background)');
        coreStartupServicesInitializedRef.current = true;
      }

      const providerModels = applyConfigToApp(mark);
      mark('model resolution done');

      finishShell(
        providerModels.length,
        configReady ? 'shell ready' : 'shell ready (degraded: default config)',
      );

      void waitWithTimeout(scheduledTaskService.init(), 5000, 'scheduledTaskService.init').catch((error) => {
        console.error('[App] initializeApp: scheduledTaskService.init failed:', error);
      });

      if (!configReady) {
        // Schedule only after the startup pass releases its in-flight guard;
        // otherwise a slow core-service init can consume and lose the timer.
        scheduleNextPass(InitPassMode.Repair, INIT_CONFIG_REPAIR_DELAY_MS);
      }

    } catch (error) {
      const elapsed = Math.round(performance.now() - t0);
      const msg = error instanceof Error ? error.message : String(error);
      const detail = `initializeApp FAILED after ${elapsed}ms (mode=${mode}): ${msg}`;
      console.error(`[App] ${detail}`);
      try { window.electron?.log?.fromRenderer?.('error', 'App', detail); } catch { /* best-effort */ }
      if (mode === InitPassMode.Repair) {
        // The shell is already up in degraded mode — never replace it with the
        // error page from a background pass.
        return;
      }
      setInitError(i18nService.t('initializationError'));
      setIsInitialized(true);
      if (initAutoRetryCountRef.current < INIT_AUTO_RETRY_MAX) {
        initAutoRetryCountRef.current += 1;
        markError(`scheduling automatic init retry ${initAutoRetryCountRef.current}/${INIT_AUTO_RETRY_MAX} in ${INIT_AUTO_RETRY_DELAY_MS}ms`);
        // Retries silently behind the error page; success swaps straight into
        // the app without flashing the loading screen.
        scheduleNextPass(InitPassMode.Retry, INIT_AUTO_RETRY_DELAY_MS);
      }
    } finally {
      initPassRunningRef.current = false;
    }
  }, [applyConfigToApp, waitWithTimeout]);

  useEffect(() => {
    runInitPassRef.current = (mode: InitPassMode) => { void runInitPass(mode); };
  }, [runInitPass]);

  // Probe the multi-tenant enterprise login bridge. When ENTERPRISE_SERVER_URL
  // is configured we require a valid session before rendering the main app.
  // When the bridge is absent (legacy / personal mode) we fall through to the
  // normal init flow so personal builds keep working.
  const probeEnterpriseBootstrap = useCallback(async (): Promise<void> => {
    let cancelled = false;
    const win = window as unknown as {
      electron?: {
        enterpriseMt?: {
          getMe: () => Promise<unknown>;
          getBootstrapStatus?: () => Promise<{ configured: boolean; url: string | null }>;
          verifyUrl: (url: string) => Promise<{ ok: boolean; error?: string }>;
        };
      };
    };
    if (!win.electron?.enterpriseMt) {
      if (!cancelled) setEnterpriseMtLoggedIn(true);
      return;
    }
    // Pull bootstrap status first so the setup modal can render ahead of
    // the getMe call (which would otherwise log the user out on a 401).
    try {
      if (win.electron!.enterpriseMt.getBootstrapStatus) {
        const status = await win.electron!.enterpriseMt.getBootstrapStatus();
        if (!cancelled) setEnterpriseBootstrapStatus(status);
        if (!cancelled && status.configured === false) {
          // Unconfigured: short-circuit so we don't hit a broken /api endpoint.
          setEnterpriseMtLoggedIn(false);
          return;
        }
        // Configured: probe the server reachability so a stale URL surfaces
        // as an inline error in the setup modal instead of a stuck login.
        if (!cancelled && status.url && typeof win.electron!.enterpriseMt.verifyUrl === 'function') {
          const probe = await win.electron!.enterpriseMt.verifyUrl(status.url);
          if (cancelled) return;
          if (!probe.ok) {
            console.warn(`[App] startup verify failed: ${probe.error}`);
            setEnterpriseMtLoggedIn(false);
            return;
          }
        }
      }
    } catch (e) {
      console.warn('[App] bootstrap status probe failed:', e);
    }
    try {
      // The main process returns `{ ok: false, error: 'not logged in' }`
      // instead of throwing on the unauthenticated case, so we check the
      // shape here. Any thrown error is treated the same as a structured
      // not-logged-in result.
      const me = (await win.electron!.enterpriseMt.getMe()) as
        | { ok: false; error: string }
        | null
        | undefined;
      if (!cancelled && me && (me as { ok?: boolean }).ok === false) {
        setEnterpriseMtLoggedIn(false);
      } else if (!cancelled) {
        setEnterpriseMtLoggedIn(true);
      }
    } catch {
      if (!cancelled) setEnterpriseMtLoggedIn(false);
    }
  }, []);

  useEffect(() => {
    void probeEnterpriseBootstrap();
  }, [probeEnterpriseBootstrap]);

  // The main process pushes this when the enterprise LLM proxy reports a
  // `not_member` 401 (the member was disabled/removed after a valid JWT was
  // issued). Drop the login gate so the user returns to the LoginPage to
  // re-authenticate; no full reload is needed since the session is already
  // cleared on the main side.
  useEffect(() => {
    const off = window.electron?.enterpriseMt?.onSessionRevoked?.(() => {
      setEnterpriseMtLoggedIn(false);
    });
    return () => off?.();
  }, []);

  const handleInitRetry = useCallback(() => {
    if (initPassRunningRef.current) {
      return;
    }
    initAutoRetryCountRef.current = 0;
    setInitError(null);
    setIsInitialized(false);
    void runInitPass(InitPassMode.Retry);
  }, [runInitPass]);

  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }
    hasInitialized.current = true;
    void runInitPass(InitPassMode.Startup);
  }, [runInitPass]);

  useEffect(() => () => {
    if (initRetryTimerRef.current !== null) {
      window.clearTimeout(initRetryTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh((prev) => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Listen for Copilot token auto-refresh events from the main process
  useEffect(() => {
    const removeListener = window.electron.githubCopilot.onTokenUpdated(({ token, baseUrl }) => {
      console.log('[App] received Copilot token update from main process');
      apiService.setProviderRuntimeCredential(ProviderName.Copilot, {
        apiKey: token,
        ...(baseUrl ? { baseUrl } : {}),
      });
    });
    return removeListener;
  }, []);

  // Network status monitoring
  useEffect(() => {
    const handleOnline = () => {
      console.log('[Renderer] Network online');
      window.electron.networkStatus.send('online');
    };

    const handleOffline = () => {
      console.log('[Renderer] Network offline');
      window.electron.networkStatus.send('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!isInitialized || !defaultSelectedModel?.id) return;
    const config = configService.getConfig();
    if (
      config.model.defaultModel === defaultSelectedModel.id
      && (config.model.defaultModelProvider ?? '') === (defaultSelectedModel.providerKey ?? '')
    ) {
      return;
    }
    void configService.updateConfig({
      model: {
        ...config.model,
        defaultModel: defaultSelectedModel.id,
        defaultModelProvider: defaultSelectedModel.providerKey,
      },
    });
  }, [isInitialized, defaultSelectedModel?.id, defaultSelectedModel?.providerKey]);

  const handleShowSettings = useCallback((options?: SettingsOpenOptions) => {
    setSettingsOptions((current) => ({
      initialTab: options?.initialTab,
      notice: options?.notice,
      noticeI18nKey: options?.noticeI18nKey,
      noticeExtra: options?.noticeExtra,
      requestId: current.requestId + 1,
    }));
    setShowSettings(true);
  }, []);

  const handleShowSkills = useCallback(() => {
    setMainView('skills');
  }, []);

  const handleShowCowork = useCallback(() => {
    setMainView('cowork');
  }, []);

  const handleShowScheduledTasks = useCallback(() => {
    setMainView('scheduledTasks');
  }, []);

  const handleShowMcp = useCallback(() => {
    setMainView('mcp');
  }, []);

  const handleShowLibrary = useCallback(() => {
    setLibraryNavigationRequest(current => ({
      source: LibrarySourceFilter.Local,
      requestId: current.requestId + 1,
    }));
    setMainView('library');
  }, []);

  useEffect(() => {
    const handleOpenCloudLibrary = (): void => {
      setLibraryNavigationRequest(current => ({
        source: LibrarySourceFilter.Cloud,
        requestId: current.requestId + 1,
      }));
      setMainView('library');
    };
    window.addEventListener(LibraryNavigationEvent.OpenCloud, handleOpenCloudLibrary);
    return () => {
      window.removeEventListener(LibraryNavigationEvent.OpenCloud, handleOpenCloudLibrary);
    };
  }, []);

  const handleOpenLibrarySession = useCallback((session: LibrarySessionRef) => {
    setMainView('cowork');
    void genworkService.loadSession(session.sessionId).then(loaded => {
      if (!loaded || !session.sessionArtifactId) return;
      dispatch(openArtifactPreviewTab({
        sessionId: session.sessionId,
        artifactId: session.sessionArtifactId,
      }));
    });
  }, [dispatch]);

  const handleShowKits = useCallback(() => {
    setMainView('kits');
  }, []);

  const handleShowSsoBindings = useCallback(() => {
    setMainView('ssoBindings');
  }, []);

  const handleSkillsConnectorsSectionChange = useCallback((section: SkillsConnectorsSection) => {
    if (section === SkillsConnectorsSection.Connectors) {
      handleShowMcp();
    } else {
      handleShowSkills();
    }
  }, [handleShowMcp, handleShowSkills]);

  const openHomeWithKit = useCallback((kitId: string, text?: string) => {
    dispatch(setActiveKitIds([kitId]));
    genworkService.clearSession({ restoreAgentSkills: true });
    dispatch(clearSelection());
    if (text !== undefined) {
      dispatch(setDraftCollaborationMode({
        draftKey: '__home__',
        mode: GenWorkCollaborationMode.Default,
      }));
      // Set the draft prompt before switching view, so that when CoworkPromptInput
      // mounts/updates with draftKey='__home__', it picks up the text.
      dispatch(setDraftPrompt({ sessionId: '__home__', draft: text }));
    }
    dispatch(setDraftKitIds({ draftKey: '__home__', kitIds: [kitId] }));
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
        // Without text, keep any existing home draft and just focus with the kit selected
        detail: text !== undefined ? { resetCollaborationMode: true, text } : { clear: false },
      }));
    }, 0);
  }, [dispatch]);

  const handleKitTryAsking = useCallback((text: string, kitId: string) => {
    openHomeWithKit(kitId, text);
  }, [openHomeWithKit]);

  const handleKitUse = useCallback((kitId: string) => {
    openHomeWithKit(kitId);
  }, [openHomeWithKit]);

  const handleSkillUse = useCallback((skillId: string) => {
    dispatch(setActiveSkillIds([skillId]));
    genworkService.clearSession({ restoreAgentSkills: true });
    dispatch(clearSelection());
    dispatch(setDraftSkillIds({ draftKey: '__home__', skillIds: [skillId] }));
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
        detail: { clear: false },
      }));
    }, 0);
  }, [dispatch]);

  const handleToggleSidebar = useCallback(() => {
    const nextCollapsed = !isSidebarCollapsed;
    const message = `sidebar toggle requested activeView=${mainView} nextCollapsed=${nextCollapsed} platform=${window.electron.platform}`;
    console.debug(`[AppLayout] ${message}`);
    try {
      window.electron?.log?.fromRenderer?.('debug', 'AppLayout', message);
    } catch {
      // Logging should never block sidebar interactions.
    }
    setIsSidebarCollapsed((prev) => !prev);
  }, [isSidebarCollapsed, mainView]);

  const handleToggleTaskFilter = useCallback(() => {
    const nextActive = !isTaskFilterActive;
    const message = `task activity toggle requested activeView=${mainView} nextActive=${nextActive} hasUnreadCompleted=${hasUnreadCompletedTasks} platform=${window.electron.platform}`;
    console.debug(`[TaskActivity] ${message}`);
    try {
      window.electron?.log?.fromRenderer?.('debug', 'TaskActivity', message);
    } catch {
      // Diagnostics must never block the sidebar interaction.
    }
    setIsTaskFilterActive(nextActive);
  }, [hasUnreadCompletedTasks, isTaskFilterActive, mainView]);

  const handleOpenTaskSearch = useCallback(() => {
    window.dispatchEvent(new CustomEvent<CoworkTaskSearchRequestEventDetail>(
      CoworkUiEvent.ShortcutSearch,
      { detail: { source: CoworkTaskSearchRequestSource.WindowsTitleBar } },
    ));
  }, []);

  const handleNewChat = useCallback(() => {
    // Only clear when already on home (no session) — preserve __home__ draft when returning from a session
    const shouldClearInput = mainView === 'cowork' && !currentSessionId;
    genworkService.clearSession({ restoreAgentSkills: true });
    dispatch(clearSelection());
    dispatch(setDraftCollaborationMode({
      draftKey: '__home__',
      mode: GenWorkCollaborationMode.Default,
    }));
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
        detail: { clear: shouldClearInput, resetCollaborationMode: true },
      }));
    }, 0);
  }, [dispatch, mainView, currentSessionId]);

  const handleCreateSkillByChat = useCallback(() => {
    dispatch(setDraftPrompt({ sessionId: '__home__', draft: i18nService.t('skillCreatorPrompt') }));
    genworkService.clearSession();
    dispatch(clearSelection());
    dispatch(setDraftCollaborationMode({
      draftKey: '__home__',
      mode: GenWorkCollaborationMode.Default,
    }));
    setMainView('cowork');
  }, [dispatch]);

  const showToast = useCallback((toast: string | ToastEventDetail) => {
    const detail = typeof toast === 'string' ? { message: toast } : toast;
    if (!detail.message) return;
    setToastMessage(detail);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    // Toasts carrying an action button stay longer so the user can reach it.
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, detail.actionLabel && detail.onAction ? 6000 : 2200);
  }, []);

  const startUserInitiatedUpdateFlow = useCallback((reason: string) => {
    if (!isUserInitiatedUpdateFlowActiveRef.current) {
      logAppUpdateRendererLifecycle(`interaction lock started reason=${reason}`);
    }
    isUserInitiatedUpdateFlowActiveRef.current = true;
    setIsUserInitiatedUpdateFlowActive(true);
  }, []);

  const stopUserInitiatedUpdateFlow = useCallback((reason: string) => {
    if (!isUserInitiatedUpdateFlowActiveRef.current) return;

    isUserInitiatedUpdateFlowActiveRef.current = false;
    setIsUserInitiatedUpdateFlowActive(false);
    logAppUpdateRendererLifecycle(`interaction lock released reason=${reason}`);
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadInitialUpdateState = async () => {
      try {
        const state = await window.electron.appUpdate.getState();
        if (mounted) {
          setAppUpdateState(state);
          previousUpdateStatusRef.current = state.status;
          // A previous install attempt quit the app without completing
          // (e.g. the installer never launched) — re-prompt the user.
          if (state.status === AppUpdateStatus.Ready && state.installIncomplete) {
            setShowUpdateModal(true);
          }
        }
        // Silent installs relaunch the app with no visible install step, so
        // this toast is the only confirmation the update actually happened.
        const completed = await window.electron.appUpdate.getCompletedUpdate?.();
        if (mounted && completed?.version) {
          showToast(`${i18nService.t('updateInstalledToast')} v${completed.version}`);
        }
      } catch (error) {
        console.error('[App] failed to load initial app update state:', error);
      }
    };

    void loadInitialUpdateState();

    const unsubscribe = window.electron.appUpdate.onStateChanged((state) => {
      const previousStatus = previousUpdateStatusRef.current;
      previousUpdateStatusRef.current = state.status;
      setAppUpdateState(state);

      if (!isAppUpdateInteractionBlockingStatus(state.status)) {
        shouldInstallReadyUpdateRef.current = false;
        stopUserInitiatedUpdateFlow(`state=${state.status}`);
      }

      if (
        state.status === AppUpdateStatus.Ready
        && previousStatus !== AppUpdateStatus.Ready
        && shouldInstallReadyUpdateRef.current
      ) {
        shouldInstallReadyUpdateRef.current = false;
        if (state.readyFilePath) {
          logAppUpdateRendererLifecycle(
            `download ready; starting install version=${state.info?.latestVersion ?? 'unknown'}`,
          );
          void window.electron.appUpdate.installReady()
            .then((installResult) => {
              if (!installResult.success) {
                stopUserInitiatedUpdateFlow('install-result-failed');
                showToast(
                  installResult.error
                    ? formatAppUpdateError(installResult.error)
                    : i18nService.t('updateInstallFailed'),
                );
              }
            })
            .catch((error) => {
              stopUserInitiatedUpdateFlow('install-ipc-failed');
              console.error('[AppUpdate] failed to install downloaded update:', error);
              showToast(i18nService.t('updateInstallFailed'));
            });
        } else {
          stopUserInitiatedUpdateFlow('ready-file-missing');
          logAppUpdateRendererLifecycle(
            `ready update is missing its installer path version=${state.info?.latestVersion ?? 'unknown'}`,
            'warn',
          );
          showToast(i18nService.t('updateInstallFailed'));
        }
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [showToast, stopUserInitiatedUpdateFlow]);

  const handleShowLogin = useCallback(() => {
    showToast(i18nService.t('featureInDevelopment'));
  }, [showToast]);

  const runUpdateCheck = useCallback(async () => {
    try {
      const result = await window.electron.appUpdate.checkNow({ userId: authUser?.yid });
      setAppUpdateState(result.state);
      if (!result.success) {
        console.error('[App] app update check failed:', result.error);
      }
    } catch (error) {
      console.error('Failed to check app update:', error);
    }
  }, [authUser]);

  const updateInfo = appUpdateState.info;

  const handleOpenUpdateModal = useCallback(() => {
    if (!updateInfo) return;

    const message = `update modal requested status=${appUpdateState.status} source=${appUpdateState.source ?? 'none'} version=${updateInfo.latestVersion}`;
    logAppUpdateRendererLifecycle(message);
    setShowUpdateModal(true);
  }, [appUpdateState.source, appUpdateState.status, updateInfo]);

  const handleUpdateFound = useCallback((_info: AppUpdateInfo) => {
    setShowUpdateModal(true);
  }, []);

  const handleConfirmUpdate = useCallback(async () => {
    if (!updateInfo) return;

    if (appUpdateState.readyFilePath) {
      setShowUpdateModal(false);
      shouldInstallReadyUpdateRef.current = false;
      startUserInitiatedUpdateFlow(
        `install-ready version=${updateInfo.latestVersion}`,
      );
      try {
        const installResult = await window.electron.appUpdate.installReady();
        if (!installResult.success) {
          stopUserInitiatedUpdateFlow('install-result-failed');
          showToast(
            installResult.error
              ? formatAppUpdateError(installResult.error)
              : i18nService.t('updateInstallFailed'),
          );
        }
      } catch (error) {
        stopUserInitiatedUpdateFlow('install-ipc-failed');
        console.error('[AppUpdate] failed to install ready update:', error);
        showToast(i18nService.t('updateInstallFailed'));
      }
      return;
    }

    if (appUpdateState.status === AppUpdateStatus.Error || appUpdateState.status === AppUpdateStatus.Available) {
      if (!isManualDownloadUrl(updateInfo.url)) {
        setShowUpdateModal(false);
        // The user explicitly asked to update (or retry), so finish the whole
        // flow in one click: install and restart as soon as the download lands.
        shouldInstallReadyUpdateRef.current = true;
        startUserInitiatedUpdateFlow(
          `download-and-install version=${updateInfo.latestVersion}`,
        );
        try {
          const retryResult = await window.electron.appUpdate.retryDownload();
          if (
            !retryResult.success
            || retryResult.state.status !== AppUpdateStatus.Downloading
          ) {
            stopUserInitiatedUpdateFlow(
              `download-not-started state=${retryResult.state.status}`,
            );
            shouldInstallReadyUpdateRef.current = false;
            showToast(i18nService.t('updateDownloadFailed'));
          }
        } catch (error) {
          stopUserInitiatedUpdateFlow('download-ipc-failed');
          shouldInstallReadyUpdateRef.current = false;
          console.error('[AppUpdate] failed to start update download:', error);
          showToast(i18nService.t('updateDownloadFailed'));
        }
        return;
      }
    }

    if (isManualDownloadUrl(updateInfo.url)) {
      shouldInstallReadyUpdateRef.current = false;
      setShowUpdateModal(false);
      try {
        const result = await window.electron.shell.openExternal(updateInfo.url);
        if (!result.success) {
          showToast(i18nService.t('updateOpenFailed'));
        }
      } catch (error) {
        console.error('Failed to open update url:', error);
        showToast(i18nService.t('updateOpenFailed'));
      }
      return;
    }
  }, [
    appUpdateState.readyFilePath,
    appUpdateState.status,
    showToast,
    startUserInitiatedUpdateFlow,
    stopUserInitiatedUpdateFlow,
    updateInfo,
  ]);

  const handleCancelDownload = useCallback(async () => {
    shouldInstallReadyUpdateRef.current = false;
    stopUserInitiatedUpdateFlow('download-cancel-requested');
    try {
      const cancelResult = await window.electron.appUpdate.cancelDownload();
      if (cancelResult.state.status === AppUpdateStatus.Downloading) {
        logAppUpdateRendererLifecycle(
          'download cancel request completed but the update is still downloading',
          'warn',
        );
      }
    } catch (error) {
      console.error('[AppUpdate] failed to cancel update download:', error);
      showToast(i18nService.t('updateDownloadFailed'));
    }
  }, [showToast, stopUserInitiatedUpdateFlow]);

  const handleRetryUpdate = useCallback(async () => {
    await handleConfirmUpdate();
  }, [handleConfirmUpdate]);

  const handlePermissionResponse = useCallback(async (result: GenWorkPermissionResult) => {
    if (!pendingPermission) return;
    await genworkService.respondToPermission(pendingPermission.requestId, result);
  }, [pendingPermission]);

  const handleMinimizePermission = useCallback(() => {
    if (!pendingPermission) return;
    setMinimizedPermissionIds((previous) => (
      previous.includes(pendingPermission.requestId)
        ? previous
        : [...previous, pendingPermission.requestId]
    ));
  }, [pendingPermission]);

  const handleRestorePermission = useCallback(() => {
    if (!pendingPermission) return;
    setMinimizedPermissionIds((previous) => (
      previous.filter((requestId) => requestId !== pendingPermission.requestId)
    ));
  }, [pendingPermission]);

  useEffect(() => {
    const activeRequestIds = new Set(pendingPermissions.map((permission) => permission.requestId));
    setMinimizedPermissionIds((previous) => {
      const next = previous.filter((requestId) => activeRequestIds.has(requestId));
      return next.length === previous.length ? previous : next;
    });
  }, [pendingPermissions]);

  const handleCloseSettings = () => {
    setShowSettings(false);
    const config = configService.getConfig();
    apiService.setConfig({
      apiKey: config.api.key,
      baseUrl: config.api.baseUrl,
    });

    // The legacy `config.providers` map no longer drives the model list;
    // Task C.4 wires the ModelSelector to the enterprise catalog.
  };

  const handleStartAiSkinFromSettings = (text: string, kitId: string) => {
    handleCloseSettings();
    openHomeWithKit(kitId, text);
  };

  const isShortcutInputActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return activeElement.dataset.shortcutInput === 'true';
  };

  const isTextEditingActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    if (activeElement.isContentEditable) return true;
    if (activeElement instanceof HTMLTextAreaElement) return true;
    if (activeElement instanceof HTMLSelectElement) return true;
    return activeElement instanceof HTMLInputElement;
  };

  const isCoworkSearchEligibleEditorActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return Boolean(activeElement.closest([
      '[data-skin-prompt-input="true"]',
      '[data-cowork-conversation-search="true"]',
    ].join(',')));
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || isShortcutInputActive()) return;

      const { shortcuts } = configService.getConfig();
      const activeShortcuts = {
        ...defaultConfig.shortcuts,
        ...(shortcuts ?? {}),
      };

      const isTextEditing = isTextEditingActive();
      const matchesAction = (action: ShortcutAction) => {
        const binding = activeShortcuts[action];
        // While typing, only run shortcuts carrying a Cmd/Ctrl modifier so plain keys keep inserting text.
        if (isTextEditing && !isTextEditingSafeShortcut(binding)) return false;
        return matchesShortcut(event, binding);
      };

      if (showSettings) {
        if (matchesAction(ShortcutAction.ShowShortcuts)) {
          event.preventDefault();
          handleShowSettings({ initialTab: 'shortcuts' });
        }
        return;
      }

      if (showUpdateModal || isPermissionModalOpen || isUpdateInteractionBlocked) return;

      if (matchesAction(ShortcutAction.Search)) {
        const shortcutTarget = resolveConversationSearchShortcutTarget({
          isCoworkView: mainView === 'cowork',
          hasCurrentSession: Boolean(currentSessionId),
          isTextEditing,
          isCoworkSearchEligibleEditor: isCoworkSearchEligibleEditorActive(),
        });
        if (shortcutTarget === ConversationSearchShortcutTarget.Conversation) {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutConversationSearch));
        } else if (shortcutTarget === ConversationSearchShortcutTarget.History) {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent<CoworkTaskSearchRequestEventDetail>(
            CoworkUiEvent.ShortcutSearch,
            { detail: { source: CoworkTaskSearchRequestSource.KeyboardShortcut } },
          ));
        }
        return;
      }

      if (matchesAction(ShortcutAction.NewChat)) {
        event.preventDefault();
        handleNewChat();
        return;
      }

      if (matchesAction(ShortcutAction.Settings)) {
        event.preventDefault();
        handleShowSettings();
        return;
      }

      if (matchesAction(ShortcutAction.ShowShortcuts)) {
        event.preventDefault();
        handleShowSettings({ initialTab: 'shortcuts' });
        return;
      }

      const settingsTabShortcut = SETTINGS_TAB_SHORTCUT_ACTIONS.find(({ action }) => matchesAction(action));
      if (settingsTabShortcut) {
        event.preventDefault();
        handleShowSettings({ initialTab: settingsTabShortcut.initialTab });
        return;
      }

      if (matchesAction(ShortcutAction.FocusPrompt)) {
        event.preventDefault();
        setMainView('cowork');
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent(CoworkUiEvent.FocusInput, {
            detail: { clear: false },
          }));
        }, 0);
        return;
      }

      if (matchesAction(ShortcutAction.StopCurrentTask)) {
        event.preventDefault();
        if (mainView === 'cowork') {
          window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutStopSession));
        } else if (currentSessionId) {
          void genworkService.stopSession(currentSessionId);
        }
        return;
      }

      if (matchesAction(ShortcutAction.ToggleSidebar)) {
        event.preventDefault();
        handleToggleSidebar();
        return;
      }

      if (matchesAction(ShortcutAction.ToggleArtifacts)) {
        event.preventDefault();
        setMainView('cowork');
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutToggleArtifacts));
        }, 0);
        return;
      }

      if (matchesAction(ShortcutAction.PreviousAgent)) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutSwitchAgent, {
          detail: { direction: CoworkShortcutDirection.Previous },
        }));
        return;
      }

      if (matchesAction(ShortcutAction.NextAgent)) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutSwitchAgent, {
          detail: { direction: CoworkShortcutDirection.Next },
        }));
        return;
      }

      if (matchesAction(ShortcutAction.ShowCurrentAgentTasks)) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutShowCurrentAgentTasks));
        return;
      }

      if (matchesAction(ShortcutAction.CollapseCurrentAgentTasks)) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutCollapseCurrentAgentTasks));
        return;
      }

      const taskSlotIndex = AGENT_TASK_SLOT_SHORTCUT_ACTIONS.findIndex(action => matchesAction(action));
      if (taskSlotIndex >= 0) {
        event.preventDefault();
        setMainView('cowork');
        setIsSidebarCollapsed(false);
        window.dispatchEvent(new CustomEvent(CoworkUiEvent.ShortcutOpenAgentTaskSlot, {
          detail: { slot: taskSlotIndex + 1 },
        }));
        return;
      }

      if (matchesAction(ShortcutAction.OpenCowork)) {
        event.preventDefault();
        handleShowCowork();
        return;
      }

      if (matchesAction(ShortcutAction.OpenScheduledTasks)) {
        event.preventDefault();
        handleShowScheduledTasks();
        return;
      }

      if (matchesAction(ShortcutAction.OpenKits)) {
        event.preventDefault();
        handleShowKits();
        return;
      }

      if (matchesAction(ShortcutAction.OpenSkills)) {
        event.preventDefault();
        handleShowSkills();
        return;
      }

      if (matchesAction(ShortcutAction.OpenMcp)) {
        event.preventDefault();
        handleShowMcp();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    currentSessionId,
    handleNewChat,
    handleShowCowork,
    handleShowKits,
    handleShowMcp,
    handleShowScheduledTasks,
    handleShowSettings,
    handleShowSkills,
    handleToggleSidebar,
    isUpdateInteractionBlocked,
    mainView,
    isPermissionModalOpen,
    showSettings,
    showUpdateModal,
  ]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Listen for toast events from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string | ToastEventDetail>).detail;
      if (detail) showToast(detail);
    };
    window.addEventListener('app:showToast', handler);
    return () => window.removeEventListener('app:showToast', handler);
  }, [showToast]);

  // Listen for the avatar-menu → "绑定 SSO 账号" selection. The menu lives
  // inside Sidebar (which would otherwise need a long prop pass to forward a
  // navigation callback), so it asks App.tsx to flip `mainView` via a custom
  // event. The page's own `onBack` would require plumbing through Sidebar;
  // relying on the SsoBindingsPage's `window.history.back()` fallback would
  // be a poor match here because mainView is not URL-based.
  useEffect(() => {
    const handler = (): void => {
      handleShowSsoBindings();
    };
    window.addEventListener('app:show-sso-bindings', handler);
    return () => window.removeEventListener('app:show-sso-bindings', handler);
  }, [handleShowSsoBindings]);

  // Listen for ask-ai events: close settings, open a new chat, and pre-fill its input.
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (typeof text !== 'string' || !text.trim()) {
        console.warn('[AskAI] ignored navigation request because the prompt was empty.');
        return;
      }

      const coworkState = store.getState().cowork;
      const diagnostic = [
        'opening new chat with prefilled prompt;',
        `hadCurrentSession=${Boolean(coworkState.currentSessionId)},`,
        `remoteManaged=${coworkState.remoteManaged},`,
        `promptLength=${text.length}`,
      ].join(' ');
      console.debug(`[AskAI] ${diagnostic}`);
      try {
        window.electron?.log?.fromRenderer?.('debug', 'AskAI', diagnostic);
      } catch {
        // Logging must not block navigation.
      }

      genworkService.clearSession({ restoreAgentSkills: true });
      dispatch(clearSelection());
      dispatch(setDraftCollaborationMode({
        draftKey: '__home__',
        mode: GenWorkCollaborationMode.Default,
      }));
      dispatch(setDraftPrompt({ sessionId: '__home__', draft: text }));
      dispatch(clearDraftAttachments('__home__'));
      dispatch(clearDraftSelectedTextSnippets('__home__'));
      setShowSettings(false);
      setMainView('cowork');
      if (askAiFocusTimerRef.current !== null) {
        window.clearTimeout(askAiFocusTimerRef.current);
      }
      askAiFocusTimerRef.current = window.setTimeout(() => {
        askAiFocusTimerRef.current = null;
        window.dispatchEvent(
          new CustomEvent(CoworkUiEvent.FocusInput, {
            detail: { text },
          }),
        );
      }, 50);
    };
    window.addEventListener('app:ask-ai', handler);
    return () => {
      window.removeEventListener('app:ask-ai', handler);
      if (askAiFocusTimerRef.current !== null) {
        window.clearTimeout(askAiFocusTimerRef.current);
        askAiFocusTimerRef.current = null;
      }
    };
  }, [dispatch]);

  // 监听托盘菜单打开设置的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:openSettings', () => {
      handleShowSettings();
    });
    return unsubscribe;
  }, [handleShowSettings]);

  // 监听托盘菜单新建任务的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:newTask', () => {
      handleNewChat();
    });
    return unsubscribe;
  }, [handleNewChat]);

  useEffect(() => {
    const unsubscribe = window.electron.cowork.onOpenSessionFromNotification?.(({ sessionId }) => {
      setShowSettings(false);
      setMainView('cowork');
      void genworkService.loadSession(sessionId);
    });
    void window.electron.cowork.notifyOpenSessionFromNotificationReady?.();
    return unsubscribe;
  }, []);

  // Tell the main process which session is currently visible so desktop
  // notifications for that session can be suppressed and cleared.
  useEffect(() => {
    const visibleSessionId = mainView === 'cowork' && !showSettings ? currentSessionId ?? null : null;
    void window.electron.cowork.setActiveSession?.(visibleSessionId)?.catch?.((error: unknown) => {
      console.debug('[App] failed to report active session:', error);
    });
  }, [mainView, showSettings, currentSessionId]);

  useEffect(() => {
    if (!isInitialized) return;

    // Enterprise mode: completely skip update detection
    if (enterpriseConfig?.disableUpdate) return;

    let cancelled = false;
    let lastCheckTime = 0;

    const maybeCheck = async (reason: 'startup' | 'heartbeat' | 'visibility') => {
      if (cancelled) return;
      const now = Date.now();
      if (lastCheckTime > 0 && now - lastCheckTime < APP_UPDATE_POLL_INTERVAL_MS) return;
      lastCheckTime = now;
      console.log(`[App] auto update check triggered, reason=${reason}, at=${new Date(now).toISOString()}`);
      await runUpdateCheck();
    };

    // 启动时立即检查
    void maybeCheck('startup');

    // 心跳：每 30 分钟检测是否距上次检查已超过 2 小时
    const timer = window.setInterval(() => {
      void maybeCheck('heartbeat');
    }, APP_UPDATE_HEARTBEAT_INTERVAL_MS);

    // 窗口恢复可见时检测（覆盖休眠唤醒场景）
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void maybeCheck('visibility');
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isInitialized, runUpdateCheck, enterpriseConfig]);

  // 根据场景选择使用哪个权限组件。最小化时保持组件挂载（仅视觉隐藏），
  // 避免重新展开后丢失用户已选择/已输入的内容；key 按 requestId 隔离不同请求的状态。
  const permissionModal = useMemo(() => {
    if (!pendingPermission) return null;

    // 检查是否为 AskUserQuestion 且有多个问题 -> 使用向导式组件
    const isQuestionTool = pendingPermission.toolName === 'AskUserQuestion';
    if (isQuestionTool && pendingPermission.toolInput) {
      const rawQuestions = (pendingPermission.toolInput as Record<string, unknown>).questions;
      const hasMultipleQuestions = Array.isArray(rawQuestions) && rawQuestions.length > 1;

      if (hasMultipleQuestions) {
        return (
          <CoworkQuestionWizard
            key={pendingPermission.requestId}
            permission={pendingPermission}
            onRespond={handlePermissionResponse}
            onMinimize={handleMinimizePermission}
            hidden={isPendingPermissionMinimized}
          />
        );
      }
    }

    // 其他情况使用原有的权限模态框
    return (
      <CoworkPermissionModal
        key={pendingPermission.requestId}
        permission={pendingPermission}
        onRespond={handlePermissionResponse}
        onMinimize={handleMinimizePermission}
        hidden={isPendingPermissionMinimized}
      />
    );
  }, [pendingPermission, handlePermissionResponse, handleMinimizePermission, isPendingPermissionMinimized]);

  const isOverlayActive = showSettings
    || showUpdateModal
    || isPermissionModalOpen
    || isUpdateInteractionBlocked;
  // Keep the badge visible while downloading so the collapsed-sidebar layouts
  // still surface progress; only a plain re-check hides nothing new.
  const shouldShowUpdateBadge = updateInfo && appUpdateState.status !== AppUpdateStatus.Checking;
  const updateBadge = shouldShowUpdateBadge ? (
    <AppUpdateBadge
      latestVersion={updateInfo.latestVersion}
      status={appUpdateState.status}
      progress={appUpdateState.progress?.percent}
      onClick={handleOpenUpdateModal}
    />
  ) : null;
  const updateCard = updateInfo ? (
    <AppUpdateCard
      updateState={appUpdateState}
      onUpdate={handleConfirmUpdate}
      onShowDetails={handleOpenUpdateModal}
      onCancelDownload={handleCancelDownload}
    />
  ) : null;
  const canUseWindowsTopBarActions = isInitialized && !initError && !isUpdateInteractionBlocked;
  const canUseWindowsCollapsedTopBarActions = canUseWindowsTopBarActions && isSidebarCollapsed;
  const collapsedHeaderUpdateBadge = isSidebarCollapsed && !isWindows ? updateBadge : null;
  const windowsStandaloneTitleBar = isWindows ? (
    <WindowsAppTitleBar
      isOverlayActive={isOverlayActive}
      isSidebarCollapsed={isSidebarCollapsed}
      sidebarWidth={sidebarWidth}
      onToggleSidebar={canUseWindowsTopBarActions ? handleToggleSidebar : undefined}
      onSearch={canUseWindowsTopBarActions && !isSidebarCollapsed
        ? handleOpenTaskSearch
        : undefined}
      onNewChat={canUseWindowsCollapsedTopBarActions ? handleNewChat : undefined}
      sidebarToggleLabel={isSidebarCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
      searchLabel={i18nService.t('search')}
      showFilterIcon={SIDEBAR_TASK_FILTER_ENABLED && canUseWindowsTopBarActions && !isSidebarCollapsed && mainView === 'cowork'}
      filterLabel={i18nService.t('sidebarFilter')}
      isFilterActive={isTaskFilterActive}
      hasFilterNotice={hasUnreadCompletedTasks}
      onToggleFilter={handleToggleTaskFilter}
      newChatLabel={i18nService.t('newChat')}
      updateBadge={canUseWindowsCollapsedTopBarActions ? updateBadge : null}
    />
  ) : null;

  // Multi-tenant enterprise gate. When the enterpriseMt bridge is configured
  // we require a valid session before continuing to the main UI. The
  // `enterpriseMtLoggedIn === null` state means we're still probing; render
  // the splash screen so we don't flash a login page before checking.
  const showEnterpriseSetupModal =
    enterpriseBootstrapStatus !== null &&
    enterpriseBootstrapStatus.configured === false;
  if (showEnterpriseSetupModal) {
    const handleSetupVerify = async (
      url: string
    ): Promise<{ ok: boolean; error?: string }> => {
      const win = window as unknown as {
        electron?: {
          enterpriseMt?: {
            verifyUrl: (url: string) => Promise<{ ok: boolean; error?: string }>;
          };
        };
      };
      return win.electron!.enterpriseMt!.verifyUrl(url);
    };
    const handleSetupSave = async (
      url: string
    ): Promise<{ ok: boolean; error?: string }> => {
      const win = window as unknown as {
        electron?: {
          enterpriseMt?: {
            saveUrl: (url: string) => Promise<{
              ok: boolean;
              status?: { configured: boolean; url: string | null };
              error?: string;
            }>;
          };
        };
      };
      // saveUrl persists to SQLite + re-points the in-memory client. Re-run
      // the probe to transition loggedIn from null → false so the login
      // gate renders.
      const result = await win.electron!.enterpriseMt!.saveUrl(url);
      if (!result.ok) {
        return result;
      }
      if (result.status) {
        setEnterpriseBootstrapStatus(result.status);
      }
      void probeEnterpriseBootstrap();
      return { ok: true };
    };
    const handleSetupQuit = (): void => {
      const win = window as unknown as {
        electron?: { enterpriseMt?: { quit: () => Promise<void> } };
      };
      void win.electron!.enterpriseMt!.quit();
    };
    return (
      <EnterpriseSetupModal
        initialUrl={enterpriseBootstrapStatus.url ?? ''}
        onVerify={handleSetupVerify}
        onSave={handleSetupSave}
        onQuit={handleSetupQuit}
      />
    );
  }

  const showEnterpriseLoginGate =
    enterpriseMtLoggedIn === false || // probe failed → render login
    // probe succeeded but user just clicked "logout" mid-session
    (typeof window !== 'undefined' &&
      (window as unknown as { __forceEnterpriseMtLogin?: boolean }).__forceEnterpriseMtLogin ===
        true);
  if (showEnterpriseLoginGate) {
    return (
      <div className="h-screen overflow-hidden flex flex-col bg-surface">
        {windowsStandaloneTitleBar}
        <LoginPage
          onSuccess={() => {
            setEnterpriseMtLoggedIn(true);
            (window as unknown as { __forceEnterpriseMtLogin?: boolean }).__forceEnterpriseMtLogin = false;
          }}
        />
      </div>
    );
  }

  if (!isInitialized) {
    // index.html's static splash shows the same startup page until React
    // mounts; rendering EngineStartupOverlay from the first frame keeps the
    // whole startup on one continuous screen with no visual handoff.
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 bg-surface" />
        <EngineStartupOverlay bootstrapping />
      </div>
    );
  }

  if (initError) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex flex-col items-center justify-center bg-background">
          <div className="flex flex-col items-center space-y-6 max-w-md px-6">
            <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="text-foreground text-xl font-medium text-center">{initError}</div>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={handleInitRetry}
                className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-xl transition-colors text-sm font-medium"
              >
                {i18nService.t('retry')}
              </button>
              <button
                onClick={() => window.electron.appInfo.relaunch()}
                className="px-6 py-2.5 border border-border text-foreground hover:bg-surface-raised rounded-xl transition-colors text-sm font-medium"
              >
                {i18nService.t('restartApp')}
              </button>
              {enterpriseConfigLoaded && (
                <button
                  onClick={() => handleShowSettings()}
                  className="px-6 py-2.5 border border-border text-foreground hover:bg-surface-raised rounded-xl transition-colors text-sm font-medium"
                >
                  {i18nService.t('openSettings')}
                </button>
              )}
            </div>
          </div>
          {showSettings && (
            <SkinProvider>
              <Settings
                onClose={handleCloseSettings}
                initialTab={settingsOptions.initialTab}
                initialTabRequestId={settingsOptions.requestId}
                notice={settingsOptions.notice}
                onUpdateFound={handleUpdateFound}
                enterpriseConfig={enterpriseConfig}
              />
            </SkinProvider>
          )}
        </div>
      </div>
    );
  }

  return (
    <SkinProvider>
      <SkinPresentationScope
        enabled
        className="h-screen overflow-hidden flex flex-col bg-surface-raised"
      >
      {toastMessage && (
        <Toast
          message={toastMessage.message}
          actionLabel={toastMessage.actionLabel}
          onAction={toastMessage.onAction}
          closeLabel={i18nService.t('close')}
          onClose={() => setToastMessage(null)}
        />
      )}
      {windowsStandaloneTitleBar}
      <div
        className="relative flex flex-1 min-h-0 overflow-hidden"
        aria-busy={isUpdateInteractionBlocked}
      >
        <Sidebar
          onShowLogin={handleShowLogin}
          onShowSettings={handleShowSettings}
          activeView={mainView === 'ssoBindings' ? 'cowork' : mainView}
          onShowSkills={handleShowSkills}
          onShowCowork={handleShowCowork}
          onShowScheduledTasks={handleShowScheduledTasks}
          onShowKits={handleShowKits}
          onShowLibrary={handleShowLibrary}
          onNewChat={handleNewChat}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
          isTaskFilterActive={isTaskFilterActive}
          hasUnreadCompletedTasks={hasUnreadCompletedTasks}
          onToggleTaskFilter={handleToggleTaskFilter}
          onTaskFilterSummaryChange={setHasUnreadCompletedTasks}
          onWidthChange={setSidebarWidth}
          updateNotice={!isSidebarCollapsed && !isUpdateInteractionBlocked ? updateCard : null}
        />
        <div className={`flex-1 min-w-0 transition-[padding] duration-200 ease-out ${isSidebarCollapsed ? 'pl-1.5' : ''}`}>
          <div
            data-skin-cowork-frame={mainView === 'cowork' ? 'true' : undefined}
            data-skin-management-frame={mainView !== 'cowork' ? 'true' : undefined}
            className="relative h-full min-h-0 rounded-xl border border-border bg-background overflow-hidden"
          >
            {mainView !== 'cowork' && (
              <SkinBackdrop variant={SkinBackdropVariant.Management} />
            )}
            <EngineStartupOverlay />
            {mainView === 'skills' || mainView === 'mcp' ? (
              <SkillsAndConnectorsView
                activeSection={mainView === 'mcp' ? SkillsConnectorsSection.Connectors : SkillsConnectorsSection.Skills}
                onSectionChange={handleSkillsConnectorsSectionChange}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                onCreateSkillByChat={handleCreateSkillByChat}
                onUseSkill={handleSkillUse}
                updateBadge={collapsedHeaderUpdateBadge}
                skillsReadOnly={enterpriseConfig?.ui?.skills === 'readonly'}
              />
            ) : mainView === 'scheduledTasks' ? (
              <ScheduledTasksView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={collapsedHeaderUpdateBadge}
              />
            ) : mainView === 'kits' ? (
              <KitsView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={collapsedHeaderUpdateBadge}
                onTryAsking={handleKitTryAsking}
                onUseKit={handleKitUse}
              />
            ) : mainView === 'library' ? (
              <LibraryView
                isAuthenticated={Boolean(authUser)}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onOpenSession={handleOpenLibrarySession}
                sitesHidden={enterpriseConfig?.ui?.sites === 'hide'}
                sitesReadOnly={enterpriseConfig?.ui?.sites === 'readonly'}
                updateBadge={collapsedHeaderUpdateBadge}
                requestedSource={libraryNavigationRequest.source}
                navigationRequestId={libraryNavigationRequest.requestId}
              />
            ) : mainView === 'ssoBindings' ? (
              <SsoBindingsPage
                onBack={() => {
                  setMainView('cowork');
                }}
              />
            ) : (
              <GenWorkView
                onRequestAppSettings={handleShowSettings}
                onShowSkills={handleShowSkills}
                onShowKits={handleShowKits}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={collapsedHeaderUpdateBadge}
                minimizedPermission={isPendingPermissionMinimized ? pendingPermission : null}
                onRestorePermission={handleRestorePermission}
                onRespondToPermission={handlePermissionResponse}
              />
            )}
          </div>
        </div>
        {isUpdateInteractionBlocked && (
          <AppUpdateInteractionOverlay>
            <AppUpdateBlockingPanel
              updateState={appUpdateState}
              onCancelDownload={handleCancelDownload}
            />
          </AppUpdateInteractionOverlay>
        )}
      </div>

      <EngineFailureOverlay
        onRequestAppSettings={handleShowSettings}
        suspended={showSettings || showUpdateModal || isPermissionModalOpen}
      />

      {/* 设置窗口显示在所有主内容之上，但不影响主界面的交互 */}
      {showSettings && (
        <Settings
          onClose={handleCloseSettings}
          onStartAiSkin={handleStartAiSkinFromSettings}
          initialTab={settingsOptions.initialTab}
          initialTabRequestId={settingsOptions.requestId}
          notice={settingsOptions.notice}
          onUpdateFound={handleUpdateFound}
          enterpriseConfig={enterpriseConfig}
        />
      )}
      {showUpdateModal && updateInfo && (
        <AppUpdateModal
          updateState={appUpdateState}
          onCancel={() => {
            if (appUpdateState.status !== AppUpdateStatus.Downloading && appUpdateState.status !== AppUpdateStatus.Installing) {
              setShowUpdateModal(false);
            }
          }}
          onConfirm={handleConfirmUpdate}
          onCancelDownload={handleCancelDownload}
          onRetry={handleRetryUpdate}
        />
      )}
      {permissionModal}
      </SkinPresentationScope>
    </SkinProvider>
  );
};

export default App;
