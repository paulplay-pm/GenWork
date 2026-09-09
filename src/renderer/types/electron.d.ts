import type { OpenClawSessionPatch } from '../../common/openclawSession';
import type { AppUpdateCheckResult, AppUpdateRuntimeState } from '../../shared/appUpdate/constants';
import type {
  AsrRealtimeSessionRequest,
  AsrRealtimeSessionResult,
} from '../../shared/asr/constants';
import type {
  AuthLifecycleEvent,
  AuthSessionChangedEvent,
  AuthSessionStatus,
} from '../../shared/auth/constants';
import type {
  BrowserDiagnosticResult,
  BrowserRuntimeProfile,
} from '../../shared/browserWebAccess/constants';
import type {
  DataMigrationBackupResult,
  DataMigrationLastRestoreResponse,
  DataMigrationRestoreScheduleResult,
} from '../../shared/dataMigration/constants';
import type { EnterpriseQuotaRequestType } from '../../shared/enterpriseAccount/constants';
import type {
  EnterpriseAccountContext,
  EnterpriseAccountContextResult,
  EnterpriseAccountIdentitiesResult,
  EnterpriseQuotaRequestResult,
} from '../../shared/enterpriseAccount/types';
import type {
  BrowserAnnotationRect,
  BrowserAnnotationScreenshotRef,
  CoworkBrowserAnnotationMessageBatch,
} from '../../shared/genwork/browserAnnotations';
import type {
  CoworkBtwAbortRequest,
  CoworkBtwAbortResponse,
  CoworkBtwEntry,
  CoworkBtwSubmitRequest,
  CoworkBtwSubmitResponse,
} from '../../shared/genwork/btw';
import type {
  CoworkContextUsageFailureReason,
  CoworkContextUsageSource,
  CoworkSessionsChangedPayload,
} from '../../shared/genwork/constants';
import type { CoworkGoal } from '../../shared/genwork/goal';
import type { CoworkMessageRailIndexItem } from '../../shared/genwork/rail';
import type {
  CoworkSearchMessage,
  CoworkSearchMessageCursor,
} from '../../shared/genwork/search';
import type {
  HtmlShareStatus,
} from '../../shared/htmlShare/constants';
import type {
  InstalledKitRecord,
  KitReference,
  KitSkillMetadata,
  ResolvedKitCapabilities,
} from '../../shared/kit/constants';
import type {
  LibraryAddLocalFilesData,
  LibraryArtifactCandidate,
  LibraryBackfillState,
  LibraryChangedPayload,
  LibraryCloudListData,
  LibraryCloudListOptions,
  LibraryFavoriteInput,
  LibraryGetLocalItemsData,
  LibraryGetLocalItemsInput,
  LibraryIndexStatus,
  LibraryLocalDetailData,
  LibraryLocalListData,
  LibraryLocalListOptions,
  LibraryRecordCandidatesData,
  LibraryResult,
} from '../../shared/library/types';
import type {
  ListLocalWebServicesOptions,
  LocalWebService,
} from '../../shared/localWebServices/constants';
import type { ConnectorSubmitRequest } from '../../shared/mcp/constants';
import type {
  OpenClawEngineErrorCode,
  OpenClawEnginePhase as SharedOpenClawEnginePhase,
  OpenClawGatewayRepairErrorCode,
} from '../../shared/openclawEngine/constants';
import type {
  PublishingQuota,
  PublishingQuotaErrorData,
} from '../../shared/publishing/constants';
import type {
  ShareDeploymentAnalyzeProjectInput,
  ShareDeploymentCreateNodeInput,
  ShareDeploymentDetectCandidatesInput,
  ShareDeploymentDetectCandidatesResult,
  ShareDeploymentDownloadPersistenceInput,
  ShareDeploymentDownloadPersistenceResult,
  ShareDeploymentGetByLocalServiceInput,
  ShareDeploymentPersistenceInfoResult,
  ShareDeploymentProjectAnalysis,
  ShareDeploymentResult,
  ShareDeploymentSelectPersistencePathInput,
  ShareDeploymentSelectPersistencePathResult,
} from '../../shared/shareDeployment/constants';
import type {
  ShellGetBrowserAppsInput,
  ShellOpenFailureReason,
} from '../../shared/shell/constants';
import type {
  SiteAnalytics,
  SiteAnalyticsOptions,
  SiteDeploymentQuota,
  SiteDeploymentQuotaOptions,
  SiteDetail,
  SiteListData,
  SiteListOptions,
  SiteQuotaReservation,
  SiteQuotaReservationInput,
  SiteResult,
  SiteUpdateAccessModeInput,
  SiteUpdateAccessStatusInput,
  SiteUpdateTitleInput,
} from '../../shared/site/constants';
import type { SkillSubmitRequest } from '../../shared/skills/constants';
import type {
  SkinApplyResponse,
  SkinBindThemeResponse,
  SkinDeactivateResponse,
  SkinDeleteResponse,
  SkinGetActiveResponse,
  SkinListResponse,
} from '../../shared/skin/types';
import type { UserProfile, UserQuota } from '../store/slices/authSlice';
import type { CoworkTempDirPreview } from './genwork';
interface ApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
  error?: string;
}

interface ApiStreamResponse {
  ok: boolean;
  status: number;
  statusText: string;
  error?: string;
}

interface ShellActionResponse {
  success: boolean;
  error?: string;
  reason?: ShellOpenFailureReason;
}

// Cowork types for IPC
interface CoworkSession {
  id: string;
  title: string;
  openclawSessionId: string | null;
  scheduledTaskId: string | null;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  pinOrder?: number | null;
  cwd: string;
  systemPrompt: string;
  modelOverride: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  activeSkillIds: string[];
  agentId: string;
  messages: CoworkMessage[];
  messagesOffset: number;
  totalMessages: number;
  parentSessionId?: string | null;
  forkedFromMessageId?: string | null;
  forkedAt?: number | null;
  forkMode?: 'none' | 'conversation' | 'worktree';
  forkWorkspacePath?: string | null;
  forkGitBranch?: string | null;
  forkGitBaseRef?: string | null;
  createdAt: number;
  updatedAt: number;
}

interface CoworkMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface CoworkSessionSummary {
  id: string;
  title: string;
  scheduledTaskId: string | null;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  pinOrder?: number | null;
  agentId?: string;
  parentSessionId?: string | null;
  forkedAt?: number | null;
  forkMode?: 'none' | 'conversation' | 'worktree';
  createdAt: number;
  updatedAt: number;
}

type CoworkSessionStatus = 'idle' | 'running' | 'completed' | 'error';

interface CoworkContextUsage {
  sessionId: string;
  sessionKey?: string;
  usedTokens?: number;
  contextTokens?: number;
  percent?: number;
  compactionCount?: number;
  status: 'unknown' | 'normal' | 'warning' | 'danger' | 'compacting';
  latestCompactionCheckpointId?: string;
  latestCompactionReason?: string;
  latestCompactionCreatedAt?: number;
  model?: string;
  updatedAt: number;
}

interface CoworkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  agentEngine: 'openclaw';
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
  skipMissedJobs: boolean;
  openClawHeartbeatEnabled: boolean;
  embeddingEnabled: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingLocalModelPath: string;
  embeddingVectorWeight: number;
  embeddingRemoteBaseUrl: string;
  embeddingRemoteApiKey: string;
  openClawSessionPolicy: OpenClawSessionPolicyConfig;
}

type CoworkConfigUpdate = Partial<
  Pick<
    CoworkConfig,
    | 'workingDirectory'
    | 'executionMode'
    | 'agentEngine'
    | 'memoryEnabled'
    | 'memoryImplicitUpdateEnabled'
    | 'memoryLlmJudgeEnabled'
    | 'memoryGuardLevel'
    | 'memoryUserMemoriesMaxItems'
    | 'skipMissedJobs'
    | 'openClawHeartbeatEnabled'
    | 'embeddingEnabled'
    | 'embeddingProvider'
    | 'embeddingModel'
    | 'embeddingLocalModelPath'
    | 'embeddingVectorWeight'
    | 'embeddingRemoteBaseUrl'
    | 'embeddingRemoteApiKey'
  >
>;

interface CoworkTempStorageUsageResult {
  success: boolean;
  dirs?: CoworkTempDirPreview[];
  bytes?: number;
  files?: number;
  cleanableBytes?: number;
  cleanableFiles?: number;
  truncated?: boolean;
  error?: string;
}

interface CoworkTempStorageCleanResult {
  success: boolean;
  sweptDirs?: number;
  deletedFiles?: number;
  freedBytes?: number;
  skippedEntries?: number;
  truncated?: boolean;
  error?: string;
}

interface CoworkUserMemoryEntry {
  id: string;
  text: string;
  section?: string;
}

interface CoworkMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

interface CoworkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
}

interface GenWorkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: 'anthropic' | 'openai';
}

type OpenClawEnginePhase = SharedOpenClawEnginePhase;

interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  errorCode?: OpenClawEngineErrorCode;
  gatewayPort?: number | null;
  gatewayHttpUrl?: string | null;
  canRetry: boolean;
}

interface OpenClawGatewayRepairResult {
  success: boolean;
  status?: OpenClawEngineStatus;
  originalPath?: string;
  backupPath?: string;
  error?: string;
  errorCode?: OpenClawGatewayRepairErrorCode;
  recoverable?: boolean;
}

interface OpenClawSessionPolicyConfig {
  keepAlive: '1d' | '7d' | '30d' | '365d';
}

