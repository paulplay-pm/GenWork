import type { CoworkBrowserAnnotationMessageBatch } from '../../shared/genwork/browserAnnotations';
import type {
  GenWorkContextUsageFailureReason,
  GenWorkContextUsageSource,
  GenWorkForkMode,
} from '../../shared/genwork/constants';
import type { CoworkErrorDetail } from '../../shared/genwork/errorDetail';
import type { CoworkGoal } from '../../shared/genwork/goal';
import type {
  CoworkImageAttachmentPayload,
  CoworkImageAttachmentPreview,
} from '../../shared/genwork/imageAttachments';
import type { CoworkSelectedTextSnippet } from '../../shared/genwork/selectedText';
import type {
  KitReference,
  ResolvedKitCapabilities,
} from '../../shared/kit/constants';
import type {
  OpenClawEngineErrorCode,
  OpenClawEnginePhase as SharedOpenClawEnginePhase,
  OpenClawGatewayRepairErrorCode,
} from '../../shared/openclawEngine/constants';
import type { Platform } from '../../shared/platform';
import type { ModelThinkingLevel } from '../../shared/providers/modelThinking';

// GenWork image attachment for vision-capable models
export type GenWorkImageAttachment = CoworkImageAttachmentPayload;

// GenWork session status
export const GenWorkSessionStatusValue = {
  Idle: 'idle',
  Running: 'running',
  Completed: 'completed',
  Error: 'error',
} as const;

export type GenWorkSessionStatus =
  typeof GenWorkSessionStatusValue[keyof typeof GenWorkSessionStatusValue];

// GenWork message types
export type GenWorkMessageType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';

// GenWork execution mode
export type GenWorkExecutionMode = 'auto' | 'local' | 'sandbox';
export type GenWorkAgentEngine = 'openclaw';

export const GenWorkCollaborationMode = {
  Default: 'default',
  Plan: 'plan',
} as const;

export type GenWorkCollaborationMode =
  typeof GenWorkCollaborationMode[keyof typeof GenWorkCollaborationMode];

export const OpenClawSessionKeepAlive = {
  OneDay: '1d',
  SevenDays: '7d',
  ThirtyDays: '30d',
  OneYear: '365d',
} as const;

export type OpenClawSessionKeepAlive =
  typeof OpenClawSessionKeepAlive[keyof typeof OpenClawSessionKeepAlive];

export interface OpenClawSessionPolicyConfig {
  keepAlive: OpenClawSessionKeepAlive;
}

// GenWork message metadata
export interface GenWorkMessageMetadata {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolUseId?: string | null;
  error?: string;
  errorDetail?: CoworkErrorDetail;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  isThinking?: boolean;
  skillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  imageAttachments?: GenWorkImageAttachment[];
  imageAttachmentPreviews?: CoworkImageAttachmentPreview[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  contextPercent?: number;
  model?: string;
  agentName?: string;
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
  goalSetting?: {
    action: 'start' | 'create' | 'set';
    objective: string;
  };
  localMediaAttachments?: Array<{
    localPath: string;
    mimeType?: string;
    name?: string;
  }>;
  [key: string]: unknown;
}

export interface GenWorkContextUsage {
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

export type GenWorkContextUsageResult =
  | {
      success: true;
      usage?: GenWorkContextUsage | null;
      source?: GenWorkContextUsageSource;
    }
  | {
      success: false;
      error?: string;
      reason?: GenWorkContextUsageFailureReason;
    };

// GenWork message
export interface GenWorkMessage {
  id: string;
  type: GenWorkMessageType;
  content: string;
  timestamp: number;
  metadata?: GenWorkMessageMetadata;
}

// GenWork session
export interface GenWorkSession {
  id: string;
  title: string;
  openclawSessionId: string | null;
  scheduledTaskId: string | null;
  status: GenWorkSessionStatus;
  pinned: boolean;
  pinOrder?: number | null;
  cwd: string;
  systemPrompt: string;
  modelOverride: string;
  thinkingLevel?: ModelThinkingLevel | '';
  executionMode: GenWorkExecutionMode;
  activeSkillIds: string[];
  activeKitIds?: string[];
  agentId: string;
  messages: GenWorkMessage[];
  /** Offset of the first loaded message in the full message history. 0 means loaded from the beginning. */
  messagesOffset: number;
  /** Total number of messages stored for this session. */
  totalMessages: number;
  parentSessionId?: string | null;
  forkedFromMessageId?: string | null;
  forkedAt?: number | null;
  forkMode?: GenWorkForkMode;
  forkWorkspacePath?: string | null;
  forkGitBranch?: string | null;
  forkGitBaseRef?: string | null;
  goal?: CoworkGoal | null;
  createdAt: number;
  updatedAt: number;
}

// GenWork configuration
export interface GenWorkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: GenWorkExecutionMode;
  agentEngine: GenWorkAgentEngine;
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
  dreamingEnabled: boolean;
  dreamingFrequency: string;
  dreamingModel: string;
  dreamingTimezone: string;
  openClawSessionPolicy: OpenClawSessionPolicyConfig;
}

/** Per-directory `.cowork-temp` preview entry shown in the clean confirmation dialog. */
export interface GenWorkTempDirPreview {
  cwd: string;
  tempDir: string;
  totalBytes: number;
  totalFiles: number;
  cleanableBytes: number;
  cleanableFiles: number;
  isActive: boolean;
  truncated: boolean;
}

export type GenWorkConfigUpdate = Partial<Pick<
  GenWorkConfig,
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
  | 'dreamingEnabled'
  | 'dreamingFrequency'
  | 'dreamingModel'
  | 'dreamingTimezone'
>>;

export interface GenWorkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: 'anthropic' | 'openai';
}

