import Database from 'better-sqlite3';
import crypto from 'crypto';
import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { CoworkSystemMessageKind } from '../common/coworkSystemMessages';
import { AgentId, normalizeAgentAvatarIcon } from '../shared/agent';
import {
  GENWORK_MESSAGE_PAGE_SIZE,
  GENWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS,
  GENWORK_SEARCH_MESSAGE_PAGE_MAX_CONTENT_BYTES,
  GENWORK_SEARCH_MESSAGE_PAGE_MAX_SIZE,
  GENWORK_SEARCH_MESSAGE_PAGE_SIZE,
  GENWORK_SESSION_PAGE_SIZE,
  GenWorkForkMode,
  type GenWorkForkMode as GenWorkForkModeType,
} from '../shared/genwork/constants';
import type { CoworkErrorDetail } from '../shared/genwork/errorDetail';
import {
  type CoworkGoal,
  normalizeCoworkGoal,
} from '../shared/genwork/goal';
import { OpenClawCronRunMetadataKey } from '../shared/genwork/openclawCronSessionKey';
import {
  type CoworkMessageRailIndexItem,
  GENWORK_RAIL_TOOLTIP_PREVIEW_MAX_LENGTH,
  getCoworkRailPreview,
} from '../shared/genwork/rail';
import type {
  CoworkSearchMessage,
  CoworkSearchMessageCursor,
  CoworkSearchMessagePage,
} from '../shared/genwork/search';
import {
  type CoworkSelectedTextSnippet,
  CoworkSelectedTextSource,
} from '../shared/genwork/selectedText';
import type {
  KitReference,
  ResolvedKitCapabilities,
} from '../shared/kit/constants';
import {
  type Platform,
  PlatformRegistry,
} from '../shared/platform';
import {
  type ModelThinkingLevel,
  parseModelThinkingLevel,
} from '../shared/providers/modelThinking';
import {
  ContinuityCapsuleSource,
  type CoworkContinuityCapsule,
} from './libs/agentEngine/coworkContinuityCapsule';


// Default working directory for new users
const getDefaultWorkingDirectory = (): string => {
  return path.join(os.homedir(), 'genwork', 'project');
};

const TASK_WORKSPACE_CONTAINER_DIR = '.genwork-tasks';

const normalizeRecentWorkspacePath = (cwd: string): string => {
  const resolved = path.resolve(cwd);
  const marker = `${path.sep}${TASK_WORKSPACE_CONTAINER_DIR}${path.sep}`;
  const markerIndex = resolved.lastIndexOf(marker);
  if (markerIndex > 0) {
    return resolved.slice(0, markerIndex);
  }
  return resolved;
};

const DEFAULT_MEMORY_ENABLED = true;
const DEFAULT_MEMORY_IMPLICIT_UPDATE_ENABLED = true;
const DEFAULT_MEMORY_LLM_JUDGE_ENABLED = false;
export type GenWorkMemoryGuardLevel = 'strict' | 'standard' | 'relaxed';
const DEFAULT_MEMORY_GUARD_LEVEL: GenWorkMemoryGuardLevel = 'strict';
const DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS = 12;
const MIN_MEMORY_USER_MEMORIES_MAX_ITEMS = 1;
const MAX_MEMORY_USER_MEMORIES_MAX_ITEMS = 60;
const MEMORY_NEAR_DUPLICATE_MIN_SCORE = 0.82;
const MEMORY_PROCEDURAL_TEXT_RE =
  /(执行以下命令|run\s+(?:the\s+)?following\s+command|\b(?:cd|npm|pnpm|yarn|node|python|bash|sh|git|curl|wget)\b|\$[A-Z_][A-Z0-9_]*|&&|--[a-z0-9-]+|\/tmp\/|\.sh\b|\.bat\b|\.ps1\b)/i;
const MEMORY_ASSISTANT_STYLE_TEXT_RE = /^(?:使用|use)\s+[A-Za-z0-9._-]+\s*(?:技能|skill)/i;

const DEFAULT_EMBEDDING_ENABLED = false;
const DEFAULT_EMBEDDING_PROVIDER = 'openai';
const DEFAULT_EMBEDDING_MODEL = '';
const DEFAULT_EMBEDDING_LOCAL_MODEL_PATH = '';
const DEFAULT_EMBEDDING_VECTOR_WEIGHT = 0.7;
const DEFAULT_EMBEDDING_REMOTE_BASE_URL = '';
const DEFAULT_EMBEDDING_REMOTE_API_KEY = '';

const DEFAULT_DREAMING_ENABLED = false;
const DEFAULT_DREAMING_FREQUENCY = '0 3 * * *';
const DEFAULT_DREAMING_MODEL = '';
const DEFAULT_DREAMING_TIMEZONE = '';

// Regexes and helper inlined from the removed coworkMemoryExtractor module.
// Used only by shouldAutoDeleteMemoryText() during startup memory cleanup.
const CHINESE_QUESTION_PREFIX_RE = /^(?:请问|问下|问一下|是否|能否|可否|为什么|为何|怎么|如何|谁|什么|哪(?:里|儿|个)?|几|多少|要不要|会不会|是不是|能不能|可不可以|行不行|对不对|好不好)/u;
const ENGLISH_QUESTION_PREFIX_RE = /^(?:what|who|why|how|when|where|which|is|are|am|do|does|did|can|could|would|will|should)\b/i;
const QUESTION_INLINE_RE = /(是不是|能不能|可不可以|要不要|会不会|有没有|对不对|好不好)/i;
const QUESTION_SUFFIX_RE = /(吗|么|呢|嘛)\s*$/u;

function isQuestionLikeMemoryText(text: string): boolean {
  // This function has its own normalization (strips trailing punctuation)
  // that differs from normalizeMemoryText, so it cannot reuse that helper.
  const normalized = text.replace(/\s+/g, ' ').trim().replace(/[。！!]+$/g, '').trim();
  if (!normalized) return false;
  if (/[？?]\s*$/.test(normalized)) return true;
  if (CHINESE_QUESTION_PREFIX_RE.test(normalized)) return true;
  if (ENGLISH_QUESTION_PREFIX_RE.test(normalized)) return true;
  if (QUESTION_INLINE_RE.test(normalized)) return true;
  if (QUESTION_SUFFIX_RE.test(normalized)) return true;
  return false;
}

function normalizeMemoryGuardLevel(value: string | undefined): GenWorkMemoryGuardLevel {
  if (value === 'strict' || value === 'standard' || value === 'relaxed') return value;
  return DEFAULT_MEMORY_GUARD_LEVEL;
}

function parseBooleanConfig(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on')
    return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off')
    return false;
  return fallback;
}

function clampMemoryUserMemoriesMaxItems(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MEMORY_USER_MEMORIES_MAX_ITEMS;
  return Math.max(
    MIN_MEMORY_USER_MEMORIES_MAX_ITEMS,
    Math.min(MAX_MEMORY_USER_MEMORIES_MAX_ITEMS, Math.floor(value)),
  );
}

function parseEmbeddingVectorWeight(value: string | undefined): number {
  if (!value) return DEFAULT_EMBEDDING_VECTOR_WEIGHT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_EMBEDDING_VECTOR_WEIGHT;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeMemoryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeStringIdList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeAgentThinkingLevel(
  value: ModelThinkingLevel | '' | undefined,
): ModelThinkingLevel | '' {
  if (!value) return '';
  const parsed = parseModelThinkingLevel(value);
  if (!parsed) {
    throw new Error(`Invalid agent thinking level: ${String(value)}`);
  }
  return parsed;
}

function parseStringIdList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    return normalizeStringIdList(JSON.parse(value) as string[]);
  } catch {
    return [];
  }
}

function extractConversationSearchTerms(value: string): string[] {
  const normalized = normalizeMemoryText(value).toLowerCase();
  if (!normalized) return [];

  const terms: string[] = [];
  const seen = new Set<string>();
  const addTerm = (term: string): void => {
    const normalizedTerm = normalizeMemoryText(term).toLowerCase();
    if (!normalizedTerm) return;
    if (/^[a-z0-9]$/i.test(normalizedTerm)) return;
    if (seen.has(normalizedTerm)) return;
    seen.add(normalizedTerm);
    terms.push(normalizedTerm);
  };

  // Keep the full phrase and additionally match by per-token terms.
  addTerm(normalized);
  const tokens = normalized
    .split(/[\s,，、|/\\;；]+/g)
    .map(token => token.replace(/^['"`]+|['"`]+$/g, '').trim())
    .filter(Boolean);

  for (const token of tokens) {
    addTerm(token);
    if (terms.length >= 8) break;
  }

  return terms.slice(0, 8);
}

function normalizeMemoryMatchKey(value: string): string {
  return normalizeMemoryText(value)
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMemorySemanticKey(value: string): string {
  const key = normalizeMemoryMatchKey(value);
  if (!key) return '';
  return key
    .replace(/^(?:the user|user|i am|i m|i|my|me)\s+/i, '')
    .replace(/^(?:该用户|这个用户|用户|本人|我的|我们|咱们|咱|我|你的|你)\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTokenFrequencyMap(value: string): Map<string, number> {
  const tokens = value
    .split(/\s+/g)
    .map(token => token.trim())
    .filter(Boolean);
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) || 0) + 1);
  }
  return map;
}

function scoreTokenOverlap(left: string, right: string): number {
  const leftMap = buildTokenFrequencyMap(left);
  const rightMap = buildTokenFrequencyMap(right);
  if (leftMap.size === 0 || rightMap.size === 0) return 0;

  let leftCount = 0;
  let rightCount = 0;
  let intersection = 0;
  for (const count of leftMap.values()) leftCount += count;
  for (const count of rightMap.values()) rightCount += count;
  for (const [token, leftValue] of leftMap.entries()) {
    intersection += Math.min(leftValue, rightMap.get(token) || 0);
  }

  const denominator = Math.min(leftCount, rightCount);
  if (denominator <= 0) return 0;
  return intersection / denominator;
}

function buildCharacterBigramMap(value: string): Map<string, number> {
  const compact = value.replace(/\s+/g, '').trim();
  if (!compact) return new Map<string, number>();
  if (compact.length <= 1) return new Map<string, number>([[compact, 1]]);

  const map = new Map<string, number>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    map.set(gram, (map.get(gram) || 0) + 1);
  }
  return map;
}

function scoreCharacterBigramDice(left: string, right: string): number {
  const leftMap = buildCharacterBigramMap(left);
  const rightMap = buildCharacterBigramMap(right);
  if (leftMap.size === 0 || rightMap.size === 0) return 0;

  let leftCount = 0;
  let rightCount = 0;
  let intersection = 0;
  for (const count of leftMap.values()) leftCount += count;
  for (const count of rightMap.values()) rightCount += count;
  for (const [gram, leftValue] of leftMap.entries()) {
    intersection += Math.min(leftValue, rightMap.get(gram) || 0);
  }

  const denominator = leftCount + rightCount;
  if (denominator <= 0) return 0;
  return (2 * intersection) / denominator;
}

function scoreMemorySimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const compactLeft = left.replace(/\s+/g, '');
  const compactRight = right.replace(/\s+/g, '');
  if (compactLeft && compactLeft === compactRight) {
    return 1;
  }

  let phraseScore = 0;
  if (
    compactLeft &&
    compactRight &&
    (compactLeft.includes(compactRight) || compactRight.includes(compactLeft))
  ) {
    phraseScore =
      Math.min(compactLeft.length, compactRight.length) /
      Math.max(compactLeft.length, compactRight.length);
  }

  return Math.max(
    phraseScore,
    scoreTokenOverlap(left, right),
    scoreCharacterBigramDice(left, right),
  );
}

