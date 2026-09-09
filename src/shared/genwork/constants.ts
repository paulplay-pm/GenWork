/**
 * Sentinel sessionId for permission requests that arrive without a resolvable
 * OpenClaw session key (e.g. AskUserQuestion callbacks missing sessionKey).
 * The renderer must surface these in whichever session is currently open —
 * they can never match a real session id.
 */
export const SESSION_AGNOSTIC_PERMISSION_SESSION_ID = '__askuser__';

/**
 * Tool name carried by AskUserQuestion requests when they are surfaced through
 * the permission-request channel. Used to classify "waiting for input"
 * requests apart from regular approval requests.
 */
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

/** Default page size for session list pagination. */
export const GENWORK_SESSION_PAGE_SIZE = 50;

/** Default page size for message history pagination. */
export const GENWORK_MESSAGE_PAGE_SIZE = 30;

/**
 * Number of rows from the full mixed-message timeline inspected per
 * conversation-search request. Search pages intentionally use a separate,
 * bounded projection so tool/system payloads and message metadata never cross
 * the renderer IPC boundary.
 */
export const GENWORK_SEARCH_MESSAGE_PAGE_SIZE = 200;

/** Defensive upper bound for renderer-supplied conversation-search page sizes. */
export const GENWORK_SEARCH_MESSAGE_PAGE_MAX_SIZE = 500;

/** Maximum aggregate searchable UTF-8 content returned by one IPC page. */
export const GENWORK_SEARCH_MESSAGE_PAGE_MAX_CONTENT_BYTES = 16_777_216;

/** Maximum number of rows inspected from the complete mixed-message timeline. */
export const GENWORK_SEARCH_HISTORY_MAX_MIXED_ROWS = 100_000;

/** Maximum searchable content retained by the renderer, measured in UTF-16 code units. */
export const GENWORK_SEARCH_HISTORY_MAX_CONTENT_CODE_UNITS = 16_777_216;

/** Maximum searchable content retained for one message, measured in UTF-16 code units. */
export const GENWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS = 1_048_576;

/**
 * Per-working-directory scratch directory for intermediate files (model
 * helper scripts, pasted attachments, drafts). Swept by the genwork temp
 * janitor; user-facing deliverables must not live here.
 */
export const GENWORK_TEMP_DIR_NAME = '.genwork-temp';

/**
 * Subdirectory of the genwork temp dir holding pasted/manual attachments.
 * Attachment originals are referenced by message metadata (re-edit restores
 * them), so the janitor never deletes this subtree.
 */
export const GENWORK_TEMP_ATTACHMENTS_DIR_NAME = 'attachments';

export const GenWorkIpcChannel = {
  CancelMediaTask: 'genwork:media:cancel',
  GetMediaModels: 'media:getModels',
  MediaStatusPollUpdate: 'genwork:media:statusPollUpdate',
  ForkSession: 'genwork:session:fork',
  StopSession: 'genwork:session:stop',
  SubTaskHistory: 'genwork:subTask:history',
  SubagentList: 'genwork:subagent:list',
  SubagentListByAgent: 'genwork:subagent:listByAgent',
  SubagentDelete: 'genwork:subagent:delete',
  MarkSessionViewed: 'genwork:session:markViewed',
  SetActiveSession: 'genwork:session:setActive',
  ExportSessionDiagnostics: 'genwork:session:exportDiagnostics',
  GetSessionMessageRailIndex: 'genwork:session:getMessageRailIndex',
  GetSessionSearchMessages: 'genwork:session:getSearchMessages',
  OpenSessionFromNotification: 'genwork:session:openFromNotification',
  OpenSessionFromNotificationReady: 'genwork:session:openFromNotificationReady',
  GoalCommand: 'genwork:session:goalCommand',
  SubmitBtw: 'genwork:session:submitBtw',
  AbortBtw: 'genwork:session:abortBtw',
  SubmitSteer: 'genwork:session:submitSteer',
  SessionModelOverrideChanged: 'genwork:session:modelOverrideChanged',
  SessionsChanged: 'genwork:sessions:changed',
  StreamBtwResult: 'genwork:stream:btwResult',
  StreamGoal: 'genwork:stream:goal',
  MemoryReadRaw: 'genwork:memory:readRaw',
  MemoryWriteRaw: 'genwork:memory:writeRaw',
  BootstrapRead: 'genwork:bootstrap:read',
  BootstrapWrite: 'genwork:bootstrap:write',
  TempStorageUsage: 'genwork:tempStorage:usage',
  TempStorageClean: 'genwork:tempStorage:clean',
} as const;
export type GenWorkIpcChannel = typeof GenWorkIpcChannel[keyof typeof GenWorkIpcChannel];

export interface GenWorkSessionsChangedPayload {
  sessionIds: string[];
}

export const GenWorkForkMode = {
  None: 'none',
  Conversation: 'conversation',
  Worktree: 'worktree',
} as const;
export type GenWorkForkMode = typeof GenWorkForkMode[keyof typeof GenWorkForkMode];

export const GenWorkContextUsageSource = {
  Live: 'live',
  Cache: 'cache',
  Unavailable: 'unavailable',
} as const;
export type GenWorkContextUsageSource =
  typeof GenWorkContextUsageSource[keyof typeof GenWorkContextUsageSource];

export const GenWorkContextUsageFailureReason = {
  Timeout: 'timeout',
  GatewayError: 'gateway_error',
} as const;
export type GenWorkContextUsageFailureReason =
  typeof GenWorkContextUsageFailureReason[keyof typeof GenWorkContextUsageFailureReason];

export const GenWorkContextUsageRefreshMode = {
  Auto: 'auto',
  Manual: 'manual',
  PostRun: 'postRun',
} as const;
export type GenWorkContextUsageRefreshMode =
  typeof GenWorkContextUsageRefreshMode[keyof typeof GenWorkContextUsageRefreshMode];