export type OpenClawEnginePhase = SharedOpenClawEnginePhase;

export interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  errorCode?: OpenClawEngineErrorCode;
  gatewayPort?: number | null;
  gatewayHttpUrl?: string | null;
  canRetry: boolean;
}

export interface OpenClawGatewayRepairResult {
  success: boolean;
  status?: OpenClawEngineStatus;
  originalPath?: string;
  backupPath?: string;
  error?: string;
  errorCode?: OpenClawGatewayRepairErrorCode;
  recoverable?: boolean;
}

export interface GenWorkUserMemoryEntry {
  id: string;
  text: string;
  section?: string;
}

export interface GenWorkMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

// GenWork pending permission request
export interface GenWorkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
}

export type GenWorkPermissionResult =
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

// GenWork permission response
export interface GenWorkPermissionResponse {
  requestId: string;
  result: GenWorkPermissionResult;
}

// Session summary for list display (without full messages)
export interface GenWorkSessionSummary {
  id: string;
  title: string;
  scheduledTaskId: string | null;
  status: GenWorkSessionStatus;
  pinned: boolean;
  pinOrder?: number | null;
  agentId?: string;
  imPlatform?: Platform | null;
  parentSessionId?: string | null;
  forkedAt?: number | null;
  forkMode?: GenWorkForkMode;
  goal?: CoworkGoal | null;
  createdAt: number;
  updatedAt: number;
}

export interface GenWorkForkSessionOptions {
  sessionId: string;
  forkedFromMessageId?: string | null;
  title?: string;
}

// Subagent session summary for sidebar display
export interface SubagentSessionSummary {
  id: string;
  agentId: string | null;
  task: string | null;
  label: string | null;
  sessionKey: string | null;
  childGenWorkSessionId?: string | null;
  parentSessionId: string;
  parentAgentId?: string | null;
  parentTitle?: string | null;
  parentUpdatedAt?: number | null;
  status: 'running' | 'done' | 'error';
  createdAt: number;
  endedAt: number | null;
}

// Start session options
export interface GenWorkStartOptions {
  prompt: string;
  cwd?: string;
  systemPrompt?: string;
  title?: string;
  activeSkillIds?: string[];
  runtimeSkillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  agentId?: string;
  modelOverride?: string;
  thinkingLevel?: ModelThinkingLevel;
  imageAttachments?: GenWorkImageAttachment[];
  mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string };
  mediaReferences?: import('./mediaGeneration').MediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
}

// Continue session options
export interface GenWorkContinueOptions {
  sessionId: string;
  prompt: string;
  systemPrompt?: string;
  activeSkillIds?: string[];
  runtimeSkillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  imageAttachments?: GenWorkImageAttachment[];
  mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string };
  mediaReferences?: import('./mediaGeneration').MediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
}

// IPC result types
export interface GenWorkSessionResult {
  success: boolean;
  session?: GenWorkSession;
  error?: string;
}

export interface GenWorkSessionListResult {
  success: boolean;
  sessions?: GenWorkSessionSummary[];
  /** Whether more sessions exist beyond the currently loaded set. */
  hasMore?: boolean;
  error?: string;
}

export interface GenWorkMessageListResult {
  success: boolean;
  messages?: GenWorkMessage[];
  /** Offset of the first returned message. */
  offset?: number;
  /** Total message count for the session. */
  total?: number;
  error?: string;
}

export interface GenWorkConfigResult {
  success: boolean;
  config?: GenWorkConfig;
  error?: string;
}

// ── Dreaming content display types ──────────────────────────────────

export interface DreamingPhaseInfo {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
}

export interface DreamingEntry {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalSignalCount: number;
  lightHits: number;
  remHits: number;
  phaseHitCount: number;
  promotedAt?: string;
  lastRecalledAt?: string;
}

export interface DreamingStatusData {
  enabled: boolean;
  timezone?: string;
  shortTermCount: number;
  groundedSignalCount: number;
  totalSignalCount: number;
  promotedToday: number;
  promotedTotal: number;
  shortTermEntries: DreamingEntry[];
  promotedEntries: DreamingEntry[];
  phases?: {
    light: DreamingPhaseInfo;
    deep: DreamingPhaseInfo;
    rem: DreamingPhaseInfo;
  };
}

export interface DreamDiaryData {
  found: boolean;
  path: string;
  content?: string;
  updatedAtMs?: number;
}

// Stream event types for IPC communication
export type GenWorkStreamEventType =
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'complete'
  | 'error';

export interface GenWorkStreamEvent {
  type: GenWorkStreamEventType;
  sessionId: string;
  data: {
    message?: GenWorkMessage;
    permission?: GenWorkPermissionRequest;
    error?: string;
    openclawSessionId?: string;
  };
}