interface WindowState {
  isMaximized: boolean;
  isFullscreen: boolean;
  isFocused: boolean;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isOfficial: boolean;
  isBuiltIn: boolean;
  updatedAt: number;
  prompt: string;
  skillPath: string;
}

type EmailConnectivityCheckCode = 'imap_connection' | 'smtp_connection';
type EmailConnectivityCheckLevel = 'pass' | 'fail';
type EmailConnectivityVerdict = 'pass' | 'fail';

interface EmailConnectivityCheck {
  code: EmailConnectivityCheckCode;
  level: EmailConnectivityCheckLevel;
  message: string;
  durationMs: number;
}

interface EmailConnectivityTestResult {
  testedAt: number;
  verdict: EmailConnectivityVerdict;
  checks: EmailConnectivityCheck[];
}

interface EmailSkillAccountConfig {
  id: string;
  name: string;
  enabled: boolean;
  provider?: string;
  email: string;
  password?: string;
  imapHost?: string;
  imapPort?: number;
  imapTls?: boolean;
  imapRejectUnauthorized?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpRejectUnauthorized?: boolean;
  smtpFrom?: string;
  mailbox?: string;
  requireSendConfirmation?: boolean;
}

interface EmailSkillAccountsConfig {
  version: 1;
  defaultAccountId: string;
  accounts: EmailSkillAccountConfig[];
}

type CoworkPermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

interface McpServerConfigIPC {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isBuiltIn: boolean;
  githubUrl?: string;
  registryId?: string;
  launchResolution?: {
    serverId: string;
    resolverKind: 'npx' | 'uvx' | 'python' | 'raw';
    sourceFingerprint: string;
    status: 'pending' | 'installing' | 'ready' | 'failed' | 'unsupported';
    packageName?: string;
    requestedVersion?: string;
    resolvedVersion?: string;
    installDir?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    error?: string;
    installedAt?: number;
    resolvedAt?: number;
    lastProbeAt?: number;
    lastProbeStatus?: string;
    updatedAt: number;
  };
  authMethod: 'none' | 'bearer' | 'api-key' | 'oauth';
  authStatus: 'authenticated' | 'needs-auth' | 'auth-error';
  /** Catalog identity for enterprise connectors (absent for built-ins). */
  serverKey?: string;
  /** Non-secret user-oauth endpoint config (absent unless user-oauth).
   * Mirrors McpOAuthEndpoint in renderer/types/mcp.ts — keep in sync. */
  oauthConfig?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] };
  apiKeyHeaderName?: string;
  createdAt: number;
  updatedAt: number;
}

import type { AgentLegacyIdentityCleanupResult } from '@shared/agent';
import type { Platform } from '@shared/platform';

import type { Agent, PresetAgent } from './agent';

interface HtmlShareResult {
  success: boolean;
  shareId?: string;
  url?: string;
  accessMode?: HtmlShareAccessMode;
  status?: HtmlShareStatus;
  updatedAt?: string;
  contentUpdatedAt?: string;
  disabledReason?: string | null;
  disabledSource?: HtmlShareDisabledSource | null;
  restoredByUpdate?: boolean;
  // Publisher-era fields retained for renderer backward compatibility.
  // The enterprise server returns null/empty for these on the wire.
  shareCode?: string | null;
  shareCodeUnavailable?: boolean;
  accessExpiresAt?: string | null;
  error?: string;
  code?: number;
  quota?: PublishingQuotaErrorData;
  warnings?: string[];
}