function scoreMemoryTextQuality(value: string): number {
  const normalized = normalizeMemoryText(value);
  if (!normalized) return 0;
  let score = normalized.length;
  if (/^(?:该用户|这个用户|用户)\s*/u.test(normalized)) {
    score -= 12;
  }
  if (/^(?:the user|user)\b/i.test(normalized)) {
    score -= 12;
  }
  if (/^(?:我|我的|我是|我有|我会|我喜欢|我偏好)/u.test(normalized)) {
    score += 4;
  }
  if (/^(?:i|i am|i'm|my)\b/i.test(normalized)) {
    score += 4;
  }
  return score;
}

function choosePreferredMemoryText(currentText: string, incomingText: string): string {
  const normalizedCurrent = truncate(normalizeMemoryText(currentText), 360);
  const normalizedIncoming = truncate(normalizeMemoryText(incomingText), 360);
  if (!normalizedCurrent) return normalizedIncoming;
  if (!normalizedIncoming) return normalizedCurrent;

  const currentScore = scoreMemoryTextQuality(normalizedCurrent);
  const incomingScore = scoreMemoryTextQuality(normalizedIncoming);
  if (incomingScore > currentScore + 1) return normalizedIncoming;
  if (currentScore > incomingScore + 1) return normalizedCurrent;
  return normalizedIncoming.length >= normalizedCurrent.length
    ? normalizedIncoming
    : normalizedCurrent;
}

function buildMemoryFingerprint(text: string): string {
  const key = normalizeMemoryMatchKey(text);
  return crypto.createHash('sha1').update(key).digest('hex');
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function parseTimeToMs(input?: string | null): number | null {
  if (!input) return null;
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp;
}

function normalizeMessageTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function shouldAutoDeleteMemoryText(text: string): boolean {
  const normalized = normalizeMemoryText(text);
  if (!normalized) return false;
  return (
    MEMORY_ASSISTANT_STYLE_TEXT_RE.test(normalized) ||
    MEMORY_PROCEDURAL_TEXT_RE.test(normalized) ||
    isQuestionLikeMemoryText(normalized)
  );
}

// Types mirroring src/types/genwork.ts for main process use
export type GenWorkSessionStatus = 'idle' | 'running' | 'completed' | 'error';
export type GenWorkMessageType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
export type GenWorkExecutionMode = 'auto' | 'local' | 'sandbox';
export type GenWorkAgentEngine = 'openclaw';

export type AgentSource = 'custom' | 'preset' | 'enterprise';

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  identity: string;
  aboutYou: string;
  model: string;
  thinkingLevel: ModelThinkingLevel | '';
  workingDirectory: string;
  icon: string;
  skillIds: string[];
  subagentAllowAgentIds: string[];
  serverSkillIds: string[];
  serverSubagentAllowAgentIds: string[];
  serverImChannels: string[];
  /** Resolved local skill ids for the server baseline (derived, not persisted). */
  serverSkillLocalIds?: string[];
  /** Server-baseline skill ids that are installed AND enabled locally (already shown in the skills grid; derived, not persisted). */
  serverSkillInstalledIds?: string[];
  /** Resolved local subagent ids for the server baseline (derived, not persisted). */
  serverSubagentLocalIds?: string[];
  enabled: boolean;
  pinned: boolean;
  pinOrder?: number | null;
  sortOrder?: number | null;
  isDefault: boolean;
  source: AgentSource;
  presetId: string;
  enterpriseAgentId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentRequest {
  id?: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  identity?: string;
  aboutYou?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel | '';
  workingDirectory?: string;
  icon?: string;
  skillIds?: string[];
  subagentAllowAgentIds?: string[];
  serverSkillIds?: string[];
  serverSubagentAllowAgentIds?: string[];
  serverImChannels?: string[];
  source?: AgentSource;
  presetId?: string;
  enterpriseAgentId?: string;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  systemPrompt?: string;
  identity?: string;
  aboutYou?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel | '';
  workingDirectory?: string;
  icon?: string;
  skillIds?: string[];
  subagentAllowAgentIds?: string[];
  serverSkillIds?: string[];
  serverSubagentAllowAgentIds?: string[];
  serverImChannels?: string[];
  enabled?: boolean;
  pinned?: boolean;
  sortOrder?: number | null;
}


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
  skillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
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
  localMediaAttachments?: Array<{
    localPath: string;
    mimeType?: string;
    name?: string;
  }>;
  [key: string]: unknown;
}

export interface GenWorkMessage {
  id: string;
  type: GenWorkMessageType;
  content: string;
  timestamp: number;
  metadata?: GenWorkMessageMetadata;
}

export interface GenWorkConversationReplacementEntry {
  role: 'user' | 'assistant';
  text: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

export interface GenWorkMessageReplacementEntry {
  type: GenWorkMessageType;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

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
  agentId: string;
  messages: GenWorkMessage[];
  /** Offset of the first loaded message in the full message history. */
  messagesOffset: number;
  /** Total number of messages stored for this session. */
  totalMessages: number;
  parentSessionId?: string | null;
  forkedFromMessageId?: string | null;
  forkedAt?: number | null;
  forkMode?: GenWorkForkModeType;
  forkWorkspacePath?: string | null;
  forkGitBranch?: string | null;
  forkGitBaseRef?: string | null;
  goal?: CoworkGoal | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertSubagentChildSessionOptions {
  id: string;
  parentSessionId: string;
  childSessionKey: string;
  agentId: string;
  title: string;
  task?: string | null;
  status?: GenWorkSessionStatus;
  createdAt?: number;
}

export interface GenWorkSessionSummary {
  id: string;
  title: string;
  scheduledTaskId: string | null;
  status: GenWorkSessionStatus;
  pinned: boolean;
  pinOrder?: number | null;
  agentId: string;
  imPlatform?: Platform | null;
  parentSessionId?: string | null;
  forkedAt?: number | null;
  forkMode?: GenWorkForkModeType;
  goal?: CoworkGoal | null;
  createdAt: number;
  updatedAt: number;
}

export type GenWorkUserMemoryStatus = 'created' | 'stale' | 'deleted';

export interface GenWorkUserMemory {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: GenWorkUserMemoryStatus;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface GenWorkUserMemorySource {
  id: string;
  memoryId: string;
  sessionId: string | null;
  messageId: string | null;
  role: 'user' | 'assistant' | 'tool' | 'system';
  isActive: boolean;
  createdAt: number;
}

export interface GenWorkUserMemorySourceInput {
  sessionId?: string;
  messageId?: string;
  role?: 'user' | 'assistant' | 'tool' | 'system';
}

export interface GenWorkUserMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

export interface GenWorkConversationSearchRecord {
  sessionId: string;
  title: string;
  updatedAt: number;
  url: string;
  human: string;
  assistant: string;
}

export interface GenWorkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: GenWorkExecutionMode;
  agentEngine: GenWorkAgentEngine;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: GenWorkMemoryGuardLevel;
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

export type PluginSource = 'npm' | 'clawhub' | 'git' | 'local' | 'openclaw';

export interface UserInstalledPlugin {
  pluginId: string;
  source: PluginSource;
  spec: string;
  registry?: string;
  version?: string;
  enabled: boolean;
  installedAt: number;
  config?: Record<string, unknown>;
}


let cachedDefaultSystemPrompt: string | null = null;

const getDefaultSystemPrompt = (): string => {
  if (cachedDefaultSystemPrompt !== null) {
    return cachedDefaultSystemPrompt;
  }
  try {
    const promptPath = path.join(app.getAppPath(), 'resources', 'SYSTEM_PROMPT.md');
    cachedDefaultSystemPrompt = fs.readFileSync(promptPath, 'utf-8');
  } catch {
    cachedDefaultSystemPrompt = '';
  }
  return cachedDefaultSystemPrompt;
};

interface GenWorkMessageRow {
  id: string;
  type: string;
  content: string;
  metadata: string | null;
  created_at: number;
  sequence: number | null;
}

interface CoworkContinuityCapsuleRow {
  session_id: string;
  version: number;
  revision: number;
  capsule_json: string;
  updated_at: number;
  last_source: string;
  last_compacted_at: number | null;
}

interface GenWorkForkSessionOptions {
  sourceSessionId: string;
  forkMode?: GenWorkForkModeType;
  forkedFromMessageId?: string | null;
  title?: string;
  cwdOverride?: string;
  workspacePath?: string | null;
  gitBranch?: string | null;
  gitBaseRef?: string | null;
  contextMessages?: GenWorkForkContextMessage[];
}

export interface GenWorkForkContextMessage {
  content: string;
  metadata: GenWorkMessageMetadata;
}

interface GenWorkForkBoundary {
  sequence: number | null;
  createdAt: number;
}

interface GenWorkUserMemoryRow {
  id: string;
  text: string;
  fingerprint: string;
  confidence: number;
  is_explicit: number;
  status: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

interface GenWorkSessionSummaryRow {
  id: string;
  title: string;
  scheduled_task_id: string | null;
  status: string;
  pinned: number | null;
  pin_order: number | null;
  agent_id: string | null;
  im_platform?: string | null;
  parent_session_id?: string | null;
  forked_at?: number | null;
  fork_mode?: string | null;
  goal_json?: string | null;
  created_at: number;
  updated_at: number;
}

interface GenWorkSessionSearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  agentId?: string;
}

export interface CreateGenWorkSessionOptions {
  scheduledTaskId?: string | null;
  thinkingLevel?: ModelThinkingLevel | '';
}

export class GenWorkStore {
  private db: Database.Database;
  private readonly knownIMPlatforms = new Set<string>(PlatformRegistry.platforms);

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureContinuityCapsuleTable();
  }

  private ensureContinuityCapsuleTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS genwork_session_capsules (
        session_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        capsule_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        last_source TEXT NOT NULL,
        last_compacted_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES genwork_sessions(id) ON DELETE CASCADE
      );
    `);
  }

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private mapConversationMessageRows(sessionId: string, rows: GenWorkMessageRow[]): GenWorkMessage[] {
    return rows.map(row => {
      let metadata: Record<string, unknown> | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          console.warn(
            `[GenWorkStore] corrupt metadata detected for message ${row.id} in session ${sessionId}, discarding metadata`,
          );
        }
      }
      return {
        id: row.id,
        type: row.type as GenWorkMessageType,
        content: row.content,
        timestamp: row.created_at,
        metadata,
      };
    });
  }

  private escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (match) => `\\${match}`);
  }

  private hasIMSessionMappingsTable(): boolean {
    const row = this.db
      .prepare("SELECT 1 AS exists_flag FROM sqlite_master WHERE type = 'table' AND name = 'im_session_mappings'")
      .get() as { exists_flag?: number } | undefined;
    return !!row;
  }

  private getSessionSummaryColumns(sessionAlias = 's'): string {
    const imPlatformColumn = this.hasIMSessionMappingsTable()
      ? `(
          SELECT m.platform
          FROM im_session_mappings m
          WHERE m.cowork_session_id = ${sessionAlias}.id
          ORDER BY m.last_active_at DESC
          LIMIT 1
        ) AS im_platform`
      : 'NULL AS im_platform';

    return `${sessionAlias}.id, ${sessionAlias}.title, ${sessionAlias}.scheduled_task_id,
      ${sessionAlias}.status, ${sessionAlias}.pinned, ${sessionAlias}.pin_order,
      ${sessionAlias}.agent_id, ${imPlatformColumn},
      ${sessionAlias}.parent_session_id, ${sessionAlias}.forked_at, ${sessionAlias}.fork_mode,
      ${sessionAlias}.goal_json,
      ${sessionAlias}.created_at, ${sessionAlias}.updated_at`;
  }

  private normalizeIMPlatform(value: string | null | undefined): Platform | null {
    const platform = value?.trim();
    if (!platform) return null;
    if (this.knownIMPlatforms.has(platform)) return platform as Platform;
    return PlatformRegistry.platformOfChannel(platform) ?? null;
  }

  private parseGoalJson(value: string | null | undefined): CoworkGoal | null {
    if (!value) return null;
    try {
      return normalizeCoworkGoal(JSON.parse(value));
    } catch (error) {
      console.warn('[GenWorkStore] Failed to parse goal_json:', error);
      return null;
    }
  }

  private serializeGoal(goal: CoworkGoal | null | undefined): string | null {
    return goal ? JSON.stringify(goal) : null;
  }

  private mapSessionSummaryRow(row: GenWorkSessionSummaryRow): GenWorkSessionSummary {
    return {
      id: row.id,
      title: row.title,
      scheduledTaskId: row.scheduled_task_id?.trim() || null,
      status: row.status as GenWorkSessionStatus,
      pinned: Boolean(row.pinned),
      pinOrder: row.pin_order ?? null,
      agentId: row.agent_id || 'main',
      imPlatform: this.normalizeIMPlatform(row.im_platform),
      parentSessionId: row.parent_session_id ?? null,
      forkedAt: row.forked_at ?? null,
      forkMode: (row.fork_mode as GenWorkForkModeType | undefined) ?? GenWorkForkMode.None,
      goal: this.parseGoalJson(row.goal_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private upsertConfig(key: string, value: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO genwork_config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  createSession(
    title: string,
    cwd: string,
    systemPrompt: string = '',
    executionMode: GenWorkExecutionMode = 'local',
    activeSkillIds: string[] = [],
    agentId: string = 'main',
    modelOverride: string = '',
    options: CreateGenWorkSessionOptions = {},
  ): GenWorkSession {
    const id = uuidv4();
    const now = Date.now();
    const scheduledTaskId = options.scheduledTaskId?.trim() || null;
    const thinkingLevel = options.thinkingLevel ?? '';

    this.db
      .prepare(
        `
      INSERT INTO genwork_sessions (id, title, openclaw_session_id, scheduled_task_id, status, cwd, system_prompt, model_override, thinking_level, execution_mode, active_skill_ids, agent_id, pinned, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `,
      )
      .run(
        id,
        title,
        scheduledTaskId,
        cwd,
        systemPrompt,
        modelOverride,
        thinkingLevel,
        executionMode,
        JSON.stringify(activeSkillIds),
        agentId,
        now,
        now,
      );

    return {
      id,
      title,
      openclawSessionId: null,
      scheduledTaskId,
      status: 'idle',
      pinned: false,
      pinOrder: null,
      cwd,
      systemPrompt,
      modelOverride,
      thinkingLevel,
      executionMode,
      activeSkillIds,
      agentId,
      messages: [],
      messagesOffset: 0,
      totalMessages: 0,
      parentSessionId: null,
      forkedFromMessageId: null,
      forkedAt: null,
      forkMode: GenWorkForkMode.None,
      forkWorkspacePath: null,
      forkGitBranch: null,
      forkGitBaseRef: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  getSession(id: string, messageLimit = GENWORK_MESSAGE_PAGE_SIZE): GenWorkSession | null {
    interface SessionRow {
      id: string;
      title: string;
      openclaw_session_id: string | null;
      scheduled_task_id: string | null;
      status: string;
      pinned?: number | null;
      pin_order?: number | null;
      cwd: string;
      system_prompt: string;
      model_override?: string | null;
      thinking_level?: string | null;
      execution_mode?: string | null;
      active_skill_ids?: string | null;
      agent_id?: string | null;
      goal_json?: string | null;
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<SessionRow>(
      `
      SELECT id, title, openclaw_session_id, scheduled_task_id, status, pinned, pin_order, cwd, system_prompt, model_override, thinking_level, execution_mode, active_skill_ids, agent_id, goal_json, created_at, updated_at
      FROM genwork_sessions
      WHERE id = ?
    `,
      [id],
    );

    if (!row) return null;

    const totalMessages = this.countSessionMessages(id);
    const messageOffset = Math.max(0, totalMessages - messageLimit);
    const messages =
      messageOffset > 0
        ? this.getPagedSessionMessages(id, messageLimit, messageOffset)
        : this.getSessionMessages(id);

    let activeSkillIds: string[] = [];
    if (row.active_skill_ids) {
      try {
        activeSkillIds = JSON.parse(row.active_skill_ids);
      } catch (e) {
        console.error('[GenWorkStore] Failed to parse active_skill_ids for session', id, e);
        activeSkillIds = [];
      }
    }

    return {
      id: row.id,
      title: row.title,
      openclawSessionId: row.openclaw_session_id,
      scheduledTaskId: row.scheduled_task_id?.trim() || null,
      status: row.status as GenWorkSessionStatus,
      pinned: Boolean(row.pinned),
      pinOrder: row.pin_order ?? null,
      cwd: row.cwd,
      systemPrompt: row.system_prompt,
      modelOverride: row.model_override || '',
      thinkingLevel: parseModelThinkingLevel(row.thinking_level) ?? '',
      executionMode: (row.execution_mode as GenWorkExecutionMode) || 'local',
      activeSkillIds,
      agentId: row.agent_id || 'main',
      messages,
      messagesOffset: messageOffset,
      totalMessages,
      ...this.getSessionForkMetadata(row.id),
      goal: this.parseGoalJson(row.goal_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getContinuityCapsule(sessionId: string): CoworkContinuityCapsule | null {
    const row = this.getOne<CoworkContinuityCapsuleRow>(
      `
      SELECT session_id, version, revision, capsule_json, updated_at, last_source, last_compacted_at
      FROM genwork_session_capsules
      WHERE session_id = ?
    `,
      [sessionId],
    );
    if (!row) return null;
    try {
      const capsule = JSON.parse(row.capsule_json) as CoworkContinuityCapsule;
      return {
        ...capsule,
        sessionId: row.session_id,
        version: 1,
        revision: row.revision,
        updatedAt: row.updated_at,
        lastSource: row.last_source as CoworkContinuityCapsule['lastSource'],
        completedFacts: Array.isArray(capsule.completedFacts) ? capsule.completedFacts : [],
        ...(row.last_compacted_at != null ? { lastCompactedAt: row.last_compacted_at } : {}),
      };
    } catch (error) {
      console.warn(`[GenWorkStore] corrupt continuity capsule detected for session ${sessionId}, ignoring capsule.`, error);
      return null;
    }
  }

  upsertContinuityCapsule(sessionId: string, capsule: CoworkContinuityCapsule): void {
    this.db
      .prepare(
        `
      INSERT INTO genwork_session_capsules (
        session_id, version, revision, capsule_json, updated_at, last_source, last_compacted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        version = excluded.version,
        revision = excluded.revision,
        capsule_json = excluded.capsule_json,
        updated_at = excluded.updated_at,
        last_source = excluded.last_source,
        last_compacted_at = excluded.last_compacted_at
    `,
      )
      .run(
        sessionId,
        capsule.version,
        capsule.revision,
        JSON.stringify(capsule),
        capsule.updatedAt,
        capsule.lastSource,
        capsule.lastCompactedAt ?? null,
      );
  }

  deleteContinuityCapsules(sessionIds: string[]): void {
    const uniqueIds = Array.from(new Set(sessionIds.filter(Boolean)));
    if (uniqueIds.length === 0) return;
    const placeholders = uniqueIds.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM genwork_session_capsules WHERE session_id IN (${placeholders})`).run(...uniqueIds);
  }

  private copyContinuityCapsuleToFork(sourceSessionId: string, forkedSessionId: string, timestamp: number): void {
    const source = this.getContinuityCapsule(sourceSessionId);
    if (!source) return;
    const copied: CoworkContinuityCapsule = {
      ...source,
      sessionId: forkedSessionId,
      revision: 1,
      updatedAt: timestamp,
      lastSource: ContinuityCapsuleSource.Fork,
    };
    this.upsertContinuityCapsule(forkedSessionId, copied);
  }

  private getSessionForkMetadata(id: string): Pick<
    GenWorkSession,
    | 'parentSessionId'
    | 'forkedFromMessageId'
    | 'forkedAt'
    | 'forkMode'
    | 'forkWorkspacePath'
    | 'forkGitBranch'
    | 'forkGitBaseRef'
  > {
    try {
      const row = this.db
        .prepare(
          `
          SELECT parent_session_id, forked_from_message_id, forked_at, fork_mode,
                 fork_workspace_path, fork_git_branch, fork_git_base_ref
          FROM genwork_sessions
          WHERE id = ?
        `,
        )
        .get(id) as
        | {
            parent_session_id?: string | null;
            forked_from_message_id?: string | null;
            forked_at?: number | null;
            fork_mode?: string | null;
            fork_workspace_path?: string | null;
            fork_git_branch?: string | null;
            fork_git_base_ref?: string | null;
          }
        | undefined;

      return {
        parentSessionId: row?.parent_session_id ?? null,
        forkedFromMessageId: row?.forked_from_message_id ?? null,
        forkedAt: row?.forked_at ?? null,
        forkMode: (row?.fork_mode as GenWorkForkModeType | undefined) ?? GenWorkForkMode.None,
        forkWorkspacePath: row?.fork_workspace_path ?? null,
        forkGitBranch: row?.fork_git_branch ?? null,
        forkGitBaseRef: row?.fork_git_base_ref ?? null,
      };
    } catch {
      return {
        parentSessionId: null,
        forkedFromMessageId: null,
        forkedAt: null,
        forkMode: GenWorkForkMode.None,
        forkWorkspacePath: null,
        forkGitBranch: null,
        forkGitBaseRef: null,
      };
    }
  }

  forkSession(options: GenWorkForkSessionOptions): GenWorkSession {
    const source = this.getSession(options.sourceSessionId, 0);
    if (!source) {
      throw new Error(`Session ${options.sourceSessionId} not found`);
    }
    if (source.status === 'running') {
      throw new Error('Cannot fork a running session.');
    }

    const forkMode = options.forkMode ?? GenWorkForkMode.Conversation;
    const id = uuidv4();
    const now = Date.now();
    const title = options.title?.trim() || `${source.title} (fork)`;
    const cwd = options.cwdOverride ?? source.cwd;
    const forkedFromMessageId = options.forkedFromMessageId?.trim() || null;
    const forkBoundary = forkedFromMessageId
      ? this.getMessageForkBoundary(options.sourceSessionId, forkedFromMessageId)
      : null;
    const messageLimitSequence = forkBoundary?.sequence ?? null;

    if (forkedFromMessageId && (!forkBoundary || forkBoundary.sequence == null)) {
      throw new Error(`Message ${forkedFromMessageId} not found in session ${options.sourceSessionId}`);
    }

    const sourceMessages = this.getForkSourceMessages(
      options.sourceSessionId,
      messageLimitSequence,
      forkedFromMessageId,
    );
    const forkedMessageIds = new Map(sourceMessages.map(row => [row.id, uuidv4()]));
    const contextMessages = this.getForkContextMessages(
      options.sourceSessionId,
      options.contextMessages ?? [],
      forkBoundary,
    );
    const insertSession = this.db.prepare(
      `
      INSERT INTO genwork_sessions (
        id, title, openclaw_session_id, status, cwd, system_prompt, model_override, thinking_level,
        execution_mode, active_skill_ids, agent_id, pinned, pin_order,
        parent_session_id, forked_from_message_id, forked_at, fork_mode,
        fork_workspace_path, fork_git_branch, fork_git_base_ref,
        created_at, updated_at
      )
      VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );
    const insertMessage = this.db.prepare(
      `
      INSERT INTO genwork_messages (id, session_id, type, content, metadata, created_at, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    );

    this.db.transaction(() => {
      insertSession.run(
        id,
        title,
        cwd,
        source.systemPrompt,
        source.modelOverride,
        source.thinkingLevel ?? '',
        source.executionMode,
        JSON.stringify(source.activeSkillIds),
        source.agentId,
        source.id,
        forkedFromMessageId,
        now,
        forkMode,
        options.workspacePath ?? null,
        options.gitBranch ?? null,
        options.gitBaseRef ?? null,
        now,
        now,
      );

      for (const contextMessage of contextMessages) {
        const content = contextMessage.content.trim();
        if (!content) continue;
        insertMessage.run(
          uuidv4(),
          id,
          'system',
          content,
          JSON.stringify({
            hidden: true,
            ...contextMessage.metadata,
            kind: contextMessage.metadata.kind ?? CoworkSystemMessageKind.ForkCompactionSummary,
          }),
          now,
          null,
        );
      }

      for (const row of sourceMessages) {
        insertMessage.run(
          forkedMessageIds.get(row.id) ?? uuidv4(),
          id,
          row.type,
          row.content,
          this.sanitizeForkMessageMetadata(row.type, row.metadata, forkedMessageIds),
          row.created_at,
          row.sequence,
        );
      }

      this.copyContinuityCapsuleToFork(options.sourceSessionId, id, now);
    })();

    const forked = this.getSession(id);
    if (!forked) {
      throw new Error(`Forked session ${id} could not be loaded`);
    }
    return forked;
  }

  private getMessageForkBoundary(sessionId: string, messageId: string): GenWorkForkBoundary | null {
    const row = this.db
      .prepare('SELECT sequence, created_at FROM genwork_messages WHERE session_id = ? AND id = ?')
      .get(sessionId, messageId) as { sequence?: number | null; created_at?: number } | undefined;
    if (!row || typeof row.created_at !== 'number') return null;
    return {
      sequence: row.sequence ?? null,
      createdAt: row.created_at,
    };
  }

  getMessageTimestamp(sessionId: string, messageId: string): number | null {
    return this.getMessageForkBoundary(sessionId, messageId)?.createdAt ?? null;
  }

  private shouldCopyForkContextMessage(
    message: GenWorkForkContextMessage,
    forkBoundary: GenWorkForkBoundary | null,
  ): boolean {
    if (!forkBoundary) return true;
    const checkpointCreatedAt = message.metadata.checkpointCreatedAt;
    return typeof checkpointCreatedAt === 'number' && checkpointCreatedAt <= forkBoundary.createdAt;
  }

  private getForkContextMessages(
    sourceSessionId: string,
    providedMessages: GenWorkForkContextMessage[],
    forkBoundary: GenWorkForkBoundary | null,
  ): GenWorkForkContextMessage[] {
    const provided = providedMessages.find((message) => (
      message.content.trim() && this.shouldCopyForkContextMessage(message, forkBoundary)
    ));
    if (provided) return [provided];

    const rows = this.getAll<GenWorkMessageRow>(
      `
      SELECT id, type, content, metadata, created_at, sequence
      FROM genwork_messages
      WHERE session_id = ? AND type = 'system'
      ORDER BY created_at DESC, ROWID DESC
    `,
      [sourceSessionId],
    );

    for (const row of rows) {
      if (!row.metadata || !row.content.trim()) continue;
      try {
        const metadata = JSON.parse(row.metadata) as GenWorkMessageMetadata;
        if (metadata.kind !== CoworkSystemMessageKind.ForkCompactionSummary) continue;
        const inherited = { content: row.content, metadata };
        if (this.shouldCopyForkContextMessage(inherited, forkBoundary)) {
          return [inherited];
        }
      } catch {
        // Ignore malformed hidden context metadata and continue copying visible history.
      }
    }
    return [];
  }

  private getForkSourceMessages(
    sessionId: string,
    maxSequence: number | null,
    forkedFromMessageId: string | null,
  ): GenWorkMessageRow[] {
    const where = maxSequence == null ? '' : 'AND sequence <= ?';
    const params: (string | number)[] = maxSequence == null ? [sessionId] : [sessionId, maxSequence];
    const rows = this.getAll<GenWorkMessageRow>(
      `
      SELECT id, type, content, metadata, created_at, sequence
      FROM genwork_messages
      WHERE session_id = ? ${where}
      ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, ROWID ASC
    `,
      params,
    );

    return rows.filter((row) => this.shouldCopyForkMessage(row, forkedFromMessageId));
  }

  private shouldCopyForkMessage(row: GenWorkMessageRow, forkedFromMessageId: string | null): boolean {
    if (!row.metadata) return true;
    try {
      const metadata = JSON.parse(row.metadata) as GenWorkMessageMetadata;
      if (metadata.kind === CoworkSystemMessageKind.ForkCompactionSummary) {
        return false;
      }
      if (row.id === forkedFromMessageId && row.content.trim()) {
        if (row.type === 'assistant' && metadata.isStreaming === true) {
          console.warn(
            `[GenWorkFork] preserving selected assistant message ${row.id} despite stale streaming metadata.`,
          );
        }
        return true;
      }
      return row.type !== 'assistant' || metadata.isStreaming !== true;
    } catch {
      return true;
    }
  }

  private sanitizeForkMessageMetadata(
    messageType: string,
    metadataJson: string | null,
    forkedMessageIds: Map<string, string>,
  ): string | null {
    if (!metadataJson) return null;
    try {
      const metadata = JSON.parse(metadataJson) as GenWorkMessageMetadata;
      const sanitized: GenWorkMessageMetadata = { ...metadata };
      const wasStreamingAssistant = messageType === 'assistant' && sanitized.isStreaming === true;
      delete sanitized.isStreaming;
      if (wasStreamingAssistant) sanitized.isFinal = true;
      delete sanitized.toolUseId;
      delete sanitized.mediaStatusDetails;
      delete sanitized.pendingApproval;
      delete sanitized.requestId;
      delete sanitized.runId;
      delete sanitized.turnToken;
      delete sanitized.openClawRunId;
      delete sanitized.openClawSessionKey;
      delete sanitized[OpenClawCronRunMetadataKey.SessionKey];
      delete sanitized[OpenClawCronRunMetadataKey.EntryIndex];
      if (Array.isArray(sanitized.selectedTextSnippets)) {
        sanitized.selectedTextSnippets = sanitized.selectedTextSnippets.map(snippet => ({
          ...snippet,
          ...(snippet.sourceMessageId && (snippet.sourceType ?? snippet.sourceMessageType) === CoworkSelectedTextSource.AssistantMessage
            ? {
              sourceMessageId: forkedMessageIds.get(snippet.sourceMessageId) ?? snippet.sourceMessageId,
              sourceId: forkedMessageIds.get(snippet.sourceMessageId) ?? snippet.sourceId,
            }
            : {}),
        }));
      }
      return Object.keys(sanitized).length > 0 ? JSON.stringify(sanitized) : null;
    } catch {
      return null;
    }
  }

  updateSession(
    id: string,
    updates: Partial<
      Pick<
        GenWorkSession,
        'title' | 'openclawSessionId' | 'status' | 'cwd' | 'systemPrompt' | 'modelOverride' | 'thinkingLevel' | 'executionMode' | 'goal'
      >
    >,
    options: { touchUpdatedAt?: boolean } = {},
  ): void {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    // updated_at drives session list ordering, so by default it only moves on
    // a real status transition (run start/finish). Runtime adapters re-assert
    // 'running' on every stream event; those no-op writes must not reorder.
    // Callers can still force or suppress the touch via options.
    let touchUpdatedAt = options.touchUpdatedAt;
    if (touchUpdatedAt === undefined && updates.status !== undefined) {
      const current = this.db
        .prepare('SELECT status FROM genwork_sessions WHERE id = ?')
        .get(id) as { status: string } | undefined;
      touchUpdatedAt = !current || current.status !== updates.status;
    }
    if (touchUpdatedAt) {
      setClauses.push('updated_at = ?');
      values.push(Date.now());
    }

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      values.push(updates.title);
    }
    if (updates.openclawSessionId !== undefined) {
      setClauses.push('openclaw_session_id = ?');
      values.push(updates.openclawSessionId);
    }
    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      values.push(updates.status);
    }
    if (updates.cwd !== undefined) {
      setClauses.push('cwd = ?');
      values.push(updates.cwd);
    }
    if (updates.systemPrompt !== undefined) {
      setClauses.push('system_prompt = ?');
      values.push(updates.systemPrompt);
    }
    if (updates.modelOverride !== undefined) {
      setClauses.push('model_override = ?');
      values.push(updates.modelOverride);
    }
    if (updates.thinkingLevel !== undefined) {
      setClauses.push('thinking_level = ?');
      values.push(updates.thinkingLevel);
    }
    if (updates.executionMode !== undefined) {
      setClauses.push('execution_mode = ?');
      values.push(updates.executionMode);
    }
    if (updates.goal !== undefined) {
      setClauses.push('goal_json = ?');
      values.push(this.serializeGoal(updates.goal));
    }

    if (setClauses.length === 0) return;

    values.push(id);
    this.db
      .prepare(
        `
      UPDATE genwork_sessions
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `,
      )
      .run(...values);
  }

  listSessionIdsByAgent(agentId: string): string[] {
    const rows = this.getAll<{ id: string }>(
      'SELECT id FROM genwork_sessions WHERE agent_id = ?',
      [agentId],
    );
    return rows.map(row => row.id);
  }

  private deleteSessionRows(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const affectedArtifactRows = this.getAll<{ artifact_id: string }>(
      `SELECT DISTINCT artifact_id
       FROM library_artifact_sessions
       WHERE session_id IN (${placeholders})`,
      ids,
    );
    this.db.prepare(`DELETE FROM library_artifact_sessions WHERE session_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM genwork_session_capsules WHERE session_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM genwork_messages WHERE session_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM genwork_sessions WHERE id IN (${placeholders})`).run(...ids);
    return affectedArtifactRows.map(row => row.artifact_id);
  }

  private deleteSessionsForAgent(agentId: string): string[] {
    const sessionIds = this.listSessionIdsByAgent(agentId);
    for (const sessionId of sessionIds) {
      this.markMemorySourcesInactiveBySession(sessionId);
    }
    this.deleteSessionRows(sessionIds);
    return sessionIds;
  }

  deleteSession(id: string): string[] {
    const deleteSession = this.db.transaction((sessionId: string) => {
      this.markMemorySourcesInactiveBySession(sessionId);
      return this.deleteSessionRows([sessionId]);
    });
    const affectedArtifactIds = deleteSession(id);
    this.markOrphanImplicitMemoriesStale();
    return affectedArtifactIds;
  }

  deleteSessions(ids: string[]): string[] {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (uniqueIds.length === 0) return [];

    const deleteSessions = this.db.transaction((sessionIds: string[]) => {
      for (const id of sessionIds) {
        this.markMemorySourcesInactiveBySession(id);
      }
      return this.deleteSessionRows(sessionIds);
    });
    const affectedArtifactIds = deleteSessions(uniqueIds);
    this.markOrphanImplicitMemoriesStale();
    return affectedArtifactIds;
  }

  setSessionPinned(id: string, pinned: boolean): number | null {
    if (!pinned) {
      this.db.prepare('UPDATE genwork_sessions SET pinned = 0, pin_order = NULL WHERE id = ?').run(id);
      return null;
    }

    const session = this.db
      .prepare('SELECT agent_id FROM genwork_sessions WHERE id = ?')
      .get(id) as { agent_id?: string | null } | undefined;
    if (!session) {
      return null;
    }

    const agentId = session.agent_id || 'main';
    const maxRow = this.db
      .prepare(
        `
        SELECT MAX(pin_order) as max_pin_order
        FROM genwork_sessions
        WHERE pinned = 1 AND COALESCE(NULLIF(TRIM(agent_id), ''), 'main') = ?
      `,
      )
      .get(agentId) as { max_pin_order?: number | null } | undefined;
    const pinOrder = (maxRow?.max_pin_order ?? 0) + 1;
    this.db
      .prepare('UPDATE genwork_sessions SET pinned = 1, pin_order = ? WHERE id = ?')
      .run(pinOrder, id);
    return pinOrder;
  }

  countSessions(agentId?: string): number {
    if (agentId) {
      const row = this.db
        .prepare("SELECT COUNT(*) as count FROM genwork_sessions WHERE COALESCE(NULLIF(TRIM(agent_id), ''), 'main') = ?")
        .get(agentId) as { count: number } | undefined;
      return row?.count || 0;
    }
    const row = this.db.prepare('SELECT COUNT(*) as count FROM genwork_sessions').get() as
      | { count: number }
      | undefined;
    return row?.count || 0;
  }

  listSessions(limit = GENWORK_SESSION_PAGE_SIZE, offset = 0, agentId?: string): GenWorkSessionSummary[] {
    let rows: GenWorkSessionSummaryRow[];
    const summaryColumns = this.getSessionSummaryColumns();
    if (agentId) {
      rows = this.getAll<GenWorkSessionSummaryRow>(
        `
        SELECT ${summaryColumns}
        FROM genwork_sessions s
        WHERE COALESCE(NULLIF(TRIM(s.agent_id), ''), 'main') = ?
        ORDER BY s.pinned DESC,
          CASE WHEN s.pinned = 1 THEN COALESCE(s.pin_order, s.updated_at, s.created_at) END ASC,
          CASE WHEN s.pinned = 0 THEN s.updated_at END DESC,
          s.updated_at DESC
        LIMIT ? OFFSET ?
      `,
        [agentId, limit, offset],
      );
    } else {
      rows = this.getAll<GenWorkSessionSummaryRow>(
        `
        SELECT ${summaryColumns}
        FROM genwork_sessions s
        ORDER BY s.pinned DESC,
          CASE WHEN s.pinned = 1 THEN COALESCE(s.pin_order, s.updated_at, s.created_at) END ASC,
          CASE WHEN s.pinned = 0 THEN s.updated_at END DESC,
          s.updated_at DESC
        LIMIT ? OFFSET ?
      `,
        [limit, offset],
      );
    }

    return rows.map(row => this.mapSessionSummaryRow(row));
  }

  countSearchSessions(options: GenWorkSessionSearchOptions): number {
    const query = options.query.trim();
    if (!query) return this.countSessions(options.agentId);

    const pattern = `%${this.escapeLikePattern(query)}%`;
    if (options.agentId) {
      const row = this.db
        .prepare(
          `
          SELECT COUNT(*) as count
          FROM genwork_sessions
          WHERE title LIKE ? ESCAPE '\\'
            AND COALESCE(NULLIF(TRIM(agent_id), ''), 'main') = ?
        `,
        )
        .get(pattern, options.agentId) as { count: number } | undefined;
      return row?.count || 0;
    }

    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM genwork_sessions
        WHERE title LIKE ? ESCAPE '\\'
      `,
      )
      .get(pattern) as { count: number } | undefined;
    return row?.count || 0;
  }

  searchSessions(options: GenWorkSessionSearchOptions): GenWorkSessionSummary[] {
    const query = options.query.trim();
    const limit = options.limit ?? GENWORK_SESSION_PAGE_SIZE;
    const offset = options.offset ?? 0;
    if (!query) return this.listSessions(limit, offset, options.agentId);

    const pattern = `%${this.escapeLikePattern(query)}%`;
    let rows: GenWorkSessionSummaryRow[];
    const summaryColumns = this.getSessionSummaryColumns();
    if (options.agentId) {
      rows = this.getAll<GenWorkSessionSummaryRow>(
        `
        SELECT ${summaryColumns}
        FROM genwork_sessions s
        WHERE s.title LIKE ? ESCAPE '\\'
          AND COALESCE(NULLIF(TRIM(s.agent_id), ''), 'main') = ?
        ORDER BY s.pinned DESC,
          CASE WHEN s.pinned = 1 THEN COALESCE(s.pin_order, s.updated_at, s.created_at) END ASC,
          CASE WHEN s.pinned = 0 THEN s.updated_at END DESC,
          s.updated_at DESC
        LIMIT ? OFFSET ?
      `,
        [pattern, options.agentId, limit, offset],
      );
    } else {
      rows = this.getAll<GenWorkSessionSummaryRow>(
        `
        SELECT ${summaryColumns}
        FROM genwork_sessions s
        WHERE s.title LIKE ? ESCAPE '\\'
        ORDER BY s.pinned DESC,
          CASE WHEN s.pinned = 1 THEN COALESCE(s.pin_order, s.updated_at, s.created_at) END ASC,
          CASE WHEN s.pinned = 0 THEN s.updated_at END DESC,
          s.updated_at DESC
        LIMIT ? OFFSET ?
      `,
        [pattern, limit, offset],
      );
    }

    return rows.map(row => this.mapSessionSummaryRow(row));
  }

  resetRunningSessions(): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `
      UPDATE genwork_sessions
      SET status = 'idle', updated_at = ?
      WHERE status = 'running'
    `,
      )
      .run(now);
    return result.changes;
  }

  listRecentCwds(limit: number = 8): string[] {
    interface CwdRow {
      cwd: string;
      updated_at: number;
    }

    const rows = this.getAll<CwdRow>(
      `
      SELECT cwd, updated_at
      FROM genwork_sessions
      WHERE cwd IS NOT NULL AND TRIM(cwd) != ''
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      [Math.max(limit * 8, limit)],
    );

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const normalized = normalizeRecentWorkspacePath(row.cwd);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      deduped.push(normalized);
      if (deduped.length >= limit) {
        break;
      }
    }

    return deduped;
  }

  countSessionMessages(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM genwork_messages WHERE session_id = ?')
      .get(sessionId) as { count: number } | undefined;
    return row?.count || 0;
  }

  getPagedSessionMessages(sessionId: string, limit: number, offset: number): GenWorkMessage[] {
    const rows = this.getAll<GenWorkMessageRow>(
      `
      SELECT id, type, content, metadata, created_at, sequence
      FROM (
        SELECT id, type, content, metadata, created_at, sequence, ROWID as rowid_
        FROM genwork_messages
        WHERE session_id = ?
        ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, ROWID ASC
        LIMIT ? OFFSET ?
      )
      ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, rowid_ ASC
    `,
      [sessionId, limit, offset],
    );

    return rows.map(row => ({
      id: row.id,
      type: row.type as GenWorkMessageType,
      content: row.content,
      timestamp: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  /**
   * Read a bounded, search-only projection over the full mixed-message order.
   *
   * The page cursor advances over every stored message so each returned
   * user/assistant message keeps the same absolute index used by the ordinary
   * history API. Tool/system content and all metadata stay in the main process;
   * only the assistant thinking flag is evaluated in SQLite.
   */
  getSessionSearchMessagePage(
    sessionId: string,
    limit: number,
    offset: number,
    cursor?: CoworkSearchMessageCursor,
    knownTotal?: number,
  ): CoworkSearchMessagePage {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(GENWORK_SEARCH_MESSAGE_PAGE_MAX_SIZE, Math.floor(limit)))
      : GENWORK_SEARCH_MESSAGE_PAGE_SIZE;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    if (safeOffset > 0 && !cursor) {
      throw new Error('Conversation search cursor is required after the first page');
    }
    if (cursor && ![
      cursor.sortValue,
      cursor.createdAt,
      cursor.rowId,
    ].every(value => Number.isFinite(value))) {
      throw new Error('Invalid conversation search cursor');
    }
    const safeKnownTotal = knownTotal !== undefined
      && Number.isFinite(knownTotal)
      && knownTotal >= safeOffset
      ? Math.floor(knownTotal)
      : undefined;
    // The first page establishes the snapshot size. Later keyset pages carry
    // it forward, avoiding an O(history-size) COUNT scan for every page.
    const total = safeKnownTotal ?? this.countSessionMessages(sessionId);
    type SearchProjectionIndexRow = {
      id: string;
      type: string;
      search_content_byte_length: number;
      created_at: number;
      is_thinking: number;
      sort_value: number;
      row_id: number;
    };
    const projection = `
      SELECT
        id,
        type,
        CASE
          WHEN type = 'user' THEN LENGTH(CAST(content AS BLOB))
          WHEN type = 'assistant'
            AND NOT (
              metadata IS NOT NULL
              AND json_valid(metadata) = 1
              AND COALESCE(json_extract(metadata, '$.isThinking'), 0) = 1
            )
          THEN LENGTH(CAST(content AS BLOB))
          ELSE 0
        END AS search_content_byte_length,
        created_at,
        COALESCE(sequence, created_at) AS sort_value,
        ROWID AS row_id,
        CASE
          WHEN type = 'assistant'
            AND metadata IS NOT NULL
            AND json_valid(metadata) = 1
            AND json_extract(metadata, '$.isThinking') = 1
          THEN 1
          ELSE 0
        END AS is_thinking
      FROM genwork_messages
      WHERE session_id = ?
    `;
    const rows = cursor
      ? this.getAll<SearchProjectionIndexRow>(
        `${projection}
          AND COALESCE(sequence, created_at) >= ?
          AND (
            COALESCE(sequence, created_at) > ?
            OR created_at > ?
            OR (created_at = ? AND ROWID > ?)
          )
          ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, ROWID ASC
          LIMIT ?
        `,
        [
          sessionId,
          cursor.sortValue,
          cursor.sortValue,
          cursor.createdAt,
          cursor.createdAt,
          cursor.rowId,
          safeLimit,
        ],
      )
      : this.getAll<SearchProjectionIndexRow>(
        `${projection}
      ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, ROWID ASC
          LIMIT ?
        `,
        [
          sessionId,
          safeLimit,
        ],
      );

    const isSearchableRow = (row: SearchProjectionIndexRow): boolean => (
      (row.type === 'user' || row.type === 'assistant')
      && row.is_thinking !== 1
    );
    const searchableRows = rows.filter(isSearchableRow);
    let searchContentByteLength = 0;
    for (const row of searchableRows) {
      searchContentByteLength += row.search_content_byte_length;
      if (searchContentByteLength > GENWORK_SEARCH_MESSAGE_PAGE_MAX_CONTENT_BYTES) break;
    }

    let messages: CoworkSearchMessage[];
    if (searchContentByteLength > GENWORK_SEARCH_MESSAGE_PAGE_MAX_CONTENT_BYTES) {
      const sentinelRowIndex = rows.findIndex(isSearchableRow);
      if (sentinelRowIndex < 0) {
        throw new Error('Conversation search payload exceeded its budget without content');
      }
      const sentinelRow = rows[sentinelRowIndex];
      messages = [{
        id: sentinelRow.id,
        type: sentinelRow.type as 'user' | 'assistant',
        content: 'x'.repeat(GENWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS + 1),
        timestamp: sentinelRow.created_at,
        absoluteMessageIndex: safeOffset + sentinelRowIndex,
      }];
    } else {
      type SearchProjectionContentRow = {
        row_id: number;
        search_content: string;
      };
      const contentRows = searchableRows.length > 0
        ? this.getAll<SearchProjectionContentRow>(
          `
            SELECT
              ROWID AS row_id,
              SUBSTR(content, 1, ?) AS search_content
            FROM genwork_messages
            WHERE session_id = ?
              AND ROWID IN (${searchableRows.map(() => '?').join(', ')})
          `,
          [
            GENWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS + 1,
            sessionId,
            ...searchableRows.map(row => row.row_id),
          ],
        )
        : [];
      const contentByRowId = new Map(
        contentRows.map(row => [row.row_id, row.search_content]),
      );
      messages = rows.flatMap((row, index) => {
        if (!isSearchableRow(row)) return [];
        const content = contentByRowId.get(row.row_id);
        if (content === undefined) {
          throw new Error('Conversation search content changed while reading its page');
        }
        if (!content.trim()) return [];
        return [{
          id: row.id,
          type: row.type as 'user' | 'assistant',
          content,
          timestamp: row.created_at,
          absoluteMessageIndex: safeOffset + index,
        }];
      });
    }

    return {
      messages,
      offset: safeOffset,
      nextOffset: safeOffset + rows.length,
      nextCursor: rows.length > 0
        ? {
          sortValue: rows[rows.length - 1].sort_value,
          createdAt: rows[rows.length - 1].created_at,
          rowId: rows[rows.length - 1].row_id,
        }
        : cursor,
      total,
    };
  }

  /**
   * Read a bounded conversation tail independently from the renderer's mixed-message page.
   * Channel history reconciliation uses this to compare the same-sized user/assistant window
   * returned by the gateway without loading an unbounded transcript into memory.
   */
  getRecentConversationMessages(sessionId: string, limit: number): GenWorkMessage[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const boundedLimit = Math.floor(limit);

    const rows = this.getAll<GenWorkMessageRow>(
      `
      SELECT id, type, content, metadata, created_at, sequence
      FROM (
        SELECT id, type, content, metadata, created_at, sequence, ROWID as rowid_
        FROM genwork_messages
        WHERE session_id = ? AND type IN ('user', 'assistant')
        ORDER BY COALESCE(sequence, created_at) DESC, created_at DESC, ROWID DESC
        LIMIT ?
      )
      ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, rowid_ ASC
    `,
      [sessionId, boundedLimit],
    );

    return this.mapConversationMessageRows(sessionId, rows);
  }

  /**
   * Read the complete user/assistant transcript for a rare reconciliation fallback.
   * Routine polling must use getRecentConversationMessages() to keep reads bounded.
   */
  getAllConversationMessages(sessionId: string): GenWorkMessage[] {
    const rows = this.getAll<GenWorkMessageRow>(
      `
      SELECT id, type, content, metadata, created_at, sequence
      FROM genwork_messages
      WHERE session_id = ? AND type IN ('user', 'assistant')
      ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, ROWID ASC
    `,
      [sessionId],
    );

    return this.mapConversationMessageRows(sessionId, rows);
  }

  getSessionMessageRailIndex(sessionId: string): CoworkMessageRailIndexItem[] {
    const rows = this.getAll<{
      id: string;
      type: string;
      preview_content: string;
      content_len: number;
      metadata: string | null;
      created_at: number;
      sequence: number | null;
      message_offset: number;
      is_visible: number;
    }>(
      `
      SELECT id, type, preview_content, content_len, metadata, created_at, sequence, message_offset
      FROM (
        SELECT
          id,
          type,
          substr(content, 1, 2000) as preview_content,
          length(content) as content_len,
          metadata,
          created_at,
          sequence,
          ROW_NUMBER() OVER (
            ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, ROWID ASC
          ) - 1 as message_offset,
          CASE
            WHEN type IN ('user', 'assistant') AND TRIM(content) <> '' THEN 1
            ELSE 0
          END as is_visible
        FROM genwork_messages
        WHERE session_id = ?
      )
      WHERE is_visible = 1
      ORDER BY message_offset ASC
    `,
      [sessionId],
    );

    const visibleRows = rows.filter((row) => {
      if (row.type !== 'assistant' || !row.metadata) return true;
      try {
        const metadata = JSON.parse(row.metadata) as GenWorkMessageMetadata;
        return metadata.isThinking !== true;
      } catch {
        return true;
      }
    });

    return visibleRows.map((row, index) => ({
      messageId: row.id,
      type: row.type as 'user' | 'assistant',
      sequence: row.sequence,
      messageOffset: row.message_offset,
      timestamp: row.created_at,
      preview: getCoworkRailPreview(
        row.preview_content,
        row.type === 'user' ? `Turn ${index + 1}` : 'GenWork',
        GENWORK_RAIL_TOOLTIP_PREVIEW_MAX_LENGTH,
      ),
      contentLen: row.content_len,
    }));
  }

  private getSessionMessages(sessionId: string): GenWorkMessage[] {
    const rows = this.getAll<GenWorkMessageRow>(
      `
      SELECT id, type, content, metadata, created_at, sequence
      FROM genwork_messages
      WHERE session_id = ?
      ORDER BY
        COALESCE(sequence, created_at) ASC,
        created_at ASC,
        ROWID ASC
    `,
      [sessionId],
    );

    return rows.map(row => {
      let metadata: Record<string, unknown> | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          console.warn(
            `[GenWorkStore] corrupt metadata detected for message ${row.id} in session ${sessionId}, discarding metadata`,
          );
          metadata = undefined;
        }
      }
      return {
        id: row.id,
        type: row.type as GenWorkMessageType,
        content: row.content,
        timestamp: row.created_at,
        metadata,
      };
    });
  }

  addMessage(sessionId: string, message: Omit<GenWorkMessage, 'id' | 'timestamp'>, timestamp?: number): GenWorkMessage {
    const id = uuidv4();
    const now = timestamp ?? Date.now();

    const seqRow = this.db
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq FROM genwork_messages WHERE session_id = ?',
      )
      .get(sessionId) as { next_seq: number } | undefined;
    const sequence = seqRow?.next_seq ?? 1;

    this.db
      .prepare(
        `
      INSERT INTO genwork_messages (id, session_id, type, content, metadata, created_at, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        sessionId,
        message.type,
        message.content,
        message.metadata ? JSON.stringify(message.metadata) : null,
        now,
        sequence,
      );

    // updated_at drives session list ordering: only user messages may move it,
    // otherwise concurrent streaming runs keep reordering the list.
    if (message.type === 'user') {
      this.db.prepare('UPDATE genwork_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    }

    return {
      id,
      type: message.type,
      content: message.content,
      timestamp: now,
      metadata: message.metadata,
    };
  }

  /**
   * Insert a message before an existing message (by shifting sequences).
   * Used for channel-originated sessions where user messages need to appear
   * before assistant messages that were created during streaming.
   */
  insertMessageBeforeId(
    sessionId: string,
    beforeMessageId: string,
    message: Omit<GenWorkMessage, 'id' | 'timestamp'>,
  ): GenWorkMessage {
    const id = uuidv4();
    const now = Date.now();

    // Get the target message's sequence
    const targetRow = this.db
      .prepare('SELECT sequence FROM genwork_messages WHERE id = ? AND session_id = ?')
      .get(beforeMessageId, sessionId) as { sequence: number } | undefined;
    const targetSequence = targetRow?.sequence;

    if (targetSequence === undefined) {
      // Fallback to normal append if the target message is not found
      return this.addMessage(sessionId, message);
    }

    this.db.transaction(() => {
      // Shift all messages with sequence >= target up by 1
      this.db
        .prepare(
          'UPDATE genwork_messages SET sequence = sequence + 1 WHERE session_id = ? AND sequence >= ?',
        )
        .run(sessionId, targetSequence);

      // Insert at the target's original sequence
      this.db
        .prepare(
          `
        INSERT INTO genwork_messages (id, session_id, type, content, metadata, created_at, sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          sessionId,
          message.type,
          message.content,
          message.metadata ? JSON.stringify(message.metadata) : null,
          now,
          targetSequence,
        );

      if (message.type === 'user') {
        this.db.prepare('UPDATE genwork_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
      }
    })();

    return {
      id,
      type: message.type,
      content: message.content,
      timestamp: now,
      metadata: message.metadata,
    };
  }

  /**
   * Delete a message from a session.
   * Used by reconciliation to remove duplicate or spurious messages.
   */
  deleteMessage(sessionId: string, messageId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM genwork_messages WHERE id = ? AND session_id = ?')
      .run(messageId, sessionId);
    return result.changes > 0;
  }

  /**
   * Replace all user/assistant messages in a session with the given list.
   * Tool messages (tool_use, tool_result, system) are preserved in their existing positions.
   * Used by history reconciliation to align local state with the authoritative gateway history.
   */
  replaceConversationMessages(
    sessionId: string,
    authoritative: GenWorkConversationReplacementEntry[],
  ): void {
    const now = Date.now();

    this.db.transaction(() => {
      const existingRows = this.db
        .prepare(
          `
          SELECT type, content, created_at
          FROM genwork_messages
          WHERE session_id = ? AND type IN ('user', 'assistant')
          ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, ROWID ASC
        `,
        )
        .all(sessionId) as Array<{ type: 'user' | 'assistant'; content: string; created_at: number }>;
      const existingTimestamps = new Map<string, number[]>();
      for (const row of existingRows) {
        const timestamp = normalizeMessageTimestamp(Number(row.created_at));
        if (timestamp == null) continue;
        const key = `${row.type}\x1f${row.content}`;
        const timestamps = existingTimestamps.get(key) ?? [];
        timestamps.push(timestamp);
        existingTimestamps.set(key, timestamps);
      }

      // Delete all existing user/assistant messages for this session
      this.db
        .prepare(
          "DELETE FROM genwork_messages WHERE session_id = ? AND type IN ('user', 'assistant')",
        )
        .run(sessionId);

      // Re-insert authoritative messages with correct sequence numbers
      // First, get the current max sequence from remaining messages (tool_use, tool_result, system)
      const seqRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM genwork_messages WHERE session_id = ?',
        )
        .get(sessionId) as { max_seq: number } | undefined;
      let nextSeq = (seqRow?.max_seq ?? 0) + 1;
      let lastUserMessageAt: number | null = null;

      for (const entry of authoritative) {
        const id = uuidv4();
        const baseMetadata = { isStreaming: false, isFinal: true };
        const finalMetadata = entry.metadata
          ? { ...baseMetadata, ...entry.metadata }
          : baseMetadata;
        const existingKey = `${entry.role}\x1f${entry.text}`;
        const matchingExistingTimestamps = existingTimestamps.get(existingKey);
        const existingTimestamp = matchingExistingTimestamps?.shift();
        const messageTimestamp = normalizeMessageTimestamp(entry.timestamp)
          ?? existingTimestamp
          ?? now;
        if (entry.role === 'user') {
          lastUserMessageAt = Math.max(lastUserMessageAt ?? 0, messageTimestamp);
        }
        this.db
          .prepare(
            `
          INSERT INTO genwork_messages (id, session_id, type, content, metadata, created_at, sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            id,
            sessionId,
            entry.role,
            entry.text,
            JSON.stringify(finalMetadata),
            messageTimestamp,
            nextSeq++,
          );
      }

      // Reconciliation runs repeatedly for channel-synced sessions: assistant
      // output must not reorder the session list, and updated_at never moves
      // backwards. Only a newer user message may advance it.
      if (lastUserMessageAt != null) {
        this.db
          .prepare('UPDATE genwork_sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?')
          .run(lastUserMessageAt, sessionId);
      }
    })();
  }

  replaceSessionMessages(
    sessionId: string,
    messages: GenWorkMessageReplacementEntry[],
  ): void {
    const now = Date.now();

    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM genwork_messages WHERE session_id = ? AND type IN ('user', 'assistant', 'tool_use', 'tool_result')",
        )
        .run(sessionId);

      const insert = this.db.prepare(`
        INSERT INTO genwork_messages (id, session_id, type, content, metadata, created_at, sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const seqRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM genwork_messages WHERE session_id = ?',
        )
        .get(sessionId) as { max_seq: number } | undefined;
      let sequence = (seqRow?.max_seq ?? 0) + 1;
      let lastUserMessageAt: number | null = null;
      for (const message of messages) {
        const messageTimestamp = normalizeMessageTimestamp(message.timestamp) ?? now;
        if (message.type === 'user') {
          lastUserMessageAt = Math.max(lastUserMessageAt ?? 0, messageTimestamp);
        }
        insert.run(
          uuidv4(),
          sessionId,
          message.type,
          message.content,
          message.metadata ? JSON.stringify(message.metadata) : null,
          messageTimestamp,
          sequence++,
        );
      }

      if (lastUserMessageAt != null) {
        this.db
          .prepare('UPDATE genwork_sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?')
          .run(lastUserMessageAt, sessionId);
      }
    })();
  }

  updateMessage(
    sessionId: string,
    messageId: string,
    updates: { content?: string; metadata?: GenWorkMessageMetadata },
  ): void {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      values.push(updates.content);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }

    if (setClauses.length === 0) return;

    values.push(messageId);
    values.push(sessionId);
    // Intentionally leaves session updated_at untouched: this runs for every
    // streaming delta and would make concurrent runs fight over list order.
    this.db
      .prepare(
        `
      UPDATE genwork_messages
      SET ${setClauses.join(', ')}
      WHERE id = ? AND session_id = ?
    `,
      )
      .run(...values);
  }

  // Config operations
  getConfig(): GenWorkConfig {
    const configKeys = [
      'workingDirectory',
      'executionMode',
      'agentEngine',
      'memoryEnabled',
      'memoryImplicitUpdateEnabled',
      'memoryLlmJudgeEnabled',
      'memoryGuardLevel',
      'memoryUserMemoriesMaxItems',
      'skipMissedJobs',
      'openClawHeartbeatEnabled',
      'embeddingEnabled',
      'embeddingProvider',
      'embeddingModel',
      'embeddingLocalModelPath',
      'embeddingVectorWeight',
      'embeddingRemoteBaseUrl',
      'embeddingRemoteApiKey',
      'dreamingEnabled',
      'dreamingFrequency',
      'dreamingModel',
      'dreamingTimezone',
    ] as const;
    const configRows = this.getAll<{ key: string; value: string }>(
      `SELECT key, value FROM genwork_config WHERE key IN (${configKeys.map(() => '?').join(', ')})`,
      [...configKeys],
    );
    const cfg = new Map(configRows.map(r => [r.key, r.value]));

    return {
      workingDirectory: cfg.get('workingDirectory') || getDefaultWorkingDirectory(),
      systemPrompt: getDefaultSystemPrompt(),
      executionMode: 'local' as GenWorkExecutionMode,
      agentEngine: 'openclaw' as GenWorkAgentEngine,
      memoryEnabled: parseBooleanConfig(cfg.get('memoryEnabled'), DEFAULT_MEMORY_ENABLED),
      memoryImplicitUpdateEnabled: parseBooleanConfig(
        cfg.get('memoryImplicitUpdateEnabled'),
        DEFAULT_MEMORY_IMPLICIT_UPDATE_ENABLED,
      ),
      memoryLlmJudgeEnabled: parseBooleanConfig(
        cfg.get('memoryLlmJudgeEnabled'),
        DEFAULT_MEMORY_LLM_JUDGE_ENABLED,
      ),
      memoryGuardLevel: normalizeMemoryGuardLevel(cfg.get('memoryGuardLevel')),
      memoryUserMemoriesMaxItems: clampMemoryUserMemoriesMaxItems(
        Number(cfg.get('memoryUserMemoriesMaxItems')),
      ),
      skipMissedJobs: parseBooleanConfig(cfg.get('skipMissedJobs'), true),
      openClawHeartbeatEnabled: parseBooleanConfig(cfg.get('openClawHeartbeatEnabled'), true),
      embeddingEnabled: parseBooleanConfig(cfg.get('embeddingEnabled'), DEFAULT_EMBEDDING_ENABLED),
      embeddingProvider: cfg.get('embeddingProvider') || DEFAULT_EMBEDDING_PROVIDER,
      embeddingModel: cfg.get('embeddingModel') || DEFAULT_EMBEDDING_MODEL,
      embeddingLocalModelPath: cfg.get('embeddingLocalModelPath') || DEFAULT_EMBEDDING_LOCAL_MODEL_PATH,
      embeddingVectorWeight: parseEmbeddingVectorWeight(cfg.get('embeddingVectorWeight')),
      embeddingRemoteBaseUrl: cfg.get('embeddingRemoteBaseUrl') || DEFAULT_EMBEDDING_REMOTE_BASE_URL,
      embeddingRemoteApiKey: cfg.get('embeddingRemoteApiKey') || DEFAULT_EMBEDDING_REMOTE_API_KEY,
      dreamingEnabled: parseBooleanConfig(cfg.get('dreamingEnabled'), DEFAULT_DREAMING_ENABLED),
      dreamingFrequency: cfg.get('dreamingFrequency') || DEFAULT_DREAMING_FREQUENCY,
      dreamingModel: cfg.get('dreamingModel') || DEFAULT_DREAMING_MODEL,
      dreamingTimezone: cfg.get('dreamingTimezone') || DEFAULT_DREAMING_TIMEZONE,
    };
  }

  setConfig(config: GenWorkConfigUpdate): void {
    const now = Date.now();

    if (config.workingDirectory !== undefined) {
      this.upsertConfig('workingDirectory', config.workingDirectory, now);
    }
    if (config.executionMode !== undefined) {
      this.upsertConfig('executionMode', config.executionMode, now);
    }
    if (config.agentEngine !== undefined) {
      this.upsertConfig('agentEngine', 'openclaw', now);
    }
    if (config.memoryEnabled !== undefined) {
      this.upsertConfig('memoryEnabled', config.memoryEnabled ? '1' : '0', now);
    }
    if (config.memoryImplicitUpdateEnabled !== undefined) {
      this.upsertConfig('memoryImplicitUpdateEnabled', config.memoryImplicitUpdateEnabled ? '1' : '0', now);
    }
    if (config.memoryLlmJudgeEnabled !== undefined) {
      this.upsertConfig('memoryLlmJudgeEnabled', config.memoryLlmJudgeEnabled ? '1' : '0', now);
    }
    if (config.memoryGuardLevel !== undefined) {
      this.upsertConfig('memoryGuardLevel', normalizeMemoryGuardLevel(config.memoryGuardLevel), now);
    }
    if (config.memoryUserMemoriesMaxItems !== undefined) {
      this.upsertConfig('memoryUserMemoriesMaxItems', String(clampMemoryUserMemoriesMaxItems(config.memoryUserMemoriesMaxItems)), now);
    }
    if (config.skipMissedJobs !== undefined) {
      this.upsertConfig('skipMissedJobs', config.skipMissedJobs ? '1' : '0', now);
    }
    if (config.openClawHeartbeatEnabled !== undefined) {
      this.upsertConfig('openClawHeartbeatEnabled', config.openClawHeartbeatEnabled ? '1' : '0', now);
    }
    if (config.embeddingEnabled !== undefined) {
      this.upsertConfig('embeddingEnabled', config.embeddingEnabled ? '1' : '0', now);
    }
    if (config.embeddingProvider !== undefined) {
      this.upsertConfig('embeddingProvider', String(config.embeddingProvider), now);
    }
    if (config.embeddingModel !== undefined) {
      this.upsertConfig('embeddingModel', String(config.embeddingModel), now);
    }
    if (config.embeddingLocalModelPath !== undefined) {
      this.upsertConfig('embeddingLocalModelPath', String(config.embeddingLocalModelPath), now);
    }
    if (config.embeddingVectorWeight !== undefined) {
      this.upsertConfig('embeddingVectorWeight', String(Math.max(0, Math.min(1, config.embeddingVectorWeight))), now);
    }
    if (config.embeddingRemoteBaseUrl !== undefined) {
      this.upsertConfig('embeddingRemoteBaseUrl', String(config.embeddingRemoteBaseUrl), now);
    }
    if (config.embeddingRemoteApiKey !== undefined) {
      this.upsertConfig('embeddingRemoteApiKey', String(config.embeddingRemoteApiKey), now);
    }
    if (config.dreamingEnabled !== undefined) {
      this.upsertConfig('dreamingEnabled', config.dreamingEnabled ? '1' : '0', now);
    }
    if (config.dreamingFrequency !== undefined) {
      this.upsertConfig('dreamingFrequency', String(config.dreamingFrequency), now);
    }
    if (config.dreamingModel !== undefined) {
      this.upsertConfig('dreamingModel', String(config.dreamingModel), now);
    }
    if (config.dreamingTimezone !== undefined) {
      this.upsertConfig('dreamingTimezone', String(config.dreamingTimezone), now);
    }
  }

  /**
   * Distinct session working directories with activity since the given
   * timestamp. Used by the cowork temp janitor to scope its sweep.
   */
  listRecentSessionCwds(sinceMs: number): string[] {
    const rows = this.getAll<{ cwd: string }>(
      `
      SELECT cwd FROM genwork_sessions
      WHERE cwd IS NOT NULL AND cwd != ''
      GROUP BY cwd
      HAVING MAX(updated_at) >= ?
    `,
      [sinceMs],
    );
    return rows.map(row => row.cwd);
  }

  /** Distinct working directories of the given sessions. */
  listSessionCwds(sessionIds: string[]): string[] {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = this.getAll<{ cwd: string }>(
      `SELECT DISTINCT cwd FROM genwork_sessions WHERE id IN (${placeholders}) AND cwd IS NOT NULL AND cwd != ''`,
      sessionIds,
    );
    return rows.map(row => row.cwd);
  }

  getAppLanguage(): 'zh' | 'en' {
    interface KvRow {
      value: string;
    }

    const row = this.getOne<KvRow>('SELECT value FROM kv WHERE key = ?', ['app_config']);
    if (!row?.value) {
      return 'zh';
    }

    try {
      const config = JSON.parse(row.value) as { language?: string };
      return config.language === 'en' ? 'en' : 'zh';
    } catch {
      return 'zh';
    }
  }

  private mapMemoryRow(row: GenWorkUserMemoryRow): GenWorkUserMemory {
    return {
      id: row.id,
      text: row.text,
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.7,
      isExplicit: Boolean(row.is_explicit),
      status: (row.status === 'stale' || row.status === 'deleted'
        ? row.status
        : 'created') as GenWorkUserMemoryStatus,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    };
  }

  private addMemorySource(memoryId: string, source?: GenWorkUserMemorySourceInput): void {
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT INTO user_memory_sources (id, memory_id, session_id, message_id, role, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `,
      )
      .run(
        uuidv4(),
        memoryId,
        source?.sessionId || null,
        source?.messageId || null,
        source?.role || 'system',
        now,
      );
  }

  private createOrReviveUserMemory(input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
    source?: GenWorkUserMemorySourceInput;
  }): { memory: GenWorkUserMemory; created: boolean; updated: boolean } {
    const normalizedText = truncate(normalizeMemoryText(input.text), 360);
    if (!normalizedText) {
      throw new Error('Memory text is required');
    }

    const now = Date.now();
    const fingerprint = buildMemoryFingerprint(normalizedText);
    const confidence = Math.max(
      0,
      Math.min(1, Number.isFinite(input.confidence) ? Number(input.confidence) : 0.75),
    );
    const explicitFlag = input.isExplicit ? 1 : 0;

    let existing = this.getOne<GenWorkUserMemoryRow>(
      `
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE fingerprint = ? AND status != 'deleted'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
      [fingerprint],
    );

    if (!existing) {
      const incomingSemanticKey = normalizeMemorySemanticKey(normalizedText);
      if (incomingSemanticKey) {
        const candidates = this.getAll<GenWorkUserMemoryRow>(`
          SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
          FROM user_memories
          WHERE status != 'deleted'
          ORDER BY updated_at DESC
          LIMIT 200
        `);
        let bestCandidate: GenWorkUserMemoryRow | null = null;
        let bestScore = 0;
        for (const candidate of candidates) {
          const candidateSemanticKey = normalizeMemorySemanticKey(candidate.text);
          if (!candidateSemanticKey) continue;
          const score = scoreMemorySimilarity(candidateSemanticKey, incomingSemanticKey);
          if (score <= bestScore) continue;
          bestScore = score;
          bestCandidate = candidate;
        }
        if (bestCandidate && bestScore >= MEMORY_NEAR_DUPLICATE_MIN_SCORE) {
          existing = bestCandidate;
        }
      }
    }

    if (existing) {
      const mergedText = choosePreferredMemoryText(existing.text, normalizedText);
      const mergedExplicit = existing.is_explicit ? 1 : explicitFlag;
      const mergedConfidence = Math.max(Number(existing.confidence) || 0, confidence);
      this.db
        .prepare(
          `
        UPDATE user_memories
        SET text = ?, fingerprint = ?, confidence = ?, is_explicit = ?, status = 'created', updated_at = ?
        WHERE id = ?
      `,
        )
        .run(
          mergedText,
          buildMemoryFingerprint(mergedText),
          mergedConfidence,
          mergedExplicit,
          now,
          existing.id,
        );
      this.addMemorySource(existing.id, input.source);
      const memory = this.getOne<GenWorkUserMemoryRow>(
        `
        SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
        FROM user_memories
        WHERE id = ?
      `,
        [existing.id],
      );
      if (!memory) {
        throw new Error('Failed to reload updated memory');
      }
      return { memory: this.mapMemoryRow(memory), created: false, updated: true };
    }

    const id = uuidv4();
    this.db
      .prepare(
        `
      INSERT INTO user_memories (
        id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, 'created', ?, ?, NULL)
    `,
      )
      .run(id, normalizedText, fingerprint, confidence, explicitFlag, now, now);
    this.addMemorySource(id, input.source);

    const memory = this.getOne<GenWorkUserMemoryRow>(
      `
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE id = ?
    `,
      [id],
    );
    if (!memory) {
      throw new Error('Failed to load created memory');
    }

    return { memory: this.mapMemoryRow(memory), created: true, updated: false };
  }

  listUserMemories(
    options: {
      query?: string;
      status?: GenWorkUserMemoryStatus | 'all';
      limit?: number;
      offset?: number;
      includeDeleted?: boolean;
    } = {},
  ): GenWorkUserMemory[] {
    const query = normalizeMemoryText(options.query || '');
    const includeDeleted = Boolean(options.includeDeleted);
    const status = options.status || 'all';
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 200)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));

    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (!includeDeleted && status === 'all') {
      clauses.push(`status != 'deleted'`);
    }
    if (status !== 'all') {
      clauses.push('status = ?');
      params.push(status);
    }
    if (query) {
      clauses.push('LOWER(text) LIKE ?');
      params.push(`%${query.toLowerCase()}%`);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.getAll<GenWorkUserMemoryRow>(
      `
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `,
      [...params, limit, offset],
    );

    return rows.map(row => this.mapMemoryRow(row));
  }

  createUserMemory(input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
    source?: GenWorkUserMemorySourceInput;
  }): GenWorkUserMemory {
    const result = this.createOrReviveUserMemory(input);
    return result.memory;
  }

  updateUserMemory(input: {
    id: string;
    text?: string;
    confidence?: number;
    status?: GenWorkUserMemoryStatus;
    isExplicit?: boolean;
  }): GenWorkUserMemory | null {
    const current = this.getOne<GenWorkUserMemoryRow>(
      `
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE id = ?
    `,
      [input.id],
    );
    if (!current) return null;

    const now = Date.now();
    const nextText =
      input.text !== undefined ? truncate(normalizeMemoryText(input.text), 360) : current.text;
    if (!nextText) {
      throw new Error('Memory text is required');
    }
    const nextConfidence =
      input.confidence !== undefined
        ? Math.max(0, Math.min(1, Number(input.confidence)))
        : Number(current.confidence);
    const nextStatus =
      input.status &&
      (input.status === 'created' || input.status === 'stale' || input.status === 'deleted')
        ? input.status
        : current.status;
    const nextExplicit =
      input.isExplicit !== undefined ? (input.isExplicit ? 1 : 0) : current.is_explicit;

    this.db
      .prepare(
        `
      UPDATE user_memories
      SET text = ?, fingerprint = ?, confidence = ?, is_explicit = ?, status = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        nextText,
        buildMemoryFingerprint(nextText),
        nextConfidence,
        nextExplicit,
        nextStatus,
        now,
        input.id,
      );

    const updated = this.getOne<GenWorkUserMemoryRow>(
      `
      SELECT id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
      FROM user_memories
      WHERE id = ?
    `,
      [input.id],
    );

    return updated ? this.mapMemoryRow(updated) : null;
  }

  deleteUserMemory(id: string): boolean {
    const now = Date.now();
    const memResult = this.db
      .prepare(
        `
      UPDATE user_memories
      SET status = 'deleted', updated_at = ?
      WHERE id = ?
    `,
      )
      .run(now, id);
    this.db
      .prepare(
        `
      UPDATE user_memory_sources
      SET is_active = 0
      WHERE memory_id = ?
    `,
      )
      .run(id);
    return memResult.changes > 0;
  }

  getUserMemoryStats(): GenWorkUserMemoryStats {
    const rows = this.getAll<{
      status: string;
      is_explicit: number;
      count: number;
    }>(`
      SELECT status, is_explicit, COUNT(*) AS count
      FROM user_memories
      GROUP BY status, is_explicit
    `);

    const stats: GenWorkUserMemoryStats = {
      total: 0,
      created: 0,
      stale: 0,
      deleted: 0,
      explicit: 0,
      implicit: 0,
    };

    for (const row of rows) {
      const count = Number(row.count) || 0;
      stats.total += count;
      if (row.status === 'created') stats.created += count;
      if (row.status === 'stale') stats.stale += count;
      if (row.status === 'deleted') stats.deleted += count;
      if (row.is_explicit) stats.explicit += count;
      else stats.implicit += count;
    }

    return stats;
  }

  autoDeleteNonPersonalMemories(): number {
    const rows = this.getAll<Pick<GenWorkUserMemoryRow, 'id' | 'text'>>(
      `SELECT id, text FROM user_memories WHERE status = 'created'`,
    );
    if (rows.length === 0) return 0;

    const now = Date.now();
    let deleted = 0;
    for (const row of rows) {
      if (!shouldAutoDeleteMemoryText(row.text)) {
        continue;
      }
      this.db
        .prepare(
          `
        UPDATE user_memories
        SET status = 'deleted', updated_at = ?
        WHERE id = ?
      `,
        )
        .run(now, row.id);
      this.db
        .prepare(
          `
        UPDATE user_memory_sources
        SET is_active = 0
        WHERE memory_id = ?
      `,
        )
        .run(row.id);
      deleted += 1;
    }

    return deleted;
  }

  markMemorySourcesInactiveBySession(sessionId: string): void {
    this.db
      .prepare(
        `
      UPDATE user_memory_sources
      SET is_active = 0
      WHERE session_id = ? AND is_active = 1
    `,
      )
      .run(sessionId);
  }

  markOrphanImplicitMemoriesStale(): void {
    const now = Date.now();
    this.db
      .prepare(
        `
      UPDATE user_memories
      SET status = 'stale', updated_at = ?
      WHERE is_explicit = 0
        AND status = 'created'
        AND NOT EXISTS (
          SELECT 1
          FROM user_memory_sources s
          WHERE s.memory_id = user_memories.id AND s.is_active = 1
        )
    `,
      )
      .run(now);
  }

  private getLatestMessageByType(sessionId: string, type: 'user' | 'assistant'): string {
    const row = this.getOne<{ content: string }>(
      `
      SELECT content
      FROM genwork_messages
      WHERE session_id = ? AND type = ?
      ORDER BY created_at DESC, ROWID DESC
      LIMIT 1
    `,
      [sessionId, type],
    );
    return truncate((row?.content || '').replace(/\s+/g, ' ').trim(), 280);
  }

  conversationSearch(options: {
    query: string;
    maxResults?: number;
    before?: string;
    after?: string;
  }): GenWorkConversationSearchRecord[] {
    const terms = extractConversationSearchTerms(options.query);
    if (terms.length === 0) return [];

    const maxResults = Math.max(1, Math.min(10, Math.floor(options.maxResults ?? 5)));
    const beforeMs = parseTimeToMs(options.before);
    const afterMs = parseTimeToMs(options.after);

    const likeClauses = terms.map(() => 'LOWER(m.content) LIKE ?');
    const clauses: string[] = ["m.type IN ('user', 'assistant')", `(${likeClauses.join(' OR ')})`];
    const params: Array<string | number> = terms.map(term => `%${term}%`);

    if (beforeMs !== null) {
      clauses.push('m.created_at < ?');
      params.push(beforeMs);
    }
    if (afterMs !== null) {
      clauses.push('m.created_at > ?');
      params.push(afterMs);
    }

    const rows = this.getAll<{
      session_id: string;
      title: string;
      updated_at: number;
      type: string;
      content: string;
      created_at: number;
    }>(
      `
      SELECT m.session_id, s.title, s.updated_at, m.type, m.content, m.created_at
      FROM genwork_messages m
      INNER JOIN genwork_sessions s ON s.id = m.session_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT ?
    `,
      [...params, maxResults * 40],
    );

    const bySession = new Map<string, GenWorkConversationSearchRecord>();
    for (const row of rows) {
      if (!row.session_id) continue;
      let current = bySession.get(row.session_id);
      if (!current) {
        current = {
          sessionId: row.session_id,
          title: row.title || 'Untitled',
          updatedAt: Number(row.updated_at) || 0,
          url: `https://claude.ai/chat/${row.session_id}`,
          human: '',
          assistant: '',
        };
        bySession.set(row.session_id, current);
      }

      const snippet = truncate((row.content || '').replace(/\s+/g, ' ').trim(), 280);
      if (row.type === 'user' && !current.human) {
        current.human = snippet;
      }
      if (row.type === 'assistant' && !current.assistant) {
        current.assistant = snippet;
      }

      if (bySession.size >= maxResults) {
        const complete = Array.from(bySession.values()).every(
          entry => entry.human && entry.assistant,
        );
        if (complete) break;
      }
    }

    const records = Array.from(bySession.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxResults)
      .map(entry => ({
        ...entry,
        human: entry.human || this.getLatestMessageByType(entry.sessionId, 'user'),
        assistant: entry.assistant || this.getLatestMessageByType(entry.sessionId, 'assistant'),
      }));

    return records;
  }

  recentChats(options: {
    n?: number;
    sortOrder?: 'asc' | 'desc';
    before?: string;
    after?: string;
  }): GenWorkConversationSearchRecord[] {
    const n = Math.max(1, Math.min(20, Math.floor(options.n ?? 3)));
    const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';
    const beforeMs = parseTimeToMs(options.before);
    const afterMs = parseTimeToMs(options.after);

    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (beforeMs !== null) {
      clauses.push('updated_at < ?');
      params.push(beforeMs);
    }
    if (afterMs !== null) {
      clauses.push('updated_at > ?');
      params.push(afterMs);
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.getAll<{
      id: string;
      title: string;
      updated_at: number;
    }>(
      `
      SELECT id, title, updated_at
      FROM genwork_sessions
      ${whereClause}
      ORDER BY updated_at ${sortOrder.toUpperCase()}
      LIMIT ?
    `,
      [...params, n],
    );

    return rows.map(row => ({
      sessionId: row.id,
      title: row.title || 'Untitled',
      updatedAt: Number(row.updated_at) || 0,
      url: `https://claude.ai/chat/${row.id}`,
      human: this.getLatestMessageByType(row.id, 'user'),
      assistant: this.getLatestMessageByType(row.id, 'assistant'),
    }));
  }

  // ========== Agent CRUD ==========

  listAgents(): Agent[] {
    interface AgentRow {
      id: string;
      name: string;
      description: string;
      system_prompt: string;
      identity: string;
      model: string;
      thinking_level?: string | null;
      working_directory?: string | null;
      icon: string;
      skill_ids: string;
      subagent_allow_agent_ids?: string | null;
      enabled: number;
      pinned?: number | null;
      pin_order?: number | null;
      sort_order?: number | null;
      is_default: number;
      source: string;
      preset_id: string;
      enterprise_agent_id?: string | null;
      created_at: number;
      updated_at: number;
    }

    const rows = this.getAll<AgentRow>(`
      SELECT * FROM agents
      ORDER BY COALESCE(sort_order, 2147483647) ASC, is_default DESC, created_at ASC
    `);

    return rows.map(row => this.mapAgentRow(row));
  }

  getAgent(id: string): Agent | null {
    interface AgentRow {
      id: string;
      name: string;
      description: string;
      system_prompt: string;
      identity: string;
      model: string;
      thinking_level?: string | null;
      working_directory?: string | null;
      icon: string;
      skill_ids: string;
      subagent_allow_agent_ids?: string | null;
      enabled: number;
      pinned?: number | null;
      pin_order?: number | null;
      sort_order?: number | null;
      is_default: number;
      source: string;
      preset_id: string;
      enterprise_agent_id?: string | null;
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<AgentRow>(`SELECT * FROM agents WHERE id = ?`, [id]);
    if (!row) return null;
    return this.mapAgentRow(row);
  }

  createAgent(request: CreateAgentRequest): Agent {
    const id =
      request.id ||
      request.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') ||
      uuidv4();
    const now = Date.now();

    // Ensure no duplicate ID
    const existing = this.getAgent(id);
    if (existing) {
      // Append timestamp to make unique
      return this.createAgent({ ...request, id: `${id}-${Date.now()}` });
    }

    let removedOrphanSessionCount = 0;
    const createAgent = this.db.transaction(() => {
      removedOrphanSessionCount = this.deleteSessionsForAgent(id).length;

      this.db
        .prepare(
          `
        INSERT INTO agents (id, name, description, system_prompt, identity, about_you, model, thinking_level, working_directory, icon, skill_ids, subagent_allow_agent_ids, server_skill_ids, server_subagent_allow_agent_ids, server_im_channels, enabled, is_default, source, preset_id, enterprise_agent_id, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          request.name,
          request.description || '',
          request.systemPrompt || '',
          request.identity || '',
          request.aboutYou || '',
          request.model || '',
          normalizeAgentThinkingLevel(request.thinkingLevel),
          request.workingDirectory || '',
          normalizeAgentAvatarIcon(request.icon),
          JSON.stringify(normalizeStringIdList(request.skillIds)),
          JSON.stringify(normalizeStringIdList(request.subagentAllowAgentIds)),
          JSON.stringify(normalizeStringIdList(request.serverSkillIds)),
          JSON.stringify(normalizeStringIdList(request.serverSubagentAllowAgentIds)),
          JSON.stringify(normalizeStringIdList(request.serverImChannels)),
          request.source || 'custom',
          request.presetId || '',
          request.enterpriseAgentId ?? null,
          this.getNextAgentSortOrder(),
          now,
          now,
        );
    });
    createAgent();
    if (removedOrphanSessionCount > 0) {
      this.markOrphanImplicitMemoriesStale();
    }

    return this.getAgent(id)!;
  }

  backfillEmptyAgentModels(modelId: string): number {
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId) return 0;

    const result = this.db
      .prepare("UPDATE agents SET model = ?, updated_at = ? WHERE TRIM(COALESCE(model, '')) = ''")
      .run(normalizedModelId, Date.now());

    return result.changes;
  }

  updateAgent(id: string, updates: UpdateAgentRequest, opts?: { bypassEnterpriseGuard?: boolean }): Agent | null {
    const existing = this.getAgent(id);
    if (!existing) return null;

    // Enterprise rows mirror a server-owned agent: the scalar fields owned by
    // the server are immutable locally. Local-only overlays (working directory,
    // skills, subagent allows, pin/enabled/sort) remain updatable. The sync
    // engine is the authoritative mirror of the server and writes with
    // `bypassEnterpriseGuard` so server edits to scalars apply on resync.
    const guarded = existing.source === 'enterprise' && !opts?.bypassEnterpriseGuard;

    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [now];

    if (!guarded && updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
    }
    if (!guarded && updates.description !== undefined) {
      setClauses.push('description = ?');
      values.push(updates.description);
    }
    if (!guarded && updates.systemPrompt !== undefined) {
      setClauses.push('system_prompt = ?');
      values.push(updates.systemPrompt);
    }
    if (!guarded && updates.identity !== undefined) {
      setClauses.push('identity = ?');
      values.push(updates.identity);
    }
    if (!guarded && updates.aboutYou !== undefined) {
      setClauses.push('about_you = ?');
      values.push(updates.aboutYou);
    }
    if (!guarded && updates.model !== undefined) {
      setClauses.push('model = ?');
      values.push(updates.model);
    }
    if (!guarded && updates.thinkingLevel !== undefined) {
      setClauses.push('thinking_level = ?');
      values.push(normalizeAgentThinkingLevel(updates.thinkingLevel));
    }
    if (updates.workingDirectory !== undefined) {
      setClauses.push('working_directory = ?');
      values.push(updates.workingDirectory);
    }
    if (!guarded && updates.icon !== undefined) {
      setClauses.push('icon = ?');
      values.push(normalizeAgentAvatarIcon(updates.icon));
    }
    if (updates.skillIds !== undefined) {
      setClauses.push('skill_ids = ?');
      values.push(JSON.stringify(normalizeStringIdList(updates.skillIds)));
    }
    if (updates.subagentAllowAgentIds !== undefined) {
      setClauses.push('subagent_allow_agent_ids = ?');
      values.push(JSON.stringify(normalizeStringIdList(updates.subagentAllowAgentIds)));
    }
    if (updates.serverSkillIds !== undefined) {
      setClauses.push('server_skill_ids = ?');
      values.push(JSON.stringify(normalizeStringIdList(updates.serverSkillIds)));
    }
    if (updates.serverSubagentAllowAgentIds !== undefined) {
      setClauses.push('server_subagent_allow_agent_ids = ?');
      values.push(JSON.stringify(normalizeStringIdList(updates.serverSubagentAllowAgentIds)));
    }
    if (updates.serverImChannels !== undefined) {
      setClauses.push('server_im_channels = ?');
      values.push(JSON.stringify(normalizeStringIdList(updates.serverImChannels)));
    }
    if (updates.enabled !== undefined) {
      setClauses.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.pinned !== undefined) {
      setClauses.push('pinned = ?');
      values.push(updates.pinned ? 1 : 0);
      if (updates.pinned) {
        const currentPinOrder = existing.pinOrder ?? null;
        const nextPinOrder = currentPinOrder ?? this.getNextAgentPinOrder();
        setClauses.push('pin_order = ?');
        values.push(nextPinOrder);
      } else {
        setClauses.push('pin_order = NULL');
      }
    }
    if (updates.sortOrder !== undefined) {
      setClauses.push('sort_order = ?');
      values.push(updates.sortOrder);
    }

    values.push(id);
    this.db.prepare(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    return this.getAgent(id);
  }

  reorderAgents(agentIds: string[]): Agent[] {
    const normalizedIds = Array.from(new Set(agentIds.map(id => id.trim()).filter(Boolean)));
    if (normalizedIds.length === 0) return this.listAgents();

    const existingAgents = this.listAgents();
    const existingIds = new Set(existingAgents.map(agent => agent.id));
    const orderedIds = normalizedIds.filter(id => existingIds.has(id));
    if (orderedIds.length === 0) return this.listAgents();
    const orderedIdSet = new Set(orderedIds);
    const finalIds = [
      ...orderedIds,
      ...existingAgents
        .map(agent => agent.id)
        .filter(id => !orderedIdSet.has(id)),
    ];

    const now = Date.now();
    const updateSortOrder = this.db.prepare('UPDATE agents SET sort_order = ?, updated_at = ? WHERE id = ?');
    const reorder = this.db.transaction((ids: string[]) => {
      ids.forEach((id, index) => {
        updateSortOrder.run(index + 1, now, id);
      });
    });
    reorder(finalIds);
    return this.listAgents();
  }

  deleteAgent(id: string, opts?: { bypassEnterpriseGuard?: boolean }): boolean {
    if (id === AgentId.Main) return false; // Cannot delete default agent
    // Enterprise rows mirror server-owned agents and cannot be deleted locally.
    // The sync engine is the authoritative mirror and deletes with
    // `bypassEnterpriseGuard` when the server removes the agent.
    const row = this.getAgent(id);
    if (row && row.source === 'enterprise' && !opts?.bypassEnterpriseGuard) return false;

    const deleteAgent = this.db.transaction((agentId: string): boolean => {
      const result = this.db.prepare('DELETE FROM agents WHERE id = ? AND is_default = 0').run(agentId);
      if (result.changes === 0) {
        return false;
      }

      this.deleteSessionsForAgent(agentId);
      return true;
    });

    const deleted = deleteAgent(id);
    if (deleted) {
      this.markOrphanImplicitMemoriesStale();
    }
    return deleted;
  }

  private mapAgentRow(row: {
    id: string;
    name: string;
    description: string;
    system_prompt: string;
    identity: string;
    about_you?: string | null;
    model: string;
    thinking_level?: string | null;
    working_directory?: string | null;
    icon: string;
    skill_ids: string;
    subagent_allow_agent_ids?: string | null;
    server_skill_ids?: string | null;
    server_subagent_allow_agent_ids?: string | null;
    server_im_channels?: string | null;
    enabled: number;
    pinned?: number | null;
    pin_order?: number | null;
    sort_order?: number | null;
    is_default: number;
    source: string;
    preset_id: string;
    enterprise_agent_id?: string | null;
    created_at: number;
    updated_at: number;
  }): Agent {
    const skillIds = parseStringIdList(row.skill_ids);
    const subagentAllowAgentIds = parseStringIdList(row.subagent_allow_agent_ids);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      systemPrompt: row.system_prompt,
      identity: row.identity,
      aboutYou: row.about_you ?? '',
      model: row.model,
      thinkingLevel: parseModelThinkingLevel(row.thinking_level) ?? '',
      workingDirectory: row.working_directory || '',
      icon: row.icon,
      skillIds,
      subagentAllowAgentIds,
      serverSkillIds: parseStringIdList(row.server_skill_ids),
      serverSubagentAllowAgentIds: parseStringIdList(row.server_subagent_allow_agent_ids),
      serverImChannels: parseStringIdList(row.server_im_channels),
      enabled: Boolean(row.enabled),
      pinned: Boolean(row.pinned),
      pinOrder: row.pinned ? (row.pin_order ?? null) : null,
      sortOrder: row.sort_order ?? null,
      isDefault: Boolean(row.is_default),
      source: row.source as AgentSource,
      presetId: row.preset_id,
      enterpriseAgentId: row.enterprise_agent_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getSessionIdByOpenclawSessionId(openclawSessionId: string): string | null {
    const normalized = openclawSessionId.trim();
    if (!normalized) return null;
    const row = this.getOne<{ id: string }>(
      'SELECT id FROM genwork_sessions WHERE openclaw_session_id = ? LIMIT 1',
      [normalized],
    );
    return row?.id ?? null;
  }

  getSessionIdByScheduledTaskId(scheduledTaskId: string, agentId: string): string | null {
    const normalizedTaskId = scheduledTaskId.trim();
    const normalizedAgentId = agentId.trim() || AgentId.Main;
    if (!normalizedTaskId) return null;

    const row = this.getOne<{ id: string }>(
      `SELECT id
       FROM genwork_sessions
       WHERE scheduled_task_id = ?
         AND parent_session_id IS NULL
         AND COALESCE(NULLIF(TRIM(agent_id), ''), ?) = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [normalizedTaskId, AgentId.Main, normalizedAgentId],
    );
    return row?.id ?? null;
  }

  upsertSubagentChildSession(options: UpsertSubagentChildSessionOptions): GenWorkSession {
    const existing = this.getSession(options.id, 0);
    const parent = this.getSession(options.parentSessionId, 0);
    const agent = this.getAgent(options.agentId);
    const now = Date.now();
    const createdAt = options.createdAt ?? existing?.createdAt ?? now;
    const title = options.title.trim() || agent?.name || options.agentId;
    const cwd = parent?.cwd || agent?.workingDirectory || '';
    const systemPrompt = agent?.systemPrompt || '';
    const modelOverride = existing?.modelOverride || '';
    const executionMode = parent?.executionMode || 'local';
    const activeSkillIds = agent?.skillIds ?? [];
    const status = options.status ?? 'running';

    if (existing) {
      this.db
        .prepare(
          `
          UPDATE genwork_sessions
          SET title = ?,
              openclaw_session_id = ?,
              status = ?,
              cwd = ?,
              system_prompt = ?,
              model_override = ?,
              execution_mode = ?,
              active_skill_ids = ?,
              agent_id = ?,
              parent_session_id = ?,
              updated_at = ?
          WHERE id = ?
        `,
        )
        .run(
          title,
          options.childSessionKey,
          status,
          cwd,
          systemPrompt,
          modelOverride,
          executionMode,
          JSON.stringify(activeSkillIds),
          options.agentId,
          options.parentSessionId,
          now,
          options.id,
        );
    } else {
      this.db
        .prepare(
          `
          INSERT INTO genwork_sessions (
            id, title, openclaw_session_id, status, cwd, system_prompt, model_override,
            execution_mode, active_skill_ids, agent_id, pinned, pin_order,
            parent_session_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
        `,
        )
        .run(
          options.id,
          title,
          options.childSessionKey,
          status,
          cwd,
          systemPrompt,
          modelOverride,
          executionMode,
          JSON.stringify(activeSkillIds),
          options.agentId,
          options.parentSessionId,
          createdAt,
          now,
        );
    }

    const session = this.getSession(options.id, 0);
    if (!session) {
      throw new Error(`Subagent child session ${options.id} could not be loaded`);
    }
    return session;
  }

  private getNextAgentPinOrder(): number {
    const row = this.getOne<{ max_order: number | null }>(
      'SELECT MAX(pin_order) as max_order FROM agents WHERE pinned = 1',
    );
    return (row?.max_order ?? 0) + 1;
  }

  private getNextAgentSortOrder(): number {
    const row = this.getOne<{ max_order: number | null }>(
      'SELECT MAX(sort_order) as max_order FROM agents',
    );
    return (row?.max_order ?? 0) + 1;
  }

  // ─── User Plugins ───────────────────────────────────────────────────

  listUserPlugins(): UserInstalledPlugin[] {
    const rows = this.getAll<{
      plugin_id: string;
      source: string;
      spec: string;
      registry: string | null;
      version: string | null;
      enabled: number;
      installed_at: number;
      config: string | null;
    }>('SELECT * FROM user_plugins ORDER BY installed_at ASC');

    return rows.map(row => ({
      pluginId: row.plugin_id,
      source: row.source as PluginSource,
      spec: row.spec,
      registry: row.registry || undefined,
      version: row.version || undefined,
      enabled: Boolean(row.enabled),
      installedAt: row.installed_at,
      config: row.config ? JSON.parse(row.config) as Record<string, unknown> : undefined,
    }));
  }

  addUserPlugin(plugin: UserInstalledPlugin): void {
    this.db.prepare(
      `INSERT INTO user_plugins (plugin_id, source, spec, registry, version, enabled, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plugin_id) DO UPDATE SET
         source = excluded.source,
         spec = excluded.spec,
         registry = excluded.registry,
         version = excluded.version,
         enabled = excluded.enabled,
         installed_at = excluded.installed_at`,
    ).run(
      plugin.pluginId,
      plugin.source,
      plugin.spec,
      plugin.registry || null,
      plugin.version || null,
      plugin.enabled ? 1 : 0,
      plugin.installedAt,
    );
  }

  removeUserPlugin(pluginId: string): void {
    this.db.prepare('DELETE FROM user_plugins WHERE plugin_id = ?').run(pluginId);
  }

  setUserPluginEnabled(pluginId: string, enabled: boolean): void {
    this.db.prepare('UPDATE user_plugins SET enabled = ? WHERE plugin_id = ?')
      .run(enabled ? 1 : 0, pluginId);
  }

  getUserPluginConfig(pluginId: string): Record<string, unknown> | null {
    const row = this.getOne<{ config: string | null }>(
      'SELECT config FROM user_plugins WHERE plugin_id = ?', [pluginId],
    );
    if (!row?.config) return null;
    try {
      return JSON.parse(row.config) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  setUserPluginConfig(pluginId: string, config: Record<string, unknown>): void {
    this.db.prepare('UPDATE user_plugins SET config = ? WHERE plugin_id = ?')
      .run(JSON.stringify(config), pluginId);
  }

  getUserPlugin(pluginId: string): UserInstalledPlugin | undefined {
    const row = this.getOne<{
      plugin_id: string;
      source: string;
      spec: string;
      registry: string | null;
      version: string | null;
      enabled: number;
      installed_at: number;
      config: string | null;
    }>('SELECT * FROM user_plugins WHERE plugin_id = ?', [pluginId]);

    if (!row) return undefined;
    return {
      pluginId: row.plugin_id,
      source: row.source as PluginSource,
      spec: row.spec,
      registry: row.registry || undefined,
      version: row.version || undefined,
      enabled: Boolean(row.enabled),
      installedAt: row.installed_at,
      config: row.config ? JSON.parse(row.config) as Record<string, unknown> : undefined,
    };
  }
}