interface IElectronAPI {
  platform: string;
  arch: string;
  store: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  ssoBinding: {
    list: () => Promise<unknown>;
    unbind: () => Promise<unknown>;
    start: (connectionId: string) => Promise<unknown>;
  };
  skills: {
    list: () => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    setEnabled: (options: {
      id: string;
      enabled: boolean;
    }) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    download: (source: string) => Promise<{
      success: boolean;
      skills?: Skill[];
      error?: string;
      auditReport?: any;
      pendingInstallId?: string;
    }>;
    upgrade: (
      skillId: string,
      downloadUrl: string,
    ) => Promise<{
      success: boolean;
      skills?: Skill[];
      error?: string;
      auditReport?: any;
      pendingInstallId?: string;
    }>;
    confirmInstall: (
      pendingId: string,
      action: string,
    ) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    getRoot: () => Promise<{ success: boolean; path?: string; error?: string }>;
    autoRoutingPrompt: () => Promise<{ success: boolean; prompt?: string | null; error?: string }>;
    getConfig: (
      skillId: string,
    ) => Promise<{ success: boolean; config?: Record<string, string>; error?: string }>;
    setConfig: (
      skillId: string,
      config: Record<string, string>,
    ) => Promise<{ success: boolean; error?: string }>;
    getEmailAccountsConfig: (
      skillId: string,
    ) => Promise<{ success: boolean; config?: EmailSkillAccountsConfig; error?: string }>;
    setEmailAccountsConfig: (
      skillId: string,
      config: EmailSkillAccountsConfig,
    ) => Promise<{ success: boolean; error?: string }>;
    testEmailAccountConnectivity: (
      skillId: string,
      account: EmailSkillAccountConfig,
    ) => Promise<{ success: boolean; result?: EmailConnectivityTestResult; error?: string }>;
    testEmailConnectivity: (
      skillId: string,
      config: Record<string, string>,
    ) => Promise<{ success: boolean; result?: EmailConnectivityTestResult; error?: string }>;
    fetchMarketplace: () => Promise<{
      success: boolean;
      skills?: Array<Record<string, unknown>>;
      categories?: Array<{ id: string; en: string; zh: string }>;
      error?: string;
    }>;
    detectFromOpenClaw: () => Promise<{
      skills: Array<{ name: string; description: string; skillKey: string; baseDir: string }>;
      error?: string;
    }>;
    syncFromOpenClaw: () => Promise<{ synced: string[]; error?: string }>;
    refreshPluginSkillIds: () => Promise<{ success: boolean; pluginSkillIds?: string[]; error?: string }>;
    submit: (req: SkillSubmitRequest) => Promise<{
      success: boolean;
      data?: { id: string };
      error?: string;
    }>;
    onChanged: (callback: () => void) => () => void;
    onMarketplaceChanged: (callback: () => void) => () => void;
  };
  mcp: {
    list: () => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    create: (
      data: any,
    ) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    update: (
      id: string,
      data: any,
    ) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    delete: (
      id: string,
    ) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    deleteByRegistryId: (
      registryId: string,
    ) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    setEnabled: (options: {
      id: string;
      enabled: boolean;
    }) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    setEnabledByRegistryId: (options: {
      registryId: string;
      enabled: boolean;
    }) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    retryLaunchResolution: (
      id: string,
    ) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    fetchEnterpriseMarketplace: () => Promise<{
      success: boolean;
      data?: {
        categories: Array<{ id: string; name_zh: string; name_en: string }>;
        servers: Array<{
          id: string;
          serverKey: string;
          name: string;
          nameZh: string | null;
          description: string;
          category: string;
          version: string;
          connectorType: 'mcp' | 'app';
          url: string;
          transport: 'http' | 'sse';
          authMode: 'none' | 'shared-key' | 'user-key' | 'user-oauth' | 'client-creds' | 'sso';
          authStatus: 'configured' | 'pending';
          scopeSummary: string;
          hasDraft: boolean;
          enabled: boolean;
          toolCount: number;
          /** Present only for `user-oauth` with complete endpoints (non-secret). */
          oauth?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] };
          /** Present only for `user-key` with a header name set (non-secret). */
          apiKeyHeaderName?: string;
        }>;
      };
      error?: string;
    }>;
    submitConnectorRequest: (cfg: ConnectorSubmitRequest) => Promise<{
      success: boolean;
      data?: { id: string };
      error?: string;
    }>;
    connectQichacha: () => Promise<{
      success: boolean;
      servers?: McpServerConfigIPC[];
      error?: string;
    }>;
    onChanged: (callback: () => void) => () => void;
    onAuthFlowRequested: (callback: (options: { id: string }) => void) => () => void;
    startAuth: (options: { id: string }) => Promise<{
      success: boolean;
      authMethod?: string;
      error?: string;
    }>;
    saveCredential: (options: { id: string; payload: unknown }) => Promise<{
      success: boolean;
      servers?: McpServerConfigIPC[];
      result?: unknown;
      error?: string;
    }>;
    probeAuthorization: (options: { id: string }) => Promise<{
      success: boolean;
      servers?: McpServerConfigIPC[];
      result?: unknown;
      error?: string;
    }>;
  };
  kits: {
    fetchStore: () => Promise<{ success: boolean; data?: string; error?: string }>;
    fetchEnterpriseStore: () => Promise<{ success: boolean; data?: unknown; error?: string }>;
    install: (params: {
      kitId: string;
      bundleUrl: string;
      version: string;
      skillListIds: string[];
      skillList?: KitSkillMetadata[];
      mcpServers?: unknown[] | null;
      connectors?: unknown[] | null;
    }) => Promise<{ success: boolean; skillIds?: string[]; error?: string }>;
    uninstall: (kitId: string) => Promise<{ success: boolean; error?: string }>;
    listInstalled: () => Promise<{
      success: boolean;
      installed?: Record<string, InstalledKitRecord>;
      error?: string;
    }>;
  };
  skin: {
    getActive: () => Promise<SkinGetActiveResponse>;
    list: () => Promise<SkinListResponse>;
    apply: (skinId: string, boundThemeId?: string) => Promise<SkinApplyResponse>;
    bindTheme: (skinId: string, themeId: string) => Promise<SkinBindThemeResponse>;
    deactivate: () => Promise<SkinDeactivateResponse>;
    delete: (skinId: string) => Promise<SkinDeleteResponse>;
    onChanged: (callback: () => void) => () => void;
  };
  agents: {
    list: () => Promise<Agent[]>;
    get: (id: string) => Promise<Agent | null>;
    create: (request: {
      id?: string;
      name: string;
      description?: string;
      systemPrompt?: string;
      identity?: string;
      model?: string;
      thinkingLevel?: Agent['thinkingLevel'];
      workingDirectory?: string;
      icon?: string;
      skillIds?: string[];
      subagentAllowAgentIds?: string[];
      source?: string;
      presetId?: string;
      enterpriseAgentId?: string;
    }) => Promise<Agent>;
    update: (
      id: string,
      updates: {
        name?: string;
        description?: string;
        systemPrompt?: string;
        identity?: string;
        model?: string;
        thinkingLevel?: Agent['thinkingLevel'];
        workingDirectory?: string;
        icon?: string;
        skillIds?: string[];
        subagentAllowAgentIds?: string[];
        enabled?: boolean;
        pinned?: boolean;
        sortOrder?: number | null;
      },
    ) => Promise<Agent>;
    reorder: (agentIds: string[]) => Promise<Agent[] | null>;
    cleanupLegacyIdentityBlock: (id: string) => Promise<AgentLegacyIdentityCleanupResult>;
    delete: (id: string) => Promise<boolean>;
    presets: () => Promise<PresetAgent[]>;
    presetTemplates: () => Promise<PresetAgent[]>;
    addPreset: (presetId: string) => Promise<Agent>;
    fetchEnterpriseAgents: () => Promise<{ success: boolean; report?: { upserted: number; removed: number; skipped: number }; error?: string }>;
    getEnterpriseAgentWorkingDirectory: (agentId: string) => Promise<{ success: boolean; workingDirectory?: string; error?: string }>;
    setEnterpriseAgentWorkingDirectory: (agentId: string, workingDirectory: string) => Promise<{ success: boolean; error?: string }>;
    getEnterpriseAgentModel: (agentId: string) => Promise<{ success: boolean; modelRef?: string; error?: string }>;
    setEnterpriseAgentModel: (agentId: string, modelRef: string) => Promise<{ success: boolean; error?: string }>;
  };
  api: {
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => Promise<ApiResponse>;
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => Promise<ApiStreamResponse>;
    cancelStream: (requestId: string) => Promise<boolean>;
    onStreamData: (requestId: string, callback: (chunk: string) => void) => () => void;
    onStreamDone: (requestId: string, callback: () => void) => () => void;
    onStreamError: (requestId: string, callback: (error: string) => void) => () => void;
    onStreamAbort: (requestId: string, callback: () => void) => () => void;
  };
  getApiConfig: () => Promise<GenWorkApiConfig | null>;
  checkApiConfig: (options?: {
    probeModel?: boolean;
  }) => Promise<{ hasConfig: boolean; config: GenWorkApiConfig | null; error?: string }>;
  saveApiConfig: (config: GenWorkApiConfig) => Promise<{ success: boolean; error?: string }>;
  generateSessionTitle: (userInput: string | null) => Promise<string>;
  getRecentCwds: (limit?: number) => Promise<string[]>;
  dsh: {
    getState: () => Promise<{
      phase: string;
      port: number | null;
      version: string | null;
      errorCode: string | null;
      sessionStoreShared?: boolean;
      install?: { stage: string; receivedBytes: number; totalBytes: number } | null;
    }>;
    getConfig: () => Promise<{ enabled: boolean }>;
    setEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
    openWorkbench: () => Promise<{ url: string }>;
    stop: () => Promise<{ phase: string; port: number | null; version: string | null; errorCode: string | null }>;
  };
  openclaw: {
    engine: {
      getStatus: () => Promise<{ success: boolean; status?: OpenClawEngineStatus; error?: string }>;
      install: () => Promise<{ success: boolean; status?: OpenClawEngineStatus; error?: string }>;
      retryInstall: () => Promise<{
        success: boolean;
        status?: OpenClawEngineStatus;
        error?: string;
      }>;
      restartGateway: () => Promise<{
        success: boolean;
        status?: OpenClawEngineStatus;
        error?: string;
      }>;
      repairGatewayState: () => Promise<OpenClawGatewayRepairResult>;
      onProgress: (callback: (status: OpenClawEngineStatus) => void) => () => void;
    };
    sessionPolicy: {
      get: () => Promise<{
        success: boolean;
        config?: OpenClawSessionPolicyConfig;
        error?: string;
      }>;
      set: (
        config: OpenClawSessionPolicyConfig,
      ) => Promise<{ success: boolean; config?: OpenClawSessionPolicyConfig; error?: string }>;
    };
    session: {
      patch: (options: {
        sessionId: string;
        patch: OpenClawSessionPatch;
      }) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    };
    browser: {
      getStatus: (options?: { profile?: BrowserRuntimeProfile }) => Promise<{ success: boolean; status?: Record<string, unknown>; error?: string }>;
      listProfiles: () => Promise<{ success: boolean; profiles?: unknown[]; error?: string }>;
      test: (options?: { profile?: BrowserRuntimeProfile }) => Promise<BrowserDiagnosticResult>;
      resetProfile: (options?: { profile?: BrowserRuntimeProfile }) => Promise<{ success: boolean; result?: Record<string, unknown>; error?: string }>;
    };
    dataMigration: {
      backup: () => Promise<DataMigrationBackupResult>;
      restore: () => Promise<DataMigrationRestoreScheduleResult>;
      getLastRestoreResult: () => Promise<DataMigrationLastRestoreResponse>;
    };
  };
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => void;
    on: (channel: string, func: (...args: any[]) => void) => () => void;
  };
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    showSystemMenu: (position: { x: number; y: number }) => void;
    onStateChanged: (callback: (state: WindowState) => void) => () => void;
  };
  cowork: {
    startSession: (options: {
      prompt: string;
      cwd?: string;
      systemPrompt?: string;
      title?: string;
      activeSkillIds?: string[];
      runtimeSkillIds?: string[];
      kitIds?: string[];
      kitReferences?: KitReference[];
      resolvedKitCapabilities?: ResolvedKitCapabilities;
      selectedTextSnippets?: Array<{ id: string; text: string; sourceMessageId?: string; sourceMessageType?: 'assistant' | 'artifact_markdown' | 'artifact_text'; sourceId?: string; sourceType?: 'assistant' | 'artifact_markdown' | 'artifact_text'; sourceTitle?: string; sourcePath?: string; artifactId?: string; createdAt: number; startOffset?: number; endOffset?: number }>;
      browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
      agentId?: string;
      modelOverride?: string;
      thinkingLevel?: string;
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string; sizeBytes?: number; localPath?: string; previewMimeType?: string; previewBase64Data?: string }>;
      mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string };
      mediaReferences?: Array<{ token: string; mediaType: string; index: number; fileId: string; fileName: string; mimeType: string; localPath?: string; remoteUrl?: string; dataUrl?: string; role?: string }>;
    }) => Promise<{
      success: boolean;
      session?: CoworkSession;
      error?: string;
      code?: string;
      engineStatus?: OpenClawEngineStatus;
    }>;
    continueSession: (options: {
      sessionId: string;
      prompt: string;
      systemPrompt?: string;
      activeSkillIds?: string[];
      runtimeSkillIds?: string[];
      kitIds?: string[];
      kitReferences?: KitReference[];
      resolvedKitCapabilities?: ResolvedKitCapabilities;
      selectedTextSnippets?: Array<{ id: string; text: string; sourceMessageId?: string; sourceMessageType?: 'assistant' | 'artifact_markdown' | 'artifact_text'; sourceId?: string; sourceType?: 'assistant' | 'artifact_markdown' | 'artifact_text'; sourceTitle?: string; sourcePath?: string; artifactId?: string; createdAt: number; startOffset?: number; endOffset?: number }>;
      browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string; sizeBytes?: number; localPath?: string; previewMimeType?: string; previewBase64Data?: string }>;
      mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string };
      mediaReferences?: Array<{ token: string; mediaType: string; index: number; fileId: string; fileName: string; mimeType: string; localPath?: string; remoteUrl?: string; dataUrl?: string; role?: string }>;
    }) => Promise<{
      success: boolean;
      session?: CoworkSession;
      error?: string;
      code?: string;
      engineStatus?: OpenClawEngineStatus;
    }>;
    submitBtw: (options: CoworkBtwSubmitRequest) => Promise<CoworkBtwSubmitResponse>;
    abortBtw: (options: CoworkBtwAbortRequest) => Promise<CoworkBtwAbortResponse>;
    submitSteer: (options: { sessionId: string; text: string; clientSteerId: string }) => Promise<{
      success: boolean;
      status: 'pending' | 'accepted' | 'rejected';
      clientSteerId: string;
      error?: string;
      reason?:
        | 'no_active_turn'
        | 'not_streaming'
        | 'context_maintenance'
        | 'runtime_unsupported'
        | 'runtime_rejected'
        | 'empty_input'
        | 'unknown';
    }>;
    runGoalCommand: (options: { sessionId: string; command: string }) => Promise<{
      success: boolean;
      goal?: CoworkGoal | null;
      error?: string;
      code?: string;
      engineStatus?: OpenClawEngineStatus;
    }>;
    stopSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    deleteSessions: (sessionIds: string[]) => Promise<{ success: boolean; error?: string }>;
    setSessionPinned: (options: {
      sessionId: string;
      pinned: boolean;
    }) => Promise<{ success: boolean; pinOrder?: number | null; error?: string }>;
    renameSession: (options: {
      sessionId: string;
      title: string;
    }) => Promise<{ success: boolean; error?: string }>;
    forkSession: (options: {
      sessionId: string;
      forkedFromMessageId?: string | null;
      title?: string;
    }) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    getSession: (
      sessionId: string,
    ) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    markSessionViewed: (
      sessionId: string,
    ) => Promise<{ success: boolean; error?: string }>;
    setActiveSession: (
      sessionId: string | null,
    ) => Promise<{ success: boolean; error?: string }>;
    remoteManaged: (
      sessionId: string,
    ) => Promise<{ success: boolean; remoteManaged: boolean; error?: string }>;
    listSessions: (options?: { limit?: number; offset?: number; agentId?: string; searchQuery?: string }) => Promise<{
      success: boolean;
      sessions?: CoworkSessionSummary[];
      hasMore?: boolean;
      error?: string;
    }>;
    getContextUsage: (
      sessionId: string,
    ) => Promise<{
      success: boolean;
      usage?: CoworkContextUsage | null;
      source?: CoworkContextUsageSource;
      reason?: CoworkContextUsageFailureReason;
      error?: string;
    }>;
    compactContext: (
      sessionId: string,
    ) => Promise<{
      success: boolean;
      compacted?: boolean;
      reason?: string;
      usage?: CoworkContextUsage | null;
      error?: string;
    }>;
    getSessionMessages: (options: {
      sessionId: string;
      limit?: number;
      offset?: number;
    }) => Promise<{
      success: boolean;
      messages?: CoworkMessage[];
      offset?: number;
      total?: number;
      error?: string;
    }>;
    getSessionSearchMessages: (options: {
      sessionId: string;
      limit?: number;
      offset?: number;
      cursor?: CoworkSearchMessageCursor;
      knownTotal?: number;
    }) => Promise<{
      success: boolean;
      messages?: CoworkSearchMessage[];
      offset?: number;
      nextOffset?: number;
      nextCursor?: CoworkSearchMessageCursor;
      total?: number;
      error?: string;
    }>;
    getSessionMessageRailIndex: (
      sessionId: string,
    ) => Promise<{
      success: boolean;
      items?: CoworkMessageRailIndexItem[];
      error?: string;
    }>;
    exportResultImage: (options: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    captureImageChunk: (options: {
      rect: { x: number; y: number; width: number; height: number };
    }) => Promise<{
      success: boolean;
      width?: number;
      height?: number;
      pngBase64?: string;
      error?: string;
    }>;
    saveResultImage: (options: {
      pngBase64: string;
      defaultFileName?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    exportSessionText: (options: {
      content: string;
      defaultFileName?: string;
      fileExtension?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    exportSessionDiagnostics: (options: {
      sessionId: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    cancelMediaTask: (taskId: string) => Promise<{ success: boolean; message?: string }>;
    getSubTaskHistory: (options: {
      parentSessionId: string;
      agentId: string;
      sessionKey?: string;
    }) => Promise<{
      success: boolean;
      messages?: Array<{
        id: string;
        type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
        content: string;
        timestamp: number;
        metadata?: {
          toolName?: string;
          toolInput?: Record<string, unknown>;
          toolResult?: string;
          toolUseId?: string | null;
          isError?: boolean;
          [key: string]: unknown;
        };
      }>;
      error?: string;
    }>;
    listSubagentSessions: (parentSessionId: string) => Promise<{
      success: boolean;
      runs?: Array<{
        id: string;
        agentId: string | null;
        task: string | null;
        label: string | null;
        sessionKey: string | null;
        childCoworkSessionId?: string | null;
        status: 'running' | 'done' | 'error';
        createdAt: number;
        endedAt: number | null;
      }>;
      error?: string;
    }>;
    listSubagentSessionsByAgent: (options: {
      agentId: string;
      limit?: number;
      offset?: number;
    }) => Promise<{
      success: boolean;
      runs?: Array<{
        id: string;
        agentId: string | null;
        task: string | null;
        label: string | null;
        sessionKey: string | null;
        childCoworkSessionId?: string | null;
        parentSessionId: string;
        parentAgentId?: string | null;
        parentTitle?: string | null;
        parentUpdatedAt?: number | null;
        status: 'running' | 'done' | 'error';
        createdAt: number;
        endedAt: number | null;
      }>;
      hasMore?: boolean;
      error?: string;
    }>;
    deleteSubagentSession: (options: {
      parentSessionId: string;
      runId: string;
    }) => Promise<{ success: boolean; deleted?: boolean; error?: string }>;
    respondToPermission: (options: {
      requestId: string;
      result: CoworkPermissionResult;
    }) => Promise<{ success: boolean; error?: string }>;
    getConfig: () => Promise<{ success: boolean; config?: CoworkConfig; error?: string }>;
    setConfig: (config: CoworkConfigUpdate) => Promise<{ success: boolean; error?: string }>;
    getTempStorageUsage: () => Promise<CoworkTempStorageUsageResult>;
    cleanTempStorage: (options?: { cwds?: string[] }) => Promise<CoworkTempStorageCleanResult>;
    notifyOpenSessionFromNotificationReady: () => Promise<{ success: boolean; error?: string }>;
    onOpenSessionFromNotification: (
      callback: (data: { sessionId: string }) => void,
    ) => () => void;
    listMemoryEntries: (input: {
      query?: string;
      limit?: number;
      offset?: number;
    }) => Promise<{ success: boolean; entries?: CoworkUserMemoryEntry[]; error?: string }>;
    createMemoryEntry: (input: {
      text: string;
    }) => Promise<{ success: boolean; entry?: CoworkUserMemoryEntry; error?: string }>;
    updateMemoryEntry: (input: {
      id: string;
      text: string;
    }) => Promise<{ success: boolean; entry?: CoworkUserMemoryEntry; error?: string }>;
    deleteMemoryEntry: (input: { id: string }) => Promise<{ success: boolean; error?: string }>;
    getMemoryStats: () => Promise<{ success: boolean; stats?: CoworkMemoryStats; error?: string }>;
    readMemoryFileRaw: () => Promise<{ success: boolean; content?: string; error?: string }>;
    writeMemoryFileRaw: (input: {
      content: string;
    }) => Promise<{ success: boolean; error?: string }>;
    readBootstrapFile: (
      filename: string,
      options?: { agentId?: string },
    ) => Promise<{ success: boolean; content: string; error?: string }>;
    writeBootstrapFile: (
      filename: string,
      content: string,
      options?: { agentId?: string },
    ) => Promise<{ success: boolean; error?: string }>;
    onStreamMessage: (
      callback: (data: { sessionId: string; message: CoworkMessage; beforeMessageId?: string }) => void,
    ) => () => void;
    onStreamMessageUpdate: (
      callback: (data: {
        sessionId: string;
        messageId: string;
        content: string;
        metadata?: Record<string, unknown>;
      }) => void,
    ) => () => void;
    onMediaStatusPollUpdate?: (
      callback: (data: { sessionId: string; toolCallId: string; details: Record<string, unknown> }) => void,
    ) => () => void;
    onStreamSessionStatus: (
      callback: (data: { sessionId: string; status: CoworkSessionStatus }) => void,
    ) => () => void;
    onStreamContextUsage?: (
      callback: (data: { sessionId: string; usage: CoworkContextUsage }) => void,
    ) => () => void;
    onStreamGoal?: (
      callback: (data: { sessionId: string; goal: CoworkGoal | null }) => void,
    ) => () => void;
    onStreamBtwResult?: (
      callback: (data: { sessionId: string; result: CoworkBtwEntry }) => void,
    ) => () => void;
    onStreamContextMaintenance?: (
      callback: (data: { sessionId: string; active: boolean }) => void,
    ) => () => void;
    onStreamPermission: (
      callback: (data: { sessionId: string; request: CoworkPermissionRequest }) => void,
    ) => () => void;
    onStreamPermissionDismiss: (callback: (data: { requestId: string }) => void) => () => void;
    onStreamComplete: (
      callback: (data: { sessionId: string; openclawSessionId: string | null }) => void,
    ) => () => void;
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => () => void;
    onSessionsChanged: (
      callback: (data?: CoworkSessionsChangedPayload) => void,
    ) => () => void;
    onSessionModelOverrideChanged?: (
      callback: (data: { sessionId: string; modelOverride: string }) => void,
    ) => () => void;
  };
  dialog: {
    selectDirectory: () => Promise<{ success: boolean; path: string | null }>;
    selectFile: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<{ success: boolean; path: string | null }>;
    selectFiles: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<{ success: boolean; paths: string[] }>;
    getPathForFile?: (file: File) => string;
    saveInlineFile: (options: {
      dataBase64: string;
      fileName?: string;
      mimeType?: string;
      cwd?: string;
    }) => Promise<{ success: boolean; path: string | null; error?: string }>;
    readFileAsDataUrl: (
      filePath: string,
    ) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
    statFile: (
      filePath: string,
    ) => Promise<{ success: boolean; isFile?: boolean; isDirectory?: boolean; size?: number; mtimeMs?: number; error?: string }>;
    readTextFile: (
      filePath: string,
    ) => Promise<{
      success: boolean;
      content?: string;
      size?: number;
      readBytes?: number;
      truncated?: boolean;
      error?: string;
    }>;
    saveFileCopy: (
      filePath: string,
    ) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    generateThumbnail: (
      filePath: string,
    ) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
    showMessageBox: (options: {
      message: string;
      type?: 'none' | 'info' | 'error' | 'question' | 'warning';
      title?: string;
    }) => Promise<{ response: number }>;
  };
  shell: {
    openPath: (filePath: string) => Promise<ShellActionResponse>;
    showItemInFolder: (filePath: string) => Promise<ShellActionResponse>;
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
    openHtmlInBrowser: (htmlContent: string) => Promise<{ success: boolean; error?: string }>;
    getAppsForFile: (
      filePath: string,
    ) => Promise<{
      success: boolean;
      apps: Array<{ name: string; path: string; isDefault: boolean; icon?: string }>;
      error?: string;
    }>;
    getBrowserApps: (options?: ShellGetBrowserAppsInput) => Promise<{
      success: boolean;
      apps: Array<{ name: string; path: string; isDefault: boolean; icon?: string }>;
      error?: string;
    }>;
    openPathWithApp: (
      filePath: string,
      appPath: string,
    ) => Promise<ShellActionResponse>;
    openUrlWithApp: (
      url: string,
      appPath: string,
    ) => Promise<ShellActionResponse>;
  };
  clipboard: {
    writeText: (text: string) => Promise<{ success: boolean; error?: string }>;
    writeImageFromFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    writeImageFromDataUrl: (dataUrl: string) => Promise<{ success: boolean; error?: string }>;
  };
  htmlShare: {
    createFromHtmlFile: (options: {
      sessionId: string;
      artifactId: string;
      filePath?: string;
      title: string;
      accessMode?: HtmlShareAccessMode;
      clientSourceKey?: string;
      expiresAt?: string;
    }) => Promise<HtmlShareResult>;
    // ── Legacy compat shims ────────────────────────────────────────────────
    // The enterprise server has no artifact-level create/update/by-file
    // endpoints; the live share flow (ArtifactFileShareController) bakes
    // content in the renderer and uses createFromBakedHtml / getBySource /
    // delete instead. These methods are retained only so the superseded
    // inline share dialog in ArtifactPanel.tsx (unreachable dead code) still
    // compiles. Remove them together with that dialog.
    createFromArtifactFile: (options: {
      sourceType?: HtmlShareSourceType;
      sessionId: string;
      artifactId: string;
      filePath?: string;
      title: string;
      accessMode?: HtmlShareAccessMode;
      fileName?: string;
      content?: string;
      remoteUrl?: string;
    }) => Promise<HtmlShareResult>;
    updateFromHtmlFile: (options: {
      shareId: string;
      sessionId: string;
      artifactId: string;
      filePath?: string;
      title?: string;
      currentStatus?: HtmlShareStatus;
      accessMode?: HtmlShareAccessMode;
    }) => Promise<HtmlShareResult>;
    updateFromArtifactFile: (options: {
      sourceType?: HtmlShareSourceType;
      shareId: string;
      sessionId: string;
      artifactId: string;
      filePath?: string;
      title?: string;
      currentStatus?: HtmlShareStatus;
      accessMode?: HtmlShareAccessMode;
      fileName?: string;
      content?: string;
      remoteUrl?: string;
    }) => Promise<HtmlShareResult>;
    getByHtmlFile: (options: {
      sessionId?: string;
      artifactId?: string;
      filePath?: string;
    }) => Promise<{ success: boolean; share?: HtmlShareResult; error?: string; code?: number }>;
    getByArtifactFile: (options: {
      sourceType?: HtmlShareSourceType;
      sessionId?: string;
      artifactId?: string;
      filePath?: string;
    }) => Promise<{ success: boolean; share?: HtmlShareResult; error?: string; code?: number }>;
    // ── End legacy compat shims ────────────────────────────────────────────
    createFromBakedHtml: (options: {
      html: string;
      sourceType: string;
      clientSourceKey: string;
      title: string;
      expiresAt?: string;
      accessMode?: HtmlShareAccessMode;
    }) => Promise<HtmlShareResult>;
    get: (shareId: string) => Promise<{ success: boolean; share?: HtmlShareResult; error?: string; code?: number }>;
    getBySource: (options: {
      sourceType: string;
      clientSourceKey: string;
    }) => Promise<{ success: boolean; share?: HtmlShareResult; error?: string; code?: number }>;
    updateStatus: (options: {
      shareId: string;
      status: 'live' | 'disabled';
    }) => Promise<HtmlShareResult>;
    updateAccessMode: (options: {
      shareId: string;
      accessMode: HtmlShareAccessMode;
    }) => Promise<HtmlShareResult>;
    getQuota: () => Promise<{
      success: boolean;
      data?: PublishingQuota;
      error?: string;
      code?: number;
    }>;
    delete: (shareId: string) => Promise<{ success: boolean; error?: string }>;
  };
  shareDeployment: {
    detectProjectCandidates: (
      options: ShareDeploymentDetectCandidatesInput,
    ) => Promise<ShareDeploymentDetectCandidatesResult>;
    analyzeProjectDirectory: (
      options: ShareDeploymentAnalyzeProjectInput,
    ) => Promise<ShareDeploymentProjectAnalysis>;
    selectPersistencePath: (
      options: ShareDeploymentSelectPersistencePathInput,
    ) => Promise<ShareDeploymentSelectPersistencePathResult>;
    createNodeDeployment: (
      options: ShareDeploymentCreateNodeInput,
    ) => Promise<ShareDeploymentResult>;
    get: (deploymentId: string) => Promise<ShareDeploymentResult>;
    getByLocalService: (options: ShareDeploymentGetByLocalServiceInput) => Promise<ShareDeploymentResult>;
    getPersistence: (deploymentId: string) => Promise<ShareDeploymentPersistenceInfoResult>;
    downloadPersistenceArchive: (
      options: ShareDeploymentDownloadPersistenceInput,
    ) => Promise<ShareDeploymentDownloadPersistenceResult>;
  };
  sites: {
    list: (options?: SiteListOptions) => Promise<SiteResult<SiteListData>>;
    get: (shareId: string) => Promise<SiteResult<SiteDetail>>;
    updateTitle: (input: SiteUpdateTitleInput) => Promise<SiteResult<SiteDetail>>;
    updateAccessMode: (input: SiteUpdateAccessModeInput) => Promise<SiteResult<SiteDetail>>;
    updateAccessStatus: (input: SiteUpdateAccessStatusInput) => Promise<SiteResult<SiteDetail>>;
    delete: (shareId: string) => Promise<SiteResult<null>>;
    getAnalytics: (
      shareId: string,
      options?: SiteAnalyticsOptions,
    ) => Promise<SiteResult<SiteAnalytics>>;
    getDeploymentQuota: (
      options?: SiteDeploymentQuotaOptions,
    ) => Promise<SiteResult<SiteDeploymentQuota>>;
    createQuotaReservation: (
      input: SiteQuotaReservationInput,
    ) => Promise<SiteResult<SiteQuotaReservation>>;
    releaseQuotaReservation: (reservationId: string) => Promise<SiteResult<null>>;
  };
  library: {
    listLocal: (
      options?: LibraryLocalListOptions,
    ) => Promise<LibraryResult<LibraryLocalListData>>;
    listCloud: (
      options?: LibraryCloudListOptions,
    ) => Promise<LibraryResult<LibraryCloudListData>>;
    getLocalItems: (
      input: LibraryGetLocalItemsInput,
    ) => Promise<LibraryResult<LibraryGetLocalItemsData>>;
    getLocalDetail: (itemId: string) => Promise<LibraryResult<LibraryLocalDetailData>>;
    recordCandidates: (
      candidates: LibraryArtifactCandidate[],
    ) => Promise<LibraryResult<LibraryRecordCandidatesData>>;
    addLocalFiles: (
      filePaths: string[],
    ) => Promise<LibraryResult<LibraryAddLocalFilesData>>;
    setFavorite: (
      input: LibraryFavoriteInput,
    ) => Promise<LibraryResult<{ favorite: boolean }>>;
    openLocal: (itemId: string) => Promise<LibraryResult<null>>;
    revealLocal: (itemId: string) => Promise<LibraryResult<null>>;
    repairIndex: () => Promise<LibraryResult<LibraryIndexStatus>>;
    getIndexStatus: () => Promise<LibraryResult<LibraryIndexStatus>>;
    getBackfillState: () => Promise<LibraryResult<LibraryBackfillState>>;
    setBackfillState: (
      state: LibraryBackfillState,
    ) => Promise<LibraryResult<LibraryBackfillState>>;
    onChanged: (callback: (payload: LibraryChangedPayload) => void) => () => void;
  };
  asr: {
    createRealtimeSession: (options: AsrRealtimeSessionRequest) => Promise<AsrRealtimeSessionResult>;
  };
  artifact: {
    watchFile: (filePath: string) => Promise<void>;
    unwatchFile: (filePath: string) => Promise<void>;
    onFileChanged: (callback: (data: { filePath: string }) => void) => () => void;
    createPreviewSession: (
      filePath: string,
    ) => Promise<{ success: boolean; sessionId?: string; url?: string; error?: string }>;
    createOfficePreviewSession: (
      filePath: string,
    ) => Promise<{ success: boolean; sessionId?: string; url?: string; error?: string }>;
    destroyPreviewSession: (sessionId: string) => Promise<{ success: boolean }>;
    clearBrowserCookies: () => Promise<{ success: boolean; error?: string }>;
    clearBrowserCache: () => Promise<{ success: boolean; error?: string }>;
    saveBrowserAnnotationAsset: (input: {
      draftKey: string;
      batchId: string;
      annotationId: string;
      imageDataUrl: string;
      viewportWidth: number;
      viewportHeight: number;
      targetRect?: BrowserAnnotationRect;
      markerViewportPoint?: { x: number; y: number };
      compact?: boolean;
    }) => Promise<{ success: boolean; asset?: BrowserAnnotationScreenshotRef; error?: string }>;
    readBrowserAnnotationAsset: (input: {
      draftKey: string;
      batchId: string;
      annotationId: string;
      assetId: string;
    }) => Promise<{ success: boolean; dataUrl?: string; byteSize?: number; error?: string }>;
    deleteBrowserAnnotationAsset: (input: {
      draftKey: string;
      batchId: string;
      annotationId: string;
      assetId: string;
    }) => Promise<{ success: boolean; error?: string }>;
    deleteBrowserAnnotationBatchAssets: (input: {
      draftKey: string;
      batchId: string;
    }) => Promise<{ success: boolean; error?: string }>;
    listLocalWebServices: (options?: ListLocalWebServicesOptions) => Promise<LocalWebService[]>;
  };
  autoLaunch: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; enabled?: boolean; error?: string; errorCode?: string }>;
  };
  preventSleep: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  appInfo: {
    getVersion: () => Promise<string>;
    getSystemLocale: () => Promise<string>;
    getKeyfromAttribution: () => Promise<{
      firstKeyfrom: string;
      latestKeyfrom: string;
      updatedAt: number;
    }>;
    relaunch: () => Promise<void>;
    openSystemNotificationSettings: () => Promise<{ success: boolean; error?: string }>;
  };
  appUpdate: {
    getState: () => Promise<AppUpdateRuntimeState>;
    checkNow: (options?: {
      manual?: boolean;
      userId?: string | null;
    }) => Promise<AppUpdateCheckResult>;
    retryDownload: () => Promise<{ success: boolean; state: AppUpdateRuntimeState }>;
    cancelDownload: () => Promise<{ success: boolean; state: AppUpdateRuntimeState }>;
    installReady: () => Promise<{ success: boolean; state: AppUpdateRuntimeState; error?: string }>;
    getCompletedUpdate: () => Promise<{ version: string | null }>;
    onStateChanged: (callback: (data: AppUpdateRuntimeState) => void) => () => void;
  };
  log: {
    getPath: () => Promise<string>;
    openFolder: () => Promise<void>;
    exportZip: () => Promise<{
      success: boolean;
      canceled?: boolean;
      path?: string;
      missingEntries?: string[];
      error?: string;
    }>;
    fromRenderer: (level: string, tag: string, message: string) => void;
  };
  plugins: {
    list: () => Promise<{
      success: boolean;
      plugins?: Array<{
        pluginId: string;
        version?: string;
        description?: string;
        source: 'npm' | 'clawhub' | 'git' | 'local' | 'bundled' | 'openclaw';
        enabled: boolean;
        canUninstall: boolean;
        hasConfig: boolean;
      }>;
      error?: string;
    }>;
    install: (params: {
      source: 'npm' | 'clawhub' | 'git' | 'local';
      spec: string;
      registry?: string;
      version?: string;
    }) => Promise<{ ok: boolean; pluginId?: string; version?: string; error?: string }>;
    uninstall: (pluginId: string) => Promise<{ ok: boolean; error?: string }>;
    setEnabled: (pluginId: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
    getConfigSchema: (pluginId: string) => Promise<{
      success: boolean;
      schema?: {
        configSchema: Record<string, unknown>;
        uiHints: Record<
          string,
          {
            label?: string;
            help?: string;
            sensitive?: boolean;
            advanced?: boolean;
            placeholder?: string;
            order?: number;
          }
        >;
      } | null;
      config?: Record<string, unknown> | null;
      error?: string;
    }>;
    saveConfig: (
      pluginId: string,
      config: Record<string, unknown>,
    ) => Promise<{ ok: boolean; error?: string }>;
    batchSave: (changes: {
      toggles?: Array<{ pluginId: string; enabled: boolean }>;
      configs?: Array<{ pluginId: string; config: Record<string, unknown> }>;
    }) => Promise<{ ok: boolean; error?: string }>;
    detect: () => Promise<{ plugins: string[]; error?: string }>;
    sync: () => Promise<{ synced: string[]; error?: string }>;
    checkUpdates: (pluginIds?: string[]) => Promise<{
      success: boolean;
      updates?: Array<{
        pluginId: string;
        currentVersion: string | null;
        latestVersion: string | null;
        hasUpdate: boolean;
        error?: string;
      }>;
      error?: string;
    }>;
    update: (pluginId: string) => Promise<{ ok: boolean; version?: string; error?: string }>;
    onInstallLog: (callback: (line: string) => void) => () => void;
  };
  im: {
    getConfig: () => Promise<{ success: boolean; config?: IMGatewayConfig; error?: string }>;
    setConfig: (
      config: Partial<IMGatewayConfig>,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => Promise<{ success: boolean; error?: string }>;
    syncConfig: () => Promise<{ success: boolean; skipped?: boolean; error?: string }>;
    startGateway: (platform: Platform) => Promise<{ success: boolean; error?: string }>;
    stopGateway: (platform: Platform) => Promise<{ success: boolean; error?: string }>;
    testGateway: (
      platform: Platform,
      configOverride?: Partial<IMGatewayConfig>,
    ) => Promise<{ success: boolean; result?: IMConnectivityTestResult; error?: string }>;
    getStatus: () => Promise<{ success: boolean; status?: IMGatewayStatus; error?: string }>;
    getLocalIp: () => Promise<string>;
    getOpenClawConfigSchema: () => Promise<{
      success: boolean;
      result?: {
        schema: Record<string, unknown>;
        uiHints: Record<string, Record<string, unknown>>;
      };
      error?: string;
    }>;
    weixinQrLoginStart: () => Promise<{
      success: boolean;
      qrDataUrl?: string;
      message: string;
      sessionKey?: string;
    }>;
    weixinQrLoginWait: (sessionKey?: string) => Promise<{
      success: boolean;
      connected: boolean;
      message: string;
      accountId?: string;
      alreadyConnected?: boolean;
    }>;

    // POPO QR login
    popoQrLoginStart: () => Promise<{
      success: boolean;
      qrUrl?: string;
      taskToken?: string;
      timeoutMs?: number;
      message?: string;
    }>;
    popoQrLoginPoll: (taskToken: string) => Promise<{
      success: boolean;
      appKey?: string;
      appSecret?: string;
      aesKey?: string;
      message: string;
    }>;

    // POPO Multi-Instance
    addPopoInstance: (
      name: string,
    ) => Promise<{
      success: boolean;
      instance?: import('./im').PopoInstanceConfig;
      error?: string;
    }>;
    deletePopoInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setPopoInstanceConfig: (
      instanceId: string,
      config: Record<string, unknown>,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => Promise<{ success: boolean; error?: string }>;

    listPairingRequests: (platform: string) => Promise<{
      success: boolean;
      requests: Array<{
        id: string;
        code: string;
        createdAt: string;
        lastSeenAt: string;
        meta?: Record<string, string>;
      }>;
      allowFrom: string[];
      error?: string;
    }>;
    approvePairingCode: (
      platform: string,
      code: string,
    ) => Promise<{ success: boolean; error?: string }>;
    rejectPairingRequest: (
      platform: string,
      code: string,
    ) => Promise<{ success: boolean; error?: string }>;
    addQQInstance: (
      name: string,
    ) => Promise<{ success: boolean; instance?: QQInstanceConfig; error?: string }>;
    deleteQQInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setQQInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => Promise<{ success: boolean; error?: string }>;
    addFeishuInstance: (
      name: string,
    ) => Promise<{ success: boolean; instance?: FeishuInstanceConfig; error?: string }>;
    deleteFeishuInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setFeishuInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => Promise<{ success: boolean; error?: string }>;
    addDingTalkInstance: (
      name: string,
    ) => Promise<{ success: boolean; instance?: DingTalkInstanceConfig; error?: string }>;
    deleteDingTalkInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setDingTalkInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => Promise<{ success: boolean; error?: string }>;
    addEmailInstance: (
      name: string,
    ) => Promise<{ success: boolean; instance?: EmailInstanceConfig; error?: string }>;
    deleteEmailInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setEmailInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => Promise<{ success: boolean; error?: string }>;
    addWecomInstance: (
      name: string,
    ) => Promise<{ success: boolean; instance?: WecomInstanceConfig; error?: string }>;
    deleteWecomInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setWecomInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => Promise<{ success: boolean; error?: string }>;
    addTelegramInstance: (
      name: string,
    ) => Promise<{ success: boolean; instance?: TelegramInstanceConfig; error?: string }>;
    deleteTelegramInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setTelegramInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => Promise<{ success: boolean; error?: string }>;
    addDiscordInstance: (
      name: string,
    ) => Promise<{ success: boolean; instance?: DiscordInstanceConfig; error?: string }>;
    deleteDiscordInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
    setDiscordInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => Promise<{ success: boolean; error?: string }>;
    onStatusChange: (callback: (status: IMGatewayStatus) => void) => () => void;
    onMessageReceived: (callback: (message: IMMessage) => void) => () => void;
  };
  scheduledTasks: {
    list: () => Promise<{
      success: boolean;
      ready?: boolean;
      tasks?: import('../../scheduledTask/types').ScheduledTask[];
      error?: string;
    }>;
    get: (id: string) => Promise<{
      success: boolean;
      task?: import('../../scheduledTask/types').ScheduledTask;
      error?: string;
    }>;
    create: (input: import('../../scheduledTask/types').ScheduledTaskInput) => Promise<{
      success: boolean;
      task?: import('../../scheduledTask/types').ScheduledTask;
      error?: string;
    }>;
    update: (
      id: string,
      input: Partial<import('../../scheduledTask/types').ScheduledTaskInput>,
    ) => Promise<{
      success: boolean;
      task?: import('../../scheduledTask/types').ScheduledTask;
      error?: string;
    }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    toggle: (
      id: string,
      enabled: boolean,
    ) => Promise<{
      success: boolean;
      task?: import('../../scheduledTask/types').ScheduledTask;
      warning?: string;
      error?: string;
    }>;
    runManually: (id: string) => Promise<{ success: boolean; error?: string }>;
    stop: (id: string) => Promise<{ success: boolean; error?: string }>;
    listRuns: (
      taskId: string,
      limit?: number,
      offset?: number,
      filter?: import('../../scheduledTask/types').RunFilter,
    ) => Promise<{
      success: boolean;
      runs?: import('../../scheduledTask/types').ScheduledTaskRun[];
      error?: string;
    }>;
    countRuns: (taskId: string) => Promise<{ success: boolean; count?: number; error?: string }>;
    listAllRuns: (
      limit?: number,
      offset?: number,
      filter?: import('../../scheduledTask/types').RunFilter,
    ) => Promise<{
      success: boolean;
      ready?: boolean;
      runs?: import('../../scheduledTask/types').ScheduledTaskRunWithName[];
      error?: string;
    }>;
    resolveSession: (
      input: string | { sessionId?: string | null; sessionKey?: string | null },
    ) => Promise<{
      success: boolean;
      session?: import('./cowork').CoworkSession | null;
      error?: string;
    }>;
    listChannels: () => Promise<{
      success: boolean;
      channels?: import('../../scheduledTask/types').ScheduledTaskChannelOption[];
      error?: string;
    }>;
    listChannelConversations?: (
      channel: string,
      accountId?: string,
      filterAccountId?: string,
    ) => Promise<{
      success: boolean;
      conversations?: import('../../scheduledTask/types').ScheduledTaskConversationOption[];
      error?: string;
    }>;
    onStatusUpdate: (
      callback: (data: import('../../scheduledTask/types').ScheduledTaskStatusEvent) => void,
    ) => () => void;
    onRunUpdate: (
      callback: (data: import('../../scheduledTask/types').ScheduledTaskRunEvent) => void,
    ) => () => void;
    onRefresh: (callback: () => void) => () => void;
  };
  permissions: {
    checkCalendar: () => Promise<{
      success: boolean;
      status?: string;
      error?: string;
      autoRequested?: boolean;
    }>;
    requestCalendar: () => Promise<{
      success: boolean;
      granted?: boolean;
      status?: string;
      error?: string;
    }>;
  };
  auth: {
    getUser: () => Promise<{
      success: boolean;
      user?: UserProfile;
      quota?: UserQuota;
      enterpriseContext?: EnterpriseAccountContext | null;
      status?: AuthSessionStatus;
      hasCredentials?: boolean;
      cachedUser?: UserProfile | null;
      error?: string;
    }>;
    getQuota: () => Promise<{
      success: boolean;
      quota?: UserQuota;
      enterpriseContext?: EnterpriseAccountContext | null;
      error?: string;
    }>;
    getAccessToken: () => Promise<string | null>;
    logout: () => Promise<void>;
    onQuotaChanged: (callback: () => void) => () => void;
    onSessionChanged: (callback: (event: AuthSessionChangedEvent) => void) => () => void;
    onLifecycleEvent: (callback: (event: AuthLifecycleEvent) => void) => () => void;
  };
  media: {
    getModels: (type: 'image' | 'video') => Promise<{ success: boolean; models?: Array<{ modelId: string; displayName: string; provider: string; mediaType: string; generationTimeout: number; pricing: Record<string, unknown> }>; error?: string }>;
    getTaskStatus: (taskId: number, type: 'image' | 'video') => Promise<{ success: boolean; task?: Record<string, unknown>; error?: string }>;
  };
  enterprise: {
    getConfig: () => Promise<{
      success: boolean;
      config: {
        ui?: Record<string, 'hide' | 'disable' | 'readonly'>;
        disableUpdate?: boolean;
        version: string;
        name: string;
      } | null;
      error?: string;
    }>;
  };
  enterpriseAccount: {
    getContext: () => Promise<EnterpriseAccountContextResult>;
    getIdentities: () => Promise<EnterpriseAccountIdentitiesResult>;
    requestQuotaIncrease: (
      enterpriseId: number,
      requestType: EnterpriseQuotaRequestType,
    ) => Promise<EnterpriseQuotaRequestResult>;
    onContextInvalidated: (callback: () => void) => () => void;
  };
  enterpriseMt: {
    login: (args: {
      orgId: string;
      username: string;
      password: string;
    }) => Promise<{ ok: true } | { ok: false; error: string }>;
    logout: () => Promise<void>;
    listOrgs: () => Promise<{ orgs: { id: string; name: string }[] }>;
    getMe: () => Promise<unknown>;
    updateMe: (displayName: string) => Promise<unknown>;
    changePassword: (args: {
      currentPassword: string;
      newPassword: string;
    }) => Promise<{ ok: true } | { ok: false; error: string }>;
    getModels: () => Promise<unknown[]>;
    getPolicies: (type: 'mcp' | 'skill') => Promise<unknown[]>;
    postAudit: (events: unknown[]) => Promise<void>;
    getUsageToday: () => Promise<unknown>;
    getBootstrapStatus: () => Promise<{ configured: boolean; url: string | null }>;
    getStoredUrl: () => Promise<{ url: string | null }>;
    verifyUrl: (url: string) => Promise<{ ok: boolean; error?: string }>;
    saveUrl: (url: string) => Promise<{ ok: boolean; status?: { configured: boolean; url: string | null }; error?: string }>;
    setUrl: (url: string) => Promise<{ configured: boolean; url: string | null }>;
    setLastSelectedModelId: (id: string) => Promise<void>;
    quit: () => Promise<void>;
    onSessionRevoked: (callback: () => void) => () => void;
    ssoProviders: (orgName: string) => Promise<{ providers: Array<{ id: string; name: string; provider_type: string; sort_order: number; logoUrl: string | null }> }>;
    ssoLogin: (args: { orgName: string; connectionId: string }) => Promise<{ ok: true; token: string } | { ok: false; error: string }>;
  };
  enterpriseModels: {
    list: () => Promise<EnterpriseModelView[]>;
    refresh: () => Promise<{ ok: boolean; refreshed?: number; error?: string }>;
    setActive: (modelId: string) => Promise<{ ok: boolean }>;
    getActive: () => Promise<{ modelId: string | null }>;
  };
  networkStatus: {
    send: (status: 'online' | 'offline') => void;
  };
  qwen: Record<string, never>;
  feishu: {
    install: {
      qrcode: (isLark: boolean) => Promise<{
        url: string;
        deviceCode: string;
        interval: number;
        expireIn: number;
      }>;
      poll: (deviceCode: string) => Promise<{
        done: boolean;
        appId?: string;
        appSecret?: string;
        domain?: string;
        error?: string;
      }>;
      verify: (
        appId: string,
        appSecret: string,
      ) => Promise<{
        success: boolean;
        error?: string;
      }>;
    };
  };
  dingtalk: {
    install: {
      qrcode: () => Promise<{
        url: string;
        deviceCode: string;
        interval: number;
        expireIn: number;
      }>;
      poll: (deviceCode: string) => Promise<{
        done: boolean;
        clientId?: string;
        clientSecret?: string;
        error?: string;
      }>;
      verify: (
        clientId: string,
        clientSecret: string,
      ) => Promise<{
        success: boolean;
        error?: string;
      }>;
    };
  };
  githubCopilot: {
    requestDeviceCode: () => Promise<{
      userCode: string;
      verificationUri: string;
      deviceCode: string;
      interval: number;
      expiresIn: number;
    }>;
    pollForToken: (
      deviceCode: string,
      interval: number,
      expiresIn: number,
    ) => Promise<{
      success: boolean;
      token?: string;
      githubUser?: string;
      baseUrl?: string;
      error?: string;
    }>;
    cancelPolling: () => Promise<void>;
    signOut: () => Promise<void>;
    refreshToken: () => Promise<{
      success: boolean;
      token?: string;
      baseUrl?: string;
      error?: string;
    }>;
    onTokenUpdated: (callback: (data: { token: string; baseUrl: string }) => void) => () => void;
  };
  openaiCodexOAuth: {
    start: () => Promise<
      | { success: true; email: string | null; accountId: string | null; expiresAt: number }
      | { success: false; error: string }
    >;
    cancel: () => Promise<void>;
    logout: () => Promise<void>;
    status: () => Promise<
      | { loggedIn: true; email: string | null; accountId: string | null; expiresAt: number }
      | { loggedIn: false }
    >;
  };
  xaiOAuth: {
    start: () => Promise<
      | { success: true; email: string | null; flow: 'browser' | 'device-code' }
      | { success: false; error: string }
    >;
    cancel: () => Promise<void>;
    logout: () => Promise<void>;
    status: () => Promise<{
      loggedIn: boolean;
      email?: string;
      displayName?: string;
      expiresAt?: number;
    }>;
    onDeviceCode: (
      callback: (info: {
        userCode: string;
        verificationUri: string;
        verificationUriComplete?: string;
        expiresInMs: number;
      }) => void,
    ) => () => void;
  };
}

// IM Gateway types
interface EmailInstanceConfig {
  instanceId: string;
  instanceName: string;
  enabled: boolean;
  transport: 'imap' | 'ws';
  email: string;
  password?: string;
  apiKey?: string;
  agentId: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  allowFrom?: string[];
  replyMode?: 'immediate' | 'accumulated' | 'complete';
  replyTo?: 'sender' | 'all';
  a2aEnabled?: boolean;
  a2aAgentDomains?: string[];
  a2aMaxPingPongTurns?: number;
}

interface EmailMultiInstanceConfig {
  instances: EmailInstanceConfig[];
}

interface EmailInstanceStatus {
  instanceId: string;
  instanceName: string;
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  email: string | null;
  transport: 'imap' | 'ws' | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface EmailMultiInstanceStatus {
  instances: EmailInstanceStatus[];
}

interface IMGatewayConfig {
  dingtalk: DingTalkMultiInstanceConfig;
  feishu: FeishuMultiInstanceConfig;
  telegram: TelegramMultiInstanceConfig;
  qq: QQMultiInstanceConfig;
  discord: DiscordMultiInstanceConfig;
  wecom: WecomMultiInstanceConfig;
  popo: PopoMultiInstanceConfig;
  weixin: WeixinOpenClawConfig;
  email: EmailMultiInstanceConfig;
  settings: IMSettings;
}

interface DingTalkOpenClawConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist';
  sessionTimeout: number;
  separateSessionByConversation: boolean;
  groupSessionScope: 'group' | 'group_sender';
  sharedMemoryAcrossConversations: boolean;
  gatewayBaseUrl: string;
  debug: boolean;
}

interface DingTalkInstanceConfig extends DingTalkOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

interface DingTalkInstanceStatus extends DingTalkGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface DingTalkMultiInstanceConfig {
  instances: DingTalkInstanceConfig[];
}

interface DingTalkMultiInstanceStatus {
  instances: DingTalkInstanceStatus[];
}

interface FeishuOpenClawGroupConfig {
  requireMention?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
}

interface FeishuOpenClawFooterConfig {
  status?: boolean;
  elapsed?: boolean;
}

interface FeishuOpenClawBlockStreamingCoalesceConfig {
  minChars?: number;
  maxChars?: number;
  idleMs?: number;
}

interface FeishuOpenClawConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark' | string;
  dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'allowlist' | 'open' | 'disabled';
  groupAllowFrom: string[];
  groups: Record<string, FeishuOpenClawGroupConfig>;
  historyLimit: number;
  streaming: boolean;
  replyMode: 'auto' | 'static' | 'streaming';
  blockStreaming: boolean;
  footer: FeishuOpenClawFooterConfig;
  blockStreamingCoalesce?: FeishuOpenClawBlockStreamingCoalesceConfig;
  mediaMaxMb: number;
  debug: boolean;
}

interface FeishuInstanceConfig extends FeishuOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

interface FeishuInstanceStatus extends FeishuGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface FeishuMultiInstanceConfig {
  instances: FeishuInstanceConfig[];
}

interface FeishuMultiInstanceStatus {
  instances: FeishuInstanceStatus[];
}

interface TelegramOpenClawGroupConfig {
  requireMention?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
}

interface TelegramOpenClawConfig {
  enabled: boolean;
  botToken: string;
  dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'allowlist' | 'open' | 'disabled';
  groupAllowFrom: string[];
  groups: Record<string, TelegramOpenClawGroupConfig>;
  historyLimit: number;
  replyToMode: 'off' | 'first' | 'all';
  linkPreview: boolean;
  streaming: 'off' | 'partial' | 'block' | 'progress';
  mediaMaxMb: number;
  proxy: string;
  webhookUrl: string;
  webhookSecret: string;
  debug: boolean;
}

interface TelegramInstanceConfig extends TelegramOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

interface TelegramInstanceStatus extends TelegramGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface TelegramMultiInstanceConfig {
  instances: TelegramInstanceConfig[];
}

interface TelegramMultiInstanceStatus {
  instances: TelegramInstanceStatus[];
}

interface DiscordOpenClawGuildConfig {
  requireMention?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
}

interface DiscordOpenClawConfig {
  enabled: boolean;
  botToken: string;
  dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'allowlist' | 'open' | 'disabled';
  groupAllowFrom: string[];
  guilds: Record<string, DiscordOpenClawGuildConfig>;
  historyLimit: number;
  streaming: 'off' | 'partial' | 'block' | 'progress';
  mediaMaxMb: number;
  proxy: string;
  debug: boolean;
}

interface QQConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  historyLimit: number;
  markdownSupport: boolean;
  imageServerBaseUrl: string;
  debug: boolean;
}

interface QQInstanceConfig extends QQConfig {
  instanceId: string;
  instanceName: string;
}

interface QQMultiInstanceConfig {
  instances: QQInstanceConfig[];
}

interface QQInstanceStatus extends QQGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface QQMultiInstanceStatus {
  instances: QQInstanceStatus[];
}

interface WecomConfig {
  enabled: boolean;
  botId: string;
  secret: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  sendThinkingMessage: boolean;
  debug: boolean;
}

interface WecomInstanceConfig extends WecomConfig {
  instanceId: string;
  instanceName: string;
}

interface WecomMultiInstanceConfig {
  instances: WecomInstanceConfig[];
}

interface WecomInstanceStatus extends WecomGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface WecomMultiInstanceStatus {
  instances: WecomInstanceStatus[];
}

interface PopoOpenClawConfig {
  enabled: boolean;
  connectionMode: 'websocket' | 'webhook';
  appKey: string;
  appSecret: string;
  token: string;
  aesKey: string;
  webhookBaseUrl: string;
  webhookPath: string;
  webhookPort: number;
  dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  textChunkLimit: number;
  richTextChunkLimit: number;
  debug: boolean;
}

interface PopoInstanceConfig extends PopoOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

interface PopoInstanceStatus extends PopoGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface PopoMultiInstanceConfig {
  instances: PopoInstanceConfig[];
}

interface PopoMultiInstanceStatus {
  instances: PopoInstanceStatus[];
}

interface WeixinOpenClawConfig {
  enabled: boolean;
  accountId: string;
  dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled';
  allowFrom: string[];
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  groupAllowFrom: string[];
  debug: boolean;
}

interface IMSettings {
  systemPrompt?: string;
  skillsEnabled: boolean;
}

interface IMGatewayStatus {
  dingtalk: DingTalkMultiInstanceStatus;
  feishu: FeishuMultiInstanceStatus;
  qq: QQMultiInstanceStatus;
  telegram: TelegramMultiInstanceStatus;
  discord: DiscordMultiInstanceStatus;
  wecom: WecomMultiInstanceStatus;
  popo: PopoMultiInstanceStatus;
  weixin: WeixinGatewayStatus;
  email: EmailMultiInstanceStatus;
}

type IMConnectivityVerdict = 'pass' | 'warn' | 'fail';

type IMConnectivityCheckLevel = 'pass' | 'info' | 'warn' | 'fail';

type IMConnectivityCheckCode =
  | 'missing_credentials'
  | 'auth_check'
  | 'gateway_running'
  | 'inbound_activity'
  | 'outbound_activity'
  | 'platform_last_error'
  | 'feishu_group_requires_mention'
  | 'feishu_event_subscription_required'
  | 'discord_group_requires_mention'
  | 'telegram_privacy_mode_hint'
  | 'dingtalk_bot_membership_hint'
  | 'qq_guild_mention_hint';

interface IMConnectivityCheck {
  code: IMConnectivityCheckCode;
  level: IMConnectivityCheckLevel;
  message: string;
  suggestion?: string;
}

interface IMConnectivityTestResult {
  platform: Platform;
  testedAt: number;
  verdict: IMConnectivityVerdict;
  checks: IMConnectivityCheck[];
}

interface DingTalkGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface FeishuGatewayStatus {
  connected: boolean;
  startedAt: string | null;
  botOpenId: string | null;
  error: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface TelegramGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface DiscordGatewayStatus {
  connected: boolean;
  starting: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface DiscordInstanceConfig extends DiscordOpenClawConfig {
  instanceId: string;
  instanceName: string;
}

interface DiscordInstanceStatus extends DiscordGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface DiscordMultiInstanceConfig {
  instances: DiscordInstanceConfig[];
}

interface DiscordMultiInstanceStatus {
  instances: DiscordInstanceStatus[];
}

interface QQGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface WecomGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botId: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface PopoGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface WeixinGatewayStatus {
  connected: boolean;
  accountId: string | null;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

interface IMMessage {
  platform: Platform;
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  chatType: 'direct' | 'group';
  timestamp: number;
}

interface EnterpriseModelView {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  endpoint: string | null;
  capabilities: {
    supports_image: boolean;
    supports_video: boolean;
    supports_thinking: boolean;
    context_window: number | null;
    max_tokens: number | null;
  };
  quotaPerDay: number | null;
}

declare global {
  interface Window {
    electron: IElectronAPI;
  }
}

export {};
