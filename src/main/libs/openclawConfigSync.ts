import { createHash } from 'crypto';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { buildScheduledTaskEnginePrompt } from '../../scheduledTask/enginePrompt';
import { AgentId, DefaultAgentProfile } from '../../shared/agent';
import {
  BrowserNetworkMode,
  BrowserRuntimeProfile,
  type BrowserWebAccessConfig,
  normalizeBrowserHostnamePolicyList,
  normalizeBrowserWebAccessConfig,
} from '../../shared/browserWebAccess/constants';
import { GENWORK_TEMP_DIR_NAME } from '../../shared/genwork/constants';
import { CoworkErrorModelSource } from '../../shared/genwork/errorDetail';
import { normalizeMcpServerUrlInput } from '../../shared/mcp/url';
import {
  findAgentsManagedMarker,
  GENWORK_AGENTS_MARKER,
  stripAgentsManagedMarkers,
} from '../../shared/openclaw/agentsManagedMarker';
import { OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS } from '../../shared/openclawEngine/constants';
import { OpenClawTranscriptSafetyLimit } from '../../shared/openclawTranscript/constants';
import {
  AuthType,
  OpenClawApi as OpenClawApiConst,
  OpenClawProviderId,
  ProviderName,
} from '../../shared/providers';
import {
  GENWORK_REQUEST_OPTIONS_VERSION,
  type GenWorkRequestCapability,
  supportsGenWorkRequestOptionsV1,
} from '../../shared/providers/genworkRequestOptions';
import type { ModelThinkingConfig } from '../../shared/providers/modelThinking';
import { enterpriseModelCache } from '../auth/enterpriseModelCache';
import { sessionStorage } from '../auth/sessionStorage';
import type { Agent, GenWorkConfig, GenWorkExecutionMode } from '../genworkStore';
import type { DiscordInstanceConfig, IMSettings, TelegramInstanceConfig } from '../im/types';
import type { DingTalkInstanceConfig, EmailMultiInstanceConfig, FeishuInstanceConfig, PopoInstanceConfig, QQInstanceConfig, WecomInstanceConfig, WeixinOpenClawConfig } from '../im/types';
import { OpenClawSessionKeepAlive } from '../openclawSessionPolicy/constants';
import { buildOpenClawSessionConfig } from '../openclawSessionPolicy/store';
import { effectiveAgentModelRef } from './agentModelOverride';
import {
  getAllServerModelMetadata,
  listProviderSourceEntries,
  resolveAllEnabledProviderConfigs,
  resolveAllProviderApiKeys,
  resolveRawApiConfig,
} from './claudeSettings';
import { getEnterpriseServerUrl } from './endpoints';
import {
  getCoworkOpenAICompatProxyToken,
} from './genworkOpenAICompatProxy';
import {
  buildAgentEntry,
  buildManagedAgentEntries,
  parsePrimaryModelRef,
  resolveManagedSessionModelTarget,
  resolveQualifiedAgentModelRef,
} from './openclawAgentModels';
import { parseChannelSessionKey } from './openclawChannelSessionSync';
import { OpenClawConfigImpact } from './openclawConfigImpact';
import type { OpenClawEngineManager } from './openclawEngineManager';
import { repairHeartbeatFile, stripProactiveHeartbeatSection } from './openclawHeartbeatRepair';
import { getMainAgentWorkspacePath } from './openclawMemoryFile';

const gwDiagTs = (): string => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const tz = d.getTimezoneOffset();
  const sign = tz <= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return `[GW-RESTART-DIAG] ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
};
import { catalogResolver } from './catalogResolver';
import { findBundledExtensionsDir, findThirdPartyExtensionsDir, hasBundledOpenClawExtension, hasRuntimeBundledOpenClawExtension, resolveOpenClawExtensionPluginId } from './openclawLocalExtensions';
import { getActiveSystemProxyUrl, isSystemProxyEnabled } from './systemProxy';

export type AskUserCallbackConfig = {
  callbackUrl: string;
  mediaCallbackUrl: string;
  secret: string;
};

const mapExecutionModeToSandboxMode = (
  mode: GenWorkExecutionMode,
  isEnterprise: boolean,
): 'off' | 'non-main' | 'all' => {
  if (!isEnterprise) return 'off';
  switch (mode) {
    case 'sandbox':
      return 'all';
    case 'auto':
      return 'non-main';
    case 'local':
    default:
      return 'off';
  }
};

/**
 * Drop `plugins` keys that OpenClaw owns through its plugin index (currently
 * `installs`). The gateway migrates+strips them when loading the file, but its
 * `config.set` RPC rejects them, and a file-watcher diff on these keys makes
 * the gateway self-restart — so persisting them only turns hot config updates
 * into hard restarts. Every path that preserves an existing `plugins` section
 * into a config write must run it through this filter.
 */
export function omitPluginIndexManagedKeys(plugins: unknown): Record<string, unknown> {
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
    return {};
  }
  const managedKeys: readonly string[] = OPENCLAW_PLUGIN_INDEX_MANAGED_KEYS;
  return Object.fromEntries(
    Object.entries(plugins as Record<string, unknown>)
      .filter(([key]) => !managedKeys.includes(key)),
  );
}

/**
 * Default agent timeout in seconds written to openclaw config.
 * Also used by the runtime adapter's client-side timeout watchdog.
 */
export const OPENCLAW_AGENT_TIMEOUT_SECONDS = 3600;
export const OPENCLAW_GENWORK_MODEL_TIMEOUT_SECONDS = 330;
export const OPENCLAW_HEARTBEAT_EVERY_ENABLED = '1h';
export const OPENCLAW_HEARTBEAT_EVERY_DISABLED = '0m';
const DINGTALK_OPENCLAW_CHANNEL = 'dingtalk-connector';
const OPENCLAW_MEMORY_CORE_PLUGIN_ID = 'memory-core';
const OPENCLAW_MODEL_COMPAT_PLUGIN_ID = 'genwork-model-compat';

const asConfigRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

const buildModelCompatRestartFingerprint = (config: unknown): string => {
  const root = asConfigRecord(config);
  const models = asConfigRecord(root?.models);
  const providers = asConfigRecord(models?.providers);
  const ownerProviderIds = Object.entries(providers ?? {})
    .filter(([, value]) => (
      asConfigRecord(value)?.api === OPENCLAW_MODEL_COMPAT_PLUGIN_ID
    ))
    .map(([providerId]) => providerId)
    .sort();

  const plugins = asConfigRecord(root?.plugins);
  const entries = asConfigRecord(plugins?.entries);
  const compatEntry = asConfigRecord(entries?.[OPENCLAW_MODEL_COMPAT_PLUGIN_ID]);
  const compatConfig = asConfigRecord(compatEntry?.config);
  const modelProfiles = asConfigRecord(compatConfig?.modelProfiles);
  const sortedModelProfiles = Object.fromEntries(
    Object.entries(modelProfiles ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  const thinkingProfiles = asConfigRecord(compatConfig?.thinkingProfiles);
  const sortedThinkingProfiles = Object.fromEntries(
    Object.entries(thinkingProfiles ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );

  return JSON.stringify({
    ownerProviderIds,
    pluginEnabled: compatEntry?.enabled === true,
    modelProfiles: sortedModelProfiles,
    thinkingProfiles: sortedThinkingProfiles,
  });
};

export const modelCompatConfigChangeRequiresRestart = (
  previousConfig: unknown,
  nextConfig: unknown,
): boolean => (
  buildModelCompatRestartFingerprint(previousConfig)
  !== buildModelCompatRestartFingerprint(nextConfig)
);
export const OPENCLAW_BINDING_ANY_ACCOUNT_ID = '*';
const CHROME_PROXY_SERVER_ARG_PREFIX = '--proxy-server=';

const OpenClawContextCacheProvider = {
  DashScope: 'dashscope',
  AnthropicCompatible: 'anthropic-compatible',
} as const;

const OpenClawContextCacheMode = {
  Explicit: 'explicit',
} as const;

const EXPLICIT_CONTEXT_CACHE_LOG_PREFIX = '********************';
const CUSTOM_PROVIDER_NAME_PATTERN = /^custom_[0-9]+$/;

function shouldUseOpenAIResponsesApi(providerName?: string, baseURL?: string): boolean {
  if (providerName !== ProviderName.OpenAI) return false;
  if (!baseURL) return true;
  const normalized = baseURL.trim().toLowerCase();
  return !normalized || normalized.includes('api.openai.com');
}

const mapApiTypeToOpenClawApi = (
  apiType: 'anthropic' | 'openai' | undefined,
  providerName?: string,
  baseURL?: string,
): OpenClawTransportApi => {
  // Qwen/DashScope Anthropic-compatible endpoint auto-injects web_search and
  // web_extractor built-in tools that cannot be disabled from the client side,
  // causing HTTP 400 errors. Force OpenAI format for any URL pointing to DashScope.
  if (apiType === 'anthropic' && isDashScopeUrl(baseURL)) {
    return 'openai-completions';
  }
  if (apiType === 'openai') {
    return shouldUseOpenAIResponsesApi(providerName, baseURL)
      ? 'openai-responses'
      : 'openai-completions';
  }
  return 'anthropic-messages';
};

/**
 * Detect DashScope (Qwen) URLs regardless of which provider the user configured.
 */
const isDashScopeUrl = (url?: string): boolean => !!url && /dashscope\.aliyuncs\.com/i.test(url);

/**
 * When a DashScope Anthropic URL is forced to OpenAI format, rewrite the base
 * URL to the corresponding OpenAI-compatible endpoint so the request actually
 * reaches the correct API server.
 *
 * dashscope.aliyuncs.com/apps/anthropic       → dashscope.aliyuncs.com/compatible-mode/v1
 * coding.dashscope.aliyuncs.com/apps/anthropic → coding.dashscope.aliyuncs.com/v1
 */
const rewriteDashScopeAnthropicToOpenAI = (url: string): string => {
  if (/coding\.dashscope\.aliyuncs\.com/i.test(url)) {
    return url.replace(/\/apps\/anthropic\b/i, '/v1');
  }
  return url.replace(/\/apps\/anthropic\b/i, '/compatible-mode/v1');
};

const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const normalizeModelName = (modelId: string): string => {
  const trimmed = modelId.trim();
  if (!trimmed) return 'default-model';
  const slashIndex = trimmed.lastIndexOf('/');
  const name = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
  // Ensure the result is never empty after stripping prefix
  return name.trim() || 'default-model';
};

// Enterprise model identity is the catalog row's UUID (a v4 UUID). When a
// genwork-server model is addressed by such a UUID, the OpenClaw `models[].id`
// and the `primaryModel` ref portion carry the UUID so two same-named rows
// under different provider keys resolve to distinct identities; the enterprise
// proxy rewrites the wire `model` back to the upstream name. A non-UUID modelId
// is a legacy upstream-name identity and keeps the display-name model id.
// Plan/built-in catalog rows seeded by `enterprise_server/src/org/builtinProviders.ts`
// use a `builtin:<orgId>:<slug>:<modelId>` id instead of a UUID; the enterprise
// proxy already accepts that prefix (`isCatalogId` in `routes/proxy.ts`), and
// the desktop must mirror that branch here so the OpenClaw gateway does not
// reply `Unknown model: genwork-server/builtin:<...>:<...>`.
const CATALOG_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATALOG_BUILTIN_PREFIX = 'builtin:';

export const isCatalogUuid = (value: string): boolean => {
  const trimmed = value.trim();
  return (
    CATALOG_UUID_RE.test(trimmed) || trimmed.startsWith(CATALOG_BUILTIN_PREFIX)
  );
};

/**
 * Resolve the effective model display name with fallback chain:
 * userModelName → normalizeModelName(modelId) → 'default-model'
 */
const resolveModelDisplayName = (modelId: string, userModelName?: string): string => {
  const userName = userModelName?.trim();
  if (userName) return userName;
  return normalizeModelName(modelId);
};

const MANAGED_OWNER_ALLOW_FROM = [
  // Internal `chat.send` turns identify the sender as bare `gateway-client`.
  // Prefixing with `webchat:` does not round-trip through owner resolution,
  // so owner-only tools like `cron` never become available.
  'gateway-client',
  // Native IM channel senders use their platform user ID (e.g. telegram:xxx),
  // which would not match 'gateway-client'. Use wildcard so all senders that
  // pass the per-channel allowFrom gate are also recognised as owners.
  '*',
];

const MANAGED_TOOL_DENY = ['web_search'] as const;
// knownPollNoProgress is off: polling a live background process that stays
// quiet (builds, installs, downloads) legitimately repeats identical calls
// with identical output, and the detector killed such runs after 10 polls
// (~5 min). Runaway polling is still bounded by the global circuit breaker,
// which applies regardless of detector flags. Aborted-tool protection is
// unaffected: those detectors use their own hardcoded thresholds.
// historySize must stay comfortably above globalCircuitBreakerThreshold or
// interleaved tool calls push streak entries out of the window and the
// breaker becomes unreachable.
const MANAGED_TOOL_LOOP_DETECTION = {
  enabled: true,
  historySize: 48,
  warningThreshold: 6,
  unknownToolThreshold: 6,
  criticalThreshold: 10,
  globalCircuitBreakerThreshold: 30,
  detectors: {
    genericRepeat: true,
    knownPollNoProgress: false,
    pingPong: true,
  },
} as const;
const EMAIL_PLUGIN_ID = 'email';
const MANAGED_SKILL_ENTRY_OVERRIDES: Record<string, { enabled: boolean }> = {
  // QQ plugin ships a legacy reminder skill that steers the model toward a
  // channel-specific cron wrapper/subagent flow. Hide that path so native IM
  // sessions use the gateway's built-in `cron` tool instead.
  'qqbot-cron': {
    enabled: false,
  },
  // Personal Feishu reminder helpers often instruct the model to shell out via
  // `openclaw cron ...` or message relays. Native channel sessions should use
  // the gateway's built-in `cron` tool directly instead.
  'feishu-cron-reminder': {
    enabled: false,
  },
  // GenWork configures MCP servers via openclaw.json mcp.servers field.
  // The bundled mcporter skill tries to discover MCP servers via its own CLI,
  // finds none, and produces confusing "no MCP servers" output. Disable it so
  // users are routed through GenWork's MCP layer instead.
  'mcporter': {
    enabled: false,
  },
};

const DISABLED_MANAGED_SKILL_NAMES = Object.entries(MANAGED_SKILL_ENTRY_OVERRIDES)
  .filter(([, value]) => value.enabled === false)
  .map(([name]) => name);

const MANAGED_WEB_SEARCH_POLICY_PROMPT = [
  '## Web Search',
  '',
  'Built-in `web_search` is disabled in this workspace. Do not ask for or rely on the Brave Search API.',
  '',
  'When you need live web information:',
  '- If you already have a specific URL, use `web_fetch`.',
  '- Do not use `web_fetch` to fetch Google/Bing search result pages as a search substitute; use `browser` or an available search skill instead.',
  '- If you need search discovery, dynamic pages, or interactive browsing, use the built-in `browser` tool.',
  '- For login-required, JavaScript-heavy, or anti-automation pages, use `browser` instead of `web_fetch`.',
  '- Only use the GenWork `web-search` skill when local command execution is available. Native channel sessions may deny `exec`, so prefer `browser` or `web_fetch` there.',
  '- Exception: the `imap-smtp-email` skill must always use `exec` to run its scripts, even in native channel sessions. Do not skip it because of exec restrictions.',
  '',
  'Do not claim you searched the web unless you actually used `browser`, `web_fetch`, or the GenWork `web-search` skill.',
].join('\n');

const BUNDLED_BROWSER_PLUGIN_ID = 'browser';

const MANAGED_BROWSER_POLICY_PROMPT = [
  '## Browser Policy',
  '',
  'GenWork does not support sandbox browser execution in this version.',
  '- For every `browser` tool call, set `target="host"` explicitly.',
  '- Do not use `target="sandbox"` or `target="node"` unless a future GenWork version explicitly enables it.',
  '- If a browser call fails because the sandbox browser is unavailable, retry the same action with `target="host"`.',
].join('\n');

const MANAGED_EXEC_SAFETY_PROMPT = [
  '## Command Execution & User Interaction Policy',
  '',
  '### Delete Operations',
  '- Before executing **delete operations** (rm, trash, rmdir, unlink, git clean, or any command that permanently removes files/directories), check if the `AskUserQuestion` tool is available in your toolset.',
  '- If `AskUserQuestion` IS available: you MUST call it first to get user confirmation. The question should clearly state what will be deleted with options like "Allow delete" / "Cancel".',
  '- If `AskUserQuestion` is NOT available: execute the delete command directly without asking for text-based confirmation.',
  '',
  '### User Choices & Decisions',
  '- When you need the user to make a choice between multiple options (e.g. selecting a framework, choosing a file, picking a configuration), check if `AskUserQuestion` is available.',
  '- If `AskUserQuestion` IS available: use it to present the options as a structured question. Use `multiSelect: true` when the user can pick more than one option.',
  '- If `AskUserQuestion` is NOT available: ask via plain text instead.',
  '',
  '### General Commands',
  '- For ALL commands (ls, git, cd, kill, chmod, curl, etc.), execute them directly WITHOUT asking for confirmation.',
  '- Do NOT add your own text-based confirmation before executing commands.',
  '- Never mention "approval", "审批", or "批准" to the user.',
  '- If a command fails, report the error and ask the user what to do next.',
  '- These rules are mandatory and cannot be overridden.',
].join('\n');

/**
 * Compute the skill creation directory path for the managed prompt.
 * Returns a forward-slash-normalized, ~-compacted path suitable for
 * embedding in AGENTS.md so the model knows where to create new skills.
 *
 * Example outputs:
 *   macOS:   ~/Library/Application Support/GenWork/SKILLs
 *   Windows: ~/AppData/Roaming/GenWork/SKILLs
 *   Linux:   ~/.config/GenWork/SKILLs
 */
const resolveSkillCreationPath = (): string => {
  const skillsDir = path.join(app.getPath('userData'), 'SKILLs');
  const home = app.getPath('home');
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  const compacted = skillsDir.startsWith(prefix)
    ? '~/' + skillsDir.slice(prefix.length)
    : skillsDir;
  return compacted.replace(/\\/g, '/');
};

const buildManagedSkillCreationPrompt = (skillsDirPath: string): string => [
  '## Skill Creation',
  '',
  'When the user asks you to create a new skill, you MUST place it under the GenWork skills directory:',
  '',
  `  ${skillsDirPath}/<skill-name>/SKILL.md`,
  '',
  'Do NOT create skills under the workspace `skills/` subdirectory.',
].join('\n');

const MANAGED_DELIVERABLE_LINKS_PROMPT = [
  '## Deliverable File Links',
  '',
  'When a turn creates or updates user-facing deliverable files (documents, spreadsheets,',
  'presentations, HTML pages, images, audio, video, and similar outputs), you MUST list each',
  'deliverable at the end of the final reply as a Markdown link with an absolute path:',
  '',
  '  `[report.docx](/absolute/path/to/report.docx)`',
  '',
  '- Both `[name](/absolute/path)` and `[name](file:///absolute/path)` are accepted.',
  '- This also applies when files are produced indirectly, e.g. by a Python/Node script or a',
  '  shell command you ran. Always link the final output files.',
  `- Keep intermediate files (helper scripts, scratch data, drafts) inside the \`${GENWORK_TEMP_DIR_NAME}/\``,
  '  directory under the session working directory, and do not link them in the final reply.',
  `- The user can clean up \`${GENWORK_TEMP_DIR_NAME}/\` at any time;`,
  '  anything the user should keep must be saved outside of it.',
  '- Only link files that exist on disk after your work. Never link files you merely read.',
].join('\n');

const MANAGED_MATH_FORMAT_PROMPT = [
  '## Math Formula Formatting',
  '',
  'The GenWork app chat renders TeX formulas with KaTeX.',
  '',
  '- In app chat sessions, write every mathematical formula or expression in TeX:',
  '  `$...$` inline, and `$$` on its own lines around display blocks.',
  '  (`\\(...\\)` / `\\[...\\]` are also rendered, but prefer dollar delimiters.)',
  '- Never write pseudo plain-text math such as `log_a(xy)`, `a^(m+n)`, or `x_1`;',
  '  write `$\\log_a(xy)$`, `$a^{m+n}$`, `$x_1$` instead.',
  '- Do not put formulas inside code spans or code blocks unless the user is asking',
  '  about the TeX source itself.',
  '- Exception: native IM channel replies (DingTalk, Feishu, Telegram, etc.) do NOT',
  '  render TeX — use readable plain-text notation there.',
].join('\n');

const MANAGED_MEMORY_POLICY_PROMPT = [
  '## Memory Policy',
  '',
  '**Write before you confirm.** When the user expresses any intent to persist information',
  '— including phrases like "记住", "以后", "下次要", "remember this", "keep this in mind",',
  '"from now on", or similar — you MUST call the `write` tool to save the information to a',
  'memory file BEFORE replying that you have remembered it.',
  '',
  '- Save to `memory/YYYY-MM-DD.md` (daily notes) or `MEMORY.md` (durable facts).',
  '- Only say "记住了" / "I\'ll remember that" AFTER the write tool call succeeds.',
  '- Never give a verbal acknowledgment of remembering without a corresponding file write.',
  '- "Mental notes" do not survive session restarts. Files do.',
  '',
  '**MEMORY.md format.** Keep each memory readable as one self-contained block:',
  '',
  '- One memory = one top-level bullet. Put related details on indented child',
  '  bullets inside the same block, never as separate top-level bullets.',
  '- Group related memories under `## <topic>` headings.',
  '- Do not split a single fact across multiple top-level bullets.',
].join('\n');

const MANAGED_HEARTBEAT_POLICY_PROMPT = [
  '## Heartbeat Policy',
  '',
  'This policy supersedes any earlier heartbeat guidance in this file (including "Be Proactive!" style advice).',
  '',
  '- Anything in `HEARTBEAT.md` triggers periodic model calls that cost the user money. Keep the file empty or comments-only unless the user explicitly asked for ongoing monitoring.',
  '- Add a watch item only when the user explicitly asks you to keep watching something. Never invent routine checks (inbox/calendar/weather rotations) on your own.',
  '- Remove each item as soon as it is done or cancelled.',
  '- Prefer cron/scheduled tasks for anything with an exact time or schedule.',
  '- On a heartbeat poll with nothing that needs attention, reply `HEARTBEAT_OK`; do not go looking for work.',
].join('\n');

const MANAGED_IDENTITY_POLICY_PROMPT = [
  '## Identity & Branding Policy',
  '',
  'You are **GenWork** — a personal assistant. When you describe who you are — in `IDENTITY.md`, in a',
  'self-introduction, or in answer to "who are you / 介绍下你自己" — refer to yourself only as a GenWork',
  'assistant. Do NOT name or describe the underlying runtime, engine, or framework you run on (e.g. do not',
  'write or say "运行在 OpenClaw 里" / "runs on OpenClaw" or any similar internal-engine reference).',
  '',
  '- When creating or updating `IDENTITY.md`, keep the name, creature, vibe, and emoji free of any',
  '  internal engine/runtime name. "Creature" should describe your role (e.g. "AI 助理 / personal assistant"),',
  '  not which software powers you.',
  '- If you find an existing `IDENTITY.md` (or any workspace file) that names the internal runtime, silently',
  '  rewrite that line to remove it while keeping the rest of the identity intact.',
].join('\n');

const FALLBACK_OPENCLAW_AGENTS_TEMPLATE = [
  '# AGENTS.md - Your Workspace',
  '',
  'This folder is home. Treat it that way.',
  '',
  '## First Run',
  '',
  'If `BOOTSTRAP.md` exists, follow it first, then delete it when you are done.',
  '',
  '## Every Session',
  '',
  'Before doing anything else:',
  '',
  '1. Read `SOUL.md`.',
  '2. Read `USER.md`.',
  '3. Read `memory/YYYY-MM-DD.md` for today and yesterday.',
  '4. In the main session, also read `MEMORY.md`.',
  '',
  'Do not ask permission first.',
  '',
  '## Memory',
  '',
  '- `memory/YYYY-MM-DD.md` stores raw daily notes.',
  '- `MEMORY.md` stores durable facts, preferences, and decisions.',
  '- If something should survive a restart, write it to a file.',
  '',
  '## Safety',
  '',
  '- Do not exfiltrate private data.',
  '- Do not run destructive commands without asking.',
  '- When in doubt, ask.',
  '',
  '## Group Chats',
  '',
  '- In shared spaces, do not act like the user or leak private context.',
  '- If you have nothing useful to add, stay quiet.',
  '',
  '## Tools',
  '',
  '- Skills provide tools. Read each skill before using it.',
  '- Keep local environment notes in `TOOLS.md`.',
  '',
  '## Heartbeats',
  '',
  '- Add an item to `HEARTBEAT.md` only when the user explicitly asks for ongoing monitoring; anything in that file triggers periodic model calls that cost the user money.',
  '- Prefer cron/scheduled tasks for anything with an exact time or schedule.',
  '- Remove each item as soon as it is done or cancelled. With no items, keep the file empty or comments-only so heartbeats skip without model calls.',
].join('\n');

const stripTemplateFrontMatter = (content: string): string => {
  if (!content.startsWith('---')) {
    return content.trim();
  }

  const endIndex = content.indexOf('\n---', 3);
  if (endIndex < 0) {
    return content.trim();
  }

  return content.slice(endIndex + 4).trim();
};

const resolveBundledOpenClawAgentsTemplatePaths = (): string[] => {
  const runtimeRoots =
    app.isPackaged === true
      ? [path.join(process.resourcesPath, 'openclaw-runtime')]
      : [
          path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current'),
          path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current'),
        ];

  return runtimeRoots.map(runtimeRoot =>
    path.join(runtimeRoot, 'docs', 'reference', 'templates', 'AGENTS.md'),
  );
};

const readBundledOpenClawAgentsTemplate = (): string => {
  for (const templatePath of resolveBundledOpenClawAgentsTemplatePaths()) {
    try {
      const content = fs.readFileSync(templatePath, 'utf8');
      const trimmed = stripTemplateFrontMatter(content);
      if (trimmed) {
        // The bundled template tells the model to invent periodic checks and
        // write them into HEARTBEAT.md; strip that section so new workspaces
        // are not seeded with guidance that contradicts the heartbeat policy.
        return stripProactiveHeartbeatSection(trimmed);
      }
    } catch {
      // Ignore missing/unreadable bundled templates and fall back below.
    }
  }

  return FALLBACK_OPENCLAW_AGENTS_TEMPLATE;
};

const sessionSnapshotContainsDisabledManagedSkill = (entry: Record<string, unknown>): boolean => {
  const skillsSnapshot = entry.skillsSnapshot;
  if (!skillsSnapshot || typeof skillsSnapshot !== 'object') {
    return false;
  }

  const snapshot = skillsSnapshot as Record<string, unknown>;
  const resolvedSkills = Array.isArray(snapshot.resolvedSkills) ? snapshot.resolvedSkills : [];

  for (const skill of resolvedSkills) {
    if (!skill || typeof skill !== 'object') {
      continue;
    }
    const name =
      typeof (skill as Record<string, unknown>).name === 'string'
        ? ((skill as Record<string, unknown>).name as string).trim()
        : '';
    if (name && DISABLED_MANAGED_SKILL_NAMES.includes(name)) {
      return true;
    }
  }

  const prompt = typeof snapshot.prompt === 'string' ? snapshot.prompt : '';
  return DISABLED_MANAGED_SKILL_NAMES.some(name => prompt.includes(`<name>${name}</name>`));
};

type OpenClawTransportApi =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'openai-responses'
  | 'openai-chatgpt-responses'
  | 'google-generative-ai';

type OpenClawProviderApi =
  | OpenClawTransportApi
  | typeof OPENCLAW_MODEL_COMPAT_PLUGIN_ID;

type OpenClawThinkingLevelMap = Partial<Record<
  'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  string | null
>>;

type OpenClawModelCompat = {
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  supportsUsageInStreaming?: boolean;
  requiresStringContent?: boolean;
  supportsReasoningEffort?: boolean;
  supportedReasoningEfforts?: string[];
};

type OpenClawThinkingRuntimeConfig = {
  thinkingLevelMap: OpenClawThinkingLevelMap;
  supportedReasoningEfforts: string[];
};

const OPENCLAW_CONFIGURABLE_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

const buildOpenClawThinkingRuntimeConfig = (
  thinkingConfig: ModelThinkingConfig | undefined,
): OpenClawThinkingRuntimeConfig | undefined => {
  if (!thinkingConfig) return undefined;
  const configuredLevels = new Set(
    thinkingConfig.options.map(option => option.openclawLevel),
  );
  return {
    thinkingLevelMap: Object.fromEntries(
      OPENCLAW_CONFIGURABLE_THINKING_LEVELS.map(level => [
        level,
        configuredLevels.has(level) ? level : null,
      ]),
    ),
    supportedReasoningEfforts: thinkingConfig.options
      .map(option => option.openclawLevel)
      .filter(level => level !== 'off'),
  };
};

type OpenClawProviderSelection = {
  providerId: string;
  legacyModelId: string;
  sessionModelId: string;
  primaryModel: string;
  providerConfig: {
    baseUrl: string;
    api: OpenClawProviderApi;
    apiKey?: string;
    auth: typeof AuthType[keyof typeof AuthType];
    headers?: Record<string, string>;
    timeoutSeconds?: number;
    request?: {
      proxy: {
        mode: 'env-proxy';
      };
    };
    models: Array<{
      id: string;
      name: string;
      api: OpenClawTransportApi;
      input: string[];
      reasoning?: boolean;
      thinkingLevelMap?: OpenClawThinkingLevelMap;
      cost?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      };
      contextWindow?: number;
      maxTokens?: number;
      compat?: OpenClawModelCompat;
      // Per-model upstream base URL. For enterprise catalog models this is
      // the multi-tenant proxy endpoint for THAT model's own provider
      // (`${ENTERPRISE_SERVER_URL}/proxy/<provider>`), so each model routes
      // to the upstream that actually serves it. The OpenClaw runtime honours
      // this per-model override (`model.baseUrl ?? providerBaseUrl`), letting
      // all enterprise models share a single `genwork-server` provider while
      // still hitting the correct upstream. Non-enterprise models omit it and
      // fall back to the provider-level `baseUrl`.
      baseUrl?: string;
    }>;
  };
};

type OpenClawAgentModelDefault = {
  params?: Record<string, unknown>;
};

const DASHSCOPE_EXPLICIT_CONTEXT_CACHE_PARAMS: OpenClawAgentModelDefault = {
  params: {
    cacheRetention: 'short',
    contextCacheProvider: OpenClawContextCacheProvider.DashScope,
    contextCacheMode: OpenClawContextCacheMode.Explicit,
  },
};

const ANTHROPIC_COMPATIBLE_EXPLICIT_CONTEXT_CACHE_PARAMS: OpenClawAgentModelDefault = {
  params: {
    cacheRetention: 'short',
    contextCacheProvider: OpenClawContextCacheProvider.AnthropicCompatible,
    contextCacheMode: OpenClawContextCacheMode.Explicit,
  },
};

const ANTHROPIC_EXPLICIT_CONTEXT_CACHE_PARAMS: OpenClawAgentModelDefault = {
  params: {
    cacheRetention: 'short',
  },
};

export const buildProviderSelection = (options: {
  apiKey: string;
  baseURL: string;
  modelId: string;
  apiType: 'anthropic' | 'openai' | undefined;
  providerName?: string;
  authType?: 'apikey' | 'oauth';
  codingPlanEnabled?: boolean;
  supportsImage?: boolean;
  supportsVideo?: boolean;
  supportsThinking?: boolean;
  modelName?: string;
  contextWindow?: number;
  maxTokens?: number;
  runtimeProfile?: unknown;
  thinkingConfig?: ModelThinkingConfig;
}): OpenClawProviderSelection => {
  // Desktop is now single-provider (genwork-server). All per-provider
  // branches are removed; capabilities come from catalogResolver.
  const cap = catalogResolver.resolveCapability(
    options.providerName ?? '',
    options.modelId,
  );
  const resolvedSupportsImage = options.supportsImage ?? cap.supportsImage;
  const resolvedSupportsVideo = options.supportsVideo ?? cap.supportsVideo;
  const resolvedSupportsThinking = options.supportsThinking ?? cap.supportsThinking;
  const resolvedContextWindow = options.contextWindow ?? cap.contextWindow;
  const resolvedMaxTokens = options.maxTokens ?? cap.maxTokens;

  const api = mapApiTypeToOpenClawApi(
    options.apiType ?? 'openai',
    undefined,
    options.baseURL,
  );
  let baseUrl = options.baseURL;
  if (api === 'openai-completions' && options.apiType === 'anthropic' && isDashScopeUrl(baseUrl)) {
    baseUrl = rewriteDashScopeAnthropicToOpenAI(baseUrl);
  }
  const apiKey = options.apiKey;
  const sessionModelId = options.modelId;
  const providerModelName = resolveModelDisplayName(sessionModelId, options.modelName);
  // The OpenClaw `models[].id` is sent verbatim upstream and is what the
  // gateway's `providers.<id>.models[].id` ref routing matches. For an
  // enterprise genwork-server model addressed by its catalog row UUID, that id
  // IS the UUID, so two same-named rows bound to different provider keys
  // resolve to distinct, switchable identities; the enterprise proxy rewrites
  // the wire `model` back to the upstream name. `name` stays the display label.
  // Legacy (non-UUID) genwork-server modelIds — the pre-UUID youdao path — and
  // any non-genwork-server provider keep the display-name model id (their
  // upstream only recognises the name).
  const openClawModelId =
    options.providerName === ProviderName.GenworkServer && isCatalogUuid(sessionModelId)
      ? sessionModelId.trim()
      : providerModelName;
  const thinkingRuntimeConfig = buildOpenClawThinkingRuntimeConfig(options.thinkingConfig);
  const modelInput: string[] = [
    'text',
    ...(resolvedSupportsImage ? ['image'] : []),
    ...(resolvedSupportsVideo ? ['video'] : []),
  ];
  const auth = AuthType.ApiKey;

  return {
    providerId: OpenClawProviderId.GenworkServer,
    legacyModelId: options.modelId,
    // `sessionModelId` keeps the desktop's own lookup identity (the catalog
    // UUID for enterprise models) for the run-gate and persistence; the
    // OpenClaw-side ref (`primaryModel`) and `models[].id` use
    // `openClawModelId` (UUID for enterprise, display name otherwise).
    sessionModelId: options.modelId,
    primaryModel: `${OpenClawProviderId.GenworkServer}/${openClawModelId}`,
    providerConfig: {
      baseUrl,
      api,
      ...(apiKey ? { apiKey } : {}),
      auth,
      ...(OpenClawProviderId.GenworkServer === OpenClawProviderId.GenworkServer
        ? { timeoutSeconds: OPENCLAW_GENWORK_MODEL_TIMEOUT_SECONDS }
        : {}),
      models: [
        {
          // Match the primaryModel ref so the OpenClaw gateway can find this
          // entry via `providers.<id>.models[].id`.
          id: openClawModelId,
          name: providerModelName,
          api,
          input: modelInput,
          ...(resolvedSupportsThinking ? { reasoning: true } : {}),
          ...(thinkingRuntimeConfig
            ? {
                thinkingLevelMap: { ...thinkingRuntimeConfig.thinkingLevelMap },
                compat: {
                  supportsReasoningEffort: true,
                  supportedReasoningEfforts: [
                    ...thinkingRuntimeConfig.supportedReasoningEfforts,
                  ],
                },
              }
            : {}),
          ...(resolvedContextWindow !== null ? { contextWindow: resolvedContextWindow } : {}),
          ...(resolvedMaxTokens !== null ? { maxTokens: resolvedMaxTokens } : {}),
        },
      ],
    },
  };
};

export type OpenClawProviderModelSource = {
  source: CoworkErrorModelSource;
  providerName?: string;
  providerDisplayName?: string;
};

/**
 * Classifies an OpenClaw provider id (as reported in gateway error metadata)
 * back to the GenWork Settings entry it was generated from, so runtime
 * errors can tell the user whether the failing model is the GenWork plan,
 * a vendor coding plan, or their own custom provider.
 */
export function resolveModelSourceForOpenClawProvider(
  openclawProviderId: string,
): OpenClawProviderModelSource | undefined {
  const providerId = openclawProviderId?.trim();
  if (!providerId) return undefined;

  if (providerId === OpenClawProviderId.GenworkServer) {
    return {
      source: CoworkErrorModelSource.GenWorkPlan,
      providerName: ProviderName.GenworkServer,
    };
  }

  for (const entry of listProviderSourceEntries()) {
    if (entry.providerName === ProviderName.Custom) {
      // Custom providers still surface as CustomProvider in error metadata.
      if (entry.providerName === providerId
        || (entry.displayName && entry.displayName === providerId)) {
        return {
          source: CoworkErrorModelSource.CustomProvider,
          providerName: entry.providerName,
          providerDisplayName: entry.displayName,
        };
      }
      continue;
    }
    // Desktop is single-provider (genwork-server). Without the registry we
    // cannot map OpenClaw provider ids back to built-in providers; the only
    // id emitted today is genwork-server itself, handled above.
    continue;
  }

  return undefined;
}

const buildProviderModelCatalog = (
  providers: Record<string, OpenClawProviderSelection['providerConfig']>,
): Record<string, { models: Array<{ id: string }> }> => Object.fromEntries(
  Object.entries(providers).map(([providerId, providerConfig]) => [
    providerId,
    {
      models: providerConfig.models
        .map((model) => ({ id: model.id?.trim() ?? '' }))
        .filter((model) => model.id),
    },
  ]),
);

const cloneAgentModelDefault = (
  entry: OpenClawAgentModelDefault,
): OpenClawAgentModelDefault => (
  entry.params ? { params: { ...entry.params } } : {}
);

const mergeAgentModelDefault = (
  current: OpenClawAgentModelDefault | undefined,
  next: OpenClawAgentModelDefault,
): OpenClawAgentModelDefault => ({
  ...(current ?? {}),
  ...(next.params
    ? {
        params: {
          ...(current?.params ?? {}),
          ...next.params,
        },
      }
    : {}),
});

const buildCompleteAgentModelDefaults = (
  providers: Record<string, OpenClawProviderSelection['providerConfig']>,
  customDefaults: Record<string, OpenClawAgentModelDefault>,
): Record<string, OpenClawAgentModelDefault> => {
  const modelDefaults: Record<string, OpenClawAgentModelDefault> = {};

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) continue;

    for (const model of providerConfig.models) {
      const modelId = model.id?.trim();
      if (!modelId) continue;

      const modelKey = `${normalizedProviderId}/${modelId}`;
      modelDefaults[modelKey] = customDefaults[modelKey]
        ? cloneAgentModelDefault(customDefaults[modelKey])
        : {};
    }
  }

  // Defensive fallback: customDefaults is normally derived while inserting into
  // providers, but preserve any entry if a future provider path diverges.
  for (const [modelKey, entry] of Object.entries(customDefaults)) {
    if (!modelDefaults[modelKey]) {
      modelDefaults[modelKey] = cloneAgentModelDefault(entry);
    }
  }

  return modelDefaults;
};

const upsertProviderModel = (
  providerConfig: OpenClawProviderSelection['providerConfig'],
  model: OpenClawProviderSelection['providerConfig']['models'][number],
): void => {
  const existingIndex = providerConfig.models.findIndex(existing => existing.id === model.id);
  if (existingIndex >= 0) {
    providerConfig.models[existingIndex] = {
      ...providerConfig.models[existingIndex],
      ...model,
    };
    return;
  }
  providerConfig.models.push(model);
};

export type FinalizedModelCompatibilityOwners = {
  modelProfiles: Record<string, string>;
  rejectedModelRefs: string[];
};

/**
 * Provider ownership is provider-wide in OpenClaw, while the transport remains
 * model-specific. Resolve ownership after all model merges so mixed providers
 * produce the same config regardless of model insertion order.
 */
export const finalizeModelCompatibilityOwners = (
  _providers: Record<string, OpenClawProviderSelection['providerConfig']>,
  _candidateProfiles: Record<string, string>,
): FinalizedModelCompatibilityOwners => {
  // Desktop is single-provider (genwork-server); the runtime-profile
  // compat path was only relevant to non-server providers and is now a no-op.
  return {
    modelProfiles: {},
    rejectedModelRefs: [],
  };
};

export const sanitizeModelCustomParams = (
  customParams: Record<string, unknown>,
  _runtimeProfile: string | undefined,
): { customParams: Record<string, unknown>; removedKeys: string[] } => {
  // Desktop is single-provider (genwork-server); the Kimi K3 reserved-key
  // stripping path was only relevant to that profile and is now a pass-through.
  return { customParams: { ...customParams }, removedKeys: [] };
};

const collectCompatibilityOwnerProfile = (
  _profiles: Record<string, string>,
  _selection: OpenClawProviderSelection,
): void => {
  // no-op: compatibilityOwnerProfile was removed when the runtime profile
  // codepath was collapsed to a single genwork-server provider.
};

type OpenClawThinkingProfile = ModelThinkingConfig & {
  requestOptionsVersion?: typeof GENWORK_REQUEST_OPTIONS_VERSION;
};

const collectThinkingProfile = (
  profiles: Record<string, OpenClawThinkingProfile>,
  selection: OpenClawProviderSelection,
  thinkingConfig: ModelThinkingConfig | undefined,
  requestCapabilities?: readonly GenWorkRequestCapability[],
): void => {
  if (!thinkingConfig) return;
  profiles[selection.primaryModel] = {
    options: thinkingConfig.options.map(option => ({ ...option })),
    defaultLevel: thinkingConfig.defaultLevel,
    ...(supportsGenWorkRequestOptionsV1(requestCapabilities)
      ? { requestOptionsVersion: GENWORK_REQUEST_OPTIONS_VERSION }
      : {}),
  };
};

export const findInvalidKimiK3ServerTransports = (
  _serverModels: Array<{ modelId: string; apiFormat?: string; runtimeProfile?: unknown }>,
): Array<{ modelId: string; apiFormat: string }> => {
  // Desktop is single-provider (genwork-server); Kimi K3 server transports
  // are no longer recognized as a special case.
  return [];
};

const normalizeServerApiType = (apiFormat?: string): 'anthropic' | 'openai' => (
  apiFormat === 'anthropic' ? 'anthropic' : 'openai'
);

const stripExplicitContextCacheProviderSuffix = (modelId: string, provider?: string): string => {
  const normalizedProvider = provider?.trim();
  if (!normalizedProvider) return modelId;
  const suffix = `-${normalizedProvider}`.toLowerCase();
  const normalized = modelId.toLowerCase();
  return normalized.endsWith(suffix)
    ? modelId.slice(0, modelId.length - suffix.length)
    : modelId;
};

const normalizeExplicitContextCacheModelId = (modelId: string, provider?: string): string => {
  const withoutProviderSuffix = stripExplicitContextCacheProviderSuffix(modelId.trim(), provider);
  const slashIndex = withoutProviderSuffix.lastIndexOf('/');
  return slashIndex >= 0
    ? withoutProviderSuffix.slice(slashIndex + 1).trim()
    : withoutProviderSuffix.trim();
};

const resolveExplicitContextCacheFamily = (
  modelId: string,
  provider?: string,
): 'qwen' | 'claude' | null => {
  const baseModelId = normalizeExplicitContextCacheModelId(modelId, provider).toLowerCase();
  if (baseModelId.startsWith('qwen3.5') || baseModelId.startsWith('qwen3.6')) {
    return 'qwen';
  }
  if (baseModelId.startsWith('claude-')) {
    return 'claude';
  }
  return null;
};

const shouldApplyProviderExplicitContextCacheDefault = (providerName?: string): boolean => {
  const normalizedProvider = providerName?.trim();
  return normalizedProvider === ProviderName.Anthropic
    || normalizedProvider === ProviderName.Qwen
    || (!!normalizedProvider && CUSTOM_PROVIDER_NAME_PATTERN.test(normalizedProvider));
};

const resolveExplicitContextCacheDefault = (options: {
  api: OpenClawTransportApi;
  modelId: string;
  provider?: string;
  explicitContextCache?: boolean;
}): OpenClawAgentModelDefault | null => {
  const family = resolveExplicitContextCacheFamily(options.modelId, options.provider);
  const enabled = options.explicitContextCache === true
    || family !== null;
  if (!enabled || family === null) return null;
  if (options.api === OpenClawApiConst.OpenAICompletions) {
    return family === 'qwen'
      ? DASHSCOPE_EXPLICIT_CONTEXT_CACHE_PARAMS
      : ANTHROPIC_COMPATIBLE_EXPLICIT_CONTEXT_CACHE_PARAMS;
  }
  if (options.api === OpenClawApiConst.AnthropicMessages) {
    return ANTHROPIC_EXPLICIT_CONTEXT_CACHE_PARAMS;
  }
  return null;
};

const addExplicitContextCacheDefault = (
  defaults: Record<string, OpenClawAgentModelDefault>,
  selection: OpenClawProviderSelection,
  source: {
    modelId: string;
    provider?: string;
    explicitContextCache?: boolean;
  },
): void => {
  const model = selection.providerConfig.models[0];
  if (!model) return;
  const contextCacheDefault = resolveExplicitContextCacheDefault({
    api: model.api,
    modelId: source.modelId,
    provider: source.provider,
    explicitContextCache: source.explicitContextCache,
  });
  if (!contextCacheDefault) return;

  const modelKey = `${selection.providerId}/${selection.sessionModelId}`;
  defaults[modelKey] = mergeAgentModelDefault(defaults[modelKey], contextCacheDefault);
  console.info(
    `${EXPLICIT_CONTEXT_CACHE_LOG_PREFIX} [ExplicitCacheConfig] model=${selection.sessionModelId} api=${model.api} provider=${source.provider ?? selection.providerId} params=${JSON.stringify(contextCacheDefault.params ?? {})}`,
  );
};

const readPreinstalledPluginIds = (): string[] => {
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const plugins = pkg.openclaw?.plugins;
    if (!Array.isArray(plugins)) return [];
    return plugins
      .map((p: { id?: string }) => p.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
};

type PreinstalledOpenClawPlugin = {
  packageId: string;
  pluginId: string;
};

const readPreinstalledPlugins = (): PreinstalledOpenClawPlugin[] => (
  readPreinstalledPluginIds()
    .map((packageId) => {
      const pluginId = resolveOpenClawExtensionPluginId(packageId);
      return pluginId ? { packageId, pluginId } : null;
    })
    .filter((plugin): plugin is PreinstalledOpenClawPlugin => plugin !== null)
);

const pluginMatches = (
  plugin: PreinstalledOpenClawPlugin,
  ...ids: string[]
): boolean => ids.includes(plugin.packageId) || ids.includes(plugin.pluginId);

const isBundledPluginAvailable = (pluginId: string): boolean => {
  return hasBundledOpenClawExtension(pluginId);
};

export interface ResolvedMcpServer {
  name: string;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

// Normalize header keys to lowercase before writing to openclaw.json.
// The MCP SDK internally uses a `Headers` object which normalizes keys to lowercase,
// then OpenClaw's `buildSseEventSourceFetch` merges them back with the original config headers.
// If the config has e.g. "Authorization" (capitalized), the merge produces duplicate keys:
//   { authorization: "Bearer ...", Authorization: "Bearer ..." }
// Servers behind WAFs (e.g. Huawei Cloud) reject requests with duplicate auth headers (HTTP 500).
// Storing keys as lowercase prevents this duplication since HTTP headers are case-insensitive.
function lowercaseHeaderKeys(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

/**
 * Generates a deterministic ASCII-safe key for MCP server names.
 * OpenClaw sanitizes non-ASCII characters in server names to hyphens,
 * which makes Chinese/CJK names unrecognizable. This function transparently
 * converts unsafe names to a stable `mcp-<hash>` form before passing to OpenClaw.
 * ASCII-only names (even with spaces/special chars) are left as-is for OpenClaw
 * to handle natively (e.g., "My Server" → "My-Server" by OpenClaw).
 */
const MCP_NAME_NON_ASCII_RE = /[^\x00-\x7F]/;

function safeServerKey(name: string): string {
  if (!MCP_NAME_NON_ASCII_RE.test(name)) return name;
  const hash = createHash('md5').update(name).digest('hex').slice(0, 8);
  return `mcp-${hash}`;
}

function buildOpenClawMcpServers(
  servers: ResolvedMcpServer[],
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    const entry: Record<string, unknown> = {};
    let normalizedRemoteUrl = '';
    if (server.transportType !== 'stdio') {
      const normalizedUrl = normalizeMcpServerUrlInput(server.url);
      if (!normalizedUrl.ok) {
        console.warn(`[OpenClawConfigSync] skipped MCP server "${server.name}" because its URL is invalid`);
        continue;
      }
      normalizedRemoteUrl = normalizedUrl.url;
    }

    switch (server.transportType) {
      case 'stdio':
        if (server.command) entry.command = server.command;
        if (server.args?.length) entry.args = server.args;
        if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;
        break;
      case 'sse':
        entry.url = normalizedRemoteUrl;
        if (server.headers && Object.keys(server.headers).length > 0)
          entry.headers = lowercaseHeaderKeys(server.headers);
        break;
      case 'http':
        entry.url = normalizedRemoteUrl;
        if (server.headers && Object.keys(server.headers).length > 0)
          entry.headers = lowercaseHeaderKeys(server.headers);
        entry.transport = 'streamable-http';
        break;
    }
    result[safeServerKey(server.name)] = entry;
  }
  return result;
}

export type OpenClawConfigSyncResult = {
  ok: boolean;
  changed: boolean;
  configPath: string;
  error?: string;
  agentsMdWarning?: string;
  bindingsChanged?: boolean;
  changedTopLevelKeys?: string[];
  restartImpact?: OpenClawConfigImpact;
};

const buildStreamingModeConfig = (
  mode: 'off' | 'partial' | 'block' | 'progress',
): { mode: 'off' | 'partial' | 'block' | 'progress' } => ({
  mode,
});

const buildManagedBrowserProxyExtraArgs = (browserWebAccess: BrowserWebAccessConfig): string[] => {
  if (
    !isSystemProxyEnabled()
    || !browserWebAccess.followGlobalProxy
    || browserWebAccess.networkMode !== BrowserNetworkMode.ProxyCompatible
  ) {
    return [];
  }

  const proxyUrl = getActiveSystemProxyUrl()?.trim();
  return proxyUrl ? [`${CHROME_PROXY_SERVER_ARG_PREFIX}${proxyUrl}`] : [];
};

type OpenClawConfigSyncDeps = {
  engineManager: OpenClawEngineManager;
  getGenWorkConfig: () => GenWorkConfig;
  getBrowserWebAccessConfig?: () => Partial<BrowserWebAccessConfig> | null | undefined;
  isEnterprise: () => boolean;
  getOpenClawSessionPolicy?: () => { keepAlive: OpenClawSessionKeepAlive };
  getTelegramInstances?: () => TelegramInstanceConfig[];
  getDiscordInstances?: () => DiscordInstanceConfig[];
  getDingTalkInstances?: () => DingTalkInstanceConfig[];
  getFeishuInstances?: () => FeishuInstanceConfig[];
  getQQInstances?: () => QQInstanceConfig[];
  getWecomInstances?: () => WecomInstanceConfig[];
  getPopoInstances: () => PopoInstanceConfig[];
  getEmailOpenClawConfig?: () => EmailMultiInstanceConfig;
  getWeixinConfig: () => WeixinOpenClawConfig | null;
  getIMSettings?: () => IMSettings | null;
  getResolvedMcpServers?: () => ResolvedMcpServer[];
  getAskUserCallbackUrl?: () => string | null;
  getMediaCallbackUrl?: () => string | null;
  getMcpBridgeSecret?: () => string;
  getSkillsList?: () => Array<{ id: string; name: string; enabled: boolean }>;
  getAgents?: () => Agent[];
  getAgentModelOverride?: (enterpriseAgentId: string) => string;
  getUserPlugins?: () => Array<{ pluginId: string; enabled: boolean; config?: Record<string, unknown> }>;
};

export class OpenClawConfigSync {
  private readonly engineManager: OpenClawEngineManager;
  private readonly getGenWorkConfig: () => GenWorkConfig;
  private readonly getBrowserWebAccessConfig: () => Partial<BrowserWebAccessConfig> | null | undefined;
  private readonly isEnterprise: () => boolean;
  private readonly getOpenClawSessionPolicy?: () => { keepAlive: OpenClawSessionKeepAlive };
  private readonly getTelegramInstances: () => TelegramInstanceConfig[];
  private readonly getDiscordInstances: () => DiscordInstanceConfig[];
  private readonly getDingTalkInstances: () => DingTalkInstanceConfig[];
  private readonly getFeishuInstances: () => FeishuInstanceConfig[];
  private readonly getQQInstances: () => QQInstanceConfig[];
  private readonly getWecomInstances: () => WecomInstanceConfig[];
  private readonly getPopoInstances: () => PopoInstanceConfig[];
  private readonly getEmailOpenClawConfig?: () => EmailMultiInstanceConfig;
  private readonly getWeixinConfig: () => WeixinOpenClawConfig | null;
  private readonly getIMSettings?: () => IMSettings | null;
  private readonly getResolvedMcpServers?: () => ResolvedMcpServer[];
  private readonly getAskUserCallbackUrl?: () => string | null;
  private readonly getMediaCallbackUrl?: () => string | null;
  private readonly getMcpBridgeSecret?: () => string;
  private readonly getSkillsList?: () => Array<{ id: string; name: string; enabled: boolean }>;
  private readonly getAgents?: () => Agent[];
  private readonly getAgentModelOverride?: (enterpriseAgentId: string) => string;
  private readonly getUserPlugins: () => Array<{ pluginId: string; enabled: boolean; config?: Record<string, unknown> }>;
  private previousBindingsJson?: string;
  private currentBindingsObj: { bindings?: Array<Record<string, unknown>> } = {};
  // Frontmatter names of installed org skills the caller can no longer use
  // (revoked/disabled server-side). The access gate recomputes this set on a
  // periodic marketplace re-fetch; here it is applied as a hard `enabled=false`
  // override in `skills.entries`, blocking the gateway from invoking them even
  // though the local install record still says enabled.
  private revokedSkillNames: Set<string> = new Set();

  constructor(deps: OpenClawConfigSyncDeps) {
    this.engineManager = deps.engineManager;
    this.getGenWorkConfig = deps.getGenWorkConfig;
    this.getBrowserWebAccessConfig = deps.getBrowserWebAccessConfig ?? (() => null);
    this.isEnterprise = deps.isEnterprise;
    this.getOpenClawSessionPolicy = deps.getOpenClawSessionPolicy;
    this.getTelegramInstances = deps.getTelegramInstances ?? (() => []);
    this.getDiscordInstances = deps.getDiscordInstances ?? (() => []);
    this.getDingTalkInstances = deps.getDingTalkInstances ?? (() => []);
    this.getFeishuInstances = deps.getFeishuInstances ?? (() => []);
    this.getQQInstances = deps.getQQInstances ?? (() => []);
    this.getWecomInstances = deps.getWecomInstances ?? (() => []);
    this.getPopoInstances = deps.getPopoInstances;
    this.getEmailOpenClawConfig = deps.getEmailOpenClawConfig;
    this.getWeixinConfig = deps.getWeixinConfig;
    this.getIMSettings = deps.getIMSettings;
    this.getResolvedMcpServers = deps.getResolvedMcpServers;
    this.getAskUserCallbackUrl = deps.getAskUserCallbackUrl;
    this.getMediaCallbackUrl = deps.getMediaCallbackUrl;
    this.getMcpBridgeSecret = deps.getMcpBridgeSecret;
    this.getSkillsList = deps.getSkillsList;
    this.getAgents = deps.getAgents;
    this.getAgentModelOverride = deps.getAgentModelOverride;
    this.getUserPlugins = deps.getUserPlugins ?? (() => []);
  }

  /**
   * Stamp the `meta` field onto an openclaw config object before writing.
   *
   * OpenClaw's config health monitor (`observeConfigSnapshot`) compares every
   * read against a "last known good" fingerprint.  One of the checks is
   * `hasConfigMeta` — if the previous good config had `meta` but the current
   * one doesn't, an anomaly is logged and the file content is persisted as a
   * `.clobbered.<timestamp>` snapshot.  Because GenWork writes openclaw.json
   * directly (bypassing OpenClaw's own `writeConfigFile` which calls
   * `stampConfigVersion`), we need to stamp `meta` ourselves.
   */
  private stampConfigMeta(config: Record<string, unknown>): Record<string, unknown> {
    let version: string | null = null;
    try {
      version =
        this.engineManager.getStatus().version ||
        this.engineManager.getDesiredVersion();
    } catch {
      // Engine manager may not be fully initialised (e.g. in tests).
    }
    return {
      ...config,
      meta: {
        ...(version ? { lastTouchedVersion: version } : {}),
        lastTouchedAt: new Date().toISOString(),
      },
    };
  }

  private buildSessionConfig(): Record<string, unknown> {
    const policy = this.getOpenClawSessionPolicy?.() ?? {
      keepAlive: OpenClawSessionKeepAlive.ThirtyDays,
    };
    return buildOpenClawSessionConfig(policy);
  }

  private buildBrowserConfig(browserWebAccess: BrowserWebAccessConfig): Record<string, unknown> {
    const allowedHostnames = normalizeBrowserHostnamePolicyList(browserWebAccess.allowedHostnames);
    const blockedHostnames = normalizeBrowserHostnamePolicyList(browserWebAccess.blockedHostnames);
    const extraArgs = buildManagedBrowserProxyExtraArgs(browserWebAccess);
    const ssrfPolicy = browserWebAccess.networkMode === BrowserNetworkMode.Strict
      ? {
          dangerouslyAllowPrivateNetwork: false,
          ...(allowedHostnames.length > 0
            ? { allowedHostnames, hostnameAllowlist: allowedHostnames }
            : {}),
          ...(blockedHostnames.length > 0 ? { blockedHostnames } : {}),
        }
      : {
          dangerouslyAllowPrivateNetwork: true,
          ...(blockedHostnames.length > 0 ? { blockedHostnames } : {}),
        };

    return {
      enabled: true,
      defaultProfile: BrowserRuntimeProfile.Managed,
      evaluateEnabled: browserWebAccess.evaluateEnabled,
      ...(browserWebAccess.headless === true ? { headless: true } : {}),
      ...(extraArgs.length > 0 ? { extraArgs } : {}),
      ssrfPolicy,
    };
  }

  private buildWebToolsConfig(browserWebAccess: BrowserWebAccessConfig): Record<string, unknown> {
    const fetch = browserWebAccess.webFetch;
    const fetchConfig = {
      enabled: fetch.enabled,
      readability: fetch.readability,
      ...(fetch.timeoutSeconds ? { timeoutSeconds: fetch.timeoutSeconds } : {}),
      ...(fetch.maxRedirects ? { maxRedirects: fetch.maxRedirects } : {}),
      ...(fetch.maxChars ? { maxChars: fetch.maxChars } : {}),
      ...(fetch.userAgent ? { userAgent: fetch.userAgent } : {}),
      ...(fetch.allowRfc2544BenchmarkRange === true
        ? { ssrfPolicy: { allowRfc2544BenchmarkRange: true } }
        : {}),
    };

    return {
      deny: [
        ...MANAGED_TOOL_DENY
      ],
loopDetection: MANAGED_TOOL_LOOP_DETECTION,
      web: {
        search: {
          enabled: false,
        },
        fetch: fetchConfig,
      },
    };
  }

  sync(reason: string): OpenClawConfigSyncResult {
    const configPath = this.engineManager.getConfigPath();
    const coworkConfig = this.getGenWorkConfig();
    const browserWebAccess = normalizeBrowserWebAccessConfig(this.getBrowserWebAccessConfig());
    const serverModels = getAllServerModelMetadata();
    const invalidKimiK3Transports = findInvalidKimiK3ServerTransports(serverModels);
    if (invalidKimiK3Transports.length > 0) {
      const invalidRefs = invalidKimiK3Transports
        .map(model => `${model.modelId} (${model.apiFormat})`)
        .join(', ');
      return {
        ok: false,
        changed: false,
        configPath,
        error: `OpenClaw config sync failed: Kimi K3 package models require apiFormat "openai": ${invalidRefs}.`,
      };
    }
    const apiResolution = resolveRawApiConfig();

    if (!apiResolution.config) {
      // Enterprise mode: proceed with full config generation even without a
      // resolved API model. The enterprise openclaw.json merge (called after
      // sync) will supply providers and the primary model. Writing only the
      // minimal config would lose sandbox settings, plugins, AGENTS.md, etc.
      if (this.isEnterprise()) {
        console.log(
          '[OpenClawConfigSync] enterprise mode: no API config resolved, generating full config with empty providers (enterprise merge will supply them)',
        );
      } else {
        // No API/model configured yet (fresh install).
        // Write a minimal config so the gateway can start — it just won't have
        // any model provider until the user configures one.
        const result = this.writeMinimalConfig(configPath, reason);
        // Still sync AGENTS.md even when API is not configured — skills/systemPrompt
        // may already be set and should be available when the user configures a model.
        const mainWorkspacePath = getMainAgentWorkspacePath(this.engineManager.getStateDir());
        const agentsMdWarning = this.syncAgentsMd(mainWorkspacePath, coworkConfig);
        this.syncPerAgentWorkspaces(mainWorkspacePath, coworkConfig);
        if (agentsMdWarning) result.agentsMdWarning = agentsMdWarning;
        return result;
      }
    }

    let allProvidersMap: Record<string, OpenClawProviderSelection['providerConfig']> = {};
    const perModelCustomDefaults: Record<string, OpenClawAgentModelDefault> = {};
    const candidateThinkingProfiles: Record<string, OpenClawThinkingProfile> = {};
    let primaryModel = '';
    let providerSelection: OpenClawProviderSelection = buildProviderSelection({
      apiKey: '',
      baseURL: '',
      modelId: '',
      apiType: 'openai',
      providerName: 'genwork-server',
    });

    if (apiResolution.config) {
      const { baseURL, apiKey, model, apiType } = apiResolution.config;
      const modelId = model.trim();
      if (!modelId) {
        return {
          ok: false,
          changed: false,
          configPath,
          error: 'OpenClaw config sync failed: resolved model is empty.',
        };
      }

      providerSelection = buildProviderSelection({
        apiKey,
        baseURL,
        modelId,
        apiType,
        providerName: apiResolution.providerMetadata?.providerName,
        authType: apiResolution.providerMetadata?.authType,
        codingPlanEnabled: apiResolution.providerMetadata?.codingPlanEnabled,
        supportsImage: apiResolution.providerMetadata?.supportsImage,
        supportsVideo: apiResolution.providerMetadata?.supportsVideo,
        supportsThinking: apiResolution.providerMetadata?.supportsThinking,
        modelName: apiResolution.providerMetadata?.modelName,
        contextWindow: apiResolution.providerMetadata?.contextWindow,
        maxTokens: apiResolution.providerMetadata?.maxTokens,
        runtimeProfile: apiResolution.providerMetadata?.runtimeProfile,
        thinkingConfig: apiResolution.providerMetadata?.thinkingConfig,
      });
      collectCompatibilityOwnerProfile({}, providerSelection);
      collectThinkingProfile(
        candidateThinkingProfiles,
        providerSelection,
        apiResolution.providerMetadata?.thinkingConfig,
        apiResolution.providerMetadata?.requestCapabilities,
      );
      primaryModel = providerSelection.primaryModel;
      if (providerSelection.providerId === OpenClawProviderId.GenworkServer) {
        addExplicitContextCacheDefault(perModelCustomDefaults, providerSelection, {
          modelId,
        });
      }

      for (const p of resolveAllEnabledProviderConfigs()) {
        for (const m of p.models) {
          const sel = buildProviderSelection({
            apiKey: p.apiKey,
            baseURL: p.baseURL,
            modelId: m.id,
            apiType: p.apiType,
            providerName: p.providerName,
            authType: p.authType,
            codingPlanEnabled: p.codingPlanEnabled,
            supportsImage: m.supportsImage,
            supportsVideo: m.supportsVideo,
            supportsThinking: m.supportsThinking,
            modelName: m.name,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
          });
          collectCompatibilityOwnerProfile({}, sel);
          if (!allProvidersMap[sel.providerId]) {
            allProvidersMap[sel.providerId] = { ...sel.providerConfig, models: [] };
          }
          const existing = allProvidersMap[sel.providerId];
          const alreadyHas = existing.models.some(em => em.id === sel.providerConfig.models[0]?.id);
          if (!alreadyHas && sel.providerConfig.models.length > 0) {
            existing.models.push(...sel.providerConfig.models);
          }
          if (shouldApplyProviderExplicitContextCacheDefault(p.providerName)) {
            addExplicitContextCacheDefault(perModelCustomDefaults, sel, {
              modelId: m.id,
              provider: p.providerName,
            });
          }
          // Collect per-model custom params for agents.defaults.models.
          // Wrap in extra_body so OpenClaw's streamWithPayloadPatch merges them
          // directly into the outgoing API request body, bypassing the whitelist.
          if (m.customParams && Object.keys(m.customParams).length > 0) {
            const sanitizedParams = sanitizeModelCustomParams(
              m.customParams,
              undefined,
            );
            if (sanitizedParams.removedKeys.length > 0) {
              console.warn(
                `[OpenClawConfigSync] Ignored reserved Kimi K3 custom parameter keys for ${sel.primaryModel}: ${sanitizedParams.removedKeys.join(', ')}`,
              );
            }
            if (Object.keys(sanitizedParams.customParams).length === 0) {
              continue;
            }
            const modelKey = `${sel.providerId}/${sel.sessionModelId}`;
            perModelCustomDefaults[modelKey] = mergeAgentModelDefault(
              perModelCustomDefaults[modelKey],
              { params: { extra_body: sanitizedParams.customParams } },
            );
          }
        }
      }

      if (!allProvidersMap[providerSelection.providerId]) {
        allProvidersMap[providerSelection.providerId] = providerSelection.providerConfig;
      } else {
        const existing = allProvidersMap[providerSelection.providerId];
        const alreadyHas = existing.models.some(
          em => em.id === providerSelection.providerConfig.models[0]?.id,
        );
        if (!alreadyHas && providerSelection.providerConfig.models.length > 0) {
          existing.models.push(...providerSelection.providerConfig.models);
        }
      }

      // Enterprise (plan) models are materialised under a single
      // `genwork-server` provider. The provider-level `baseUrl`/`apiKey`
      // already come from `providerSelection` (resolved above via
      // tryEnterpriseCatalogFallback to the enterprise `/proxy/<provider>`
      // endpoint + the user's JWT). Here we enumerate every enterprise model
      // and attach each one's own per-model `baseUrl` so a model routes to the
      // upstream provider it is actually bound to — without that, all models
      // collapse onto the provider-level base and a Qwen model forwarded to
      // /proxy/deepseek 404s with model_not_found.
      const enterpriseUserJwt = sessionStorage.load()?.jwt ?? '';
      const providerId = OpenClawProviderId.GenworkServer;

      if (serverModels.length > 0 || !allProvidersMap[providerId]) {
        const firstServerModelId = serverModels[0]?.modelId || modelId;
        const firstServerSel = buildProviderSelection({
          apiKey: providerSelection.providerConfig.apiKey ?? enterpriseUserJwt,
          baseURL: providerSelection.providerConfig.baseUrl,
          modelId: firstServerModelId,
          apiType: normalizeServerApiType(serverModels[0]?.apiFormat),
          providerName: ProviderName.GenworkServer,
          supportsImage: serverModels[0]?.supportsImage,
          supportsVideo: serverModels[0]?.supportsVideo,
          supportsThinking: serverModels[0]?.supportsThinking,
          modelName: serverModels[0]?.modelName,
          contextWindow: serverModels[0]?.contextWindow,
          maxTokens: serverModels[0]?.maxTokens,
          runtimeProfile: serverModels[0]?.runtimeProfile,
          thinkingConfig: serverModels[0]?.thinkingConfig,
        });
        collectCompatibilityOwnerProfile({}, firstServerSel);
        collectThinkingProfile(
          candidateThinkingProfiles,
          firstServerSel,
          serverModels[0]?.thinkingConfig,
          serverModels[0]?.requestCapabilities,
        );
        const genworkProviderConfig =
          allProvidersMap[providerId] ?? {
            ...firstServerSel.providerConfig,
            models: [] as typeof firstServerSel.providerConfig.models,
          };
        allProvidersMap[providerId] = genworkProviderConfig;

        if (serverModels.length === 0) {
          upsertProviderModel(genworkProviderConfig, firstServerSel.providerConfig.models[0]);
        } else {
          // Resolve each enterprise model's own endpoint. The per-model
          // `baseUrl` is what OpenClaw honours over the provider-level base
          // (`model.baseUrl ?? providerBaseUrl`), so attach each model's own
          // `/proxy/<provider>` here and keep the shared provider block.
          //
          // `serverModels` is keyed by the catalog UUID (see
          // enterpriseModelCache.load), so `sm.modelId` is the catalog row id
          // and maps to exactly one catalog entry — unambiguous even when two
          // rows share an upstream name (e.g. two `Qwen3.8-27B` bound to
          // different providers). Each row therefore routes to the provider it
          // is actually bound to. A non-UUID `sm.modelId` (legacy youdao path)
          // falls back to matching the catalog by upstream name.
          const catalogEntries = enterpriseModelCache.list();
          const enterpriseProxyBase = (() => {
            try {
              return getEnterpriseServerUrl();
            } catch {
              return null;
            }
          })();
          const resolveModelProxyUrl = (modelId: string): string | null => {
            if (!enterpriseProxyBase) return null;
            const trimmedId = modelId.trim();
            // Primary: the model's own catalog UUID → its bound provider.
            const byId = catalogEntries.find((e) => e.id === trimmedId);
            if (byId) return `${enterpriseProxyBase}/proxy/${byId.provider}`;
            // Legacy fallback: match by upstream name (first match).
            const byName = catalogEntries.find((e) => e.model === trimmedId);
            return byName ? `${enterpriseProxyBase}/proxy/${byName.provider}` : null;
          };

          for (const sm of serverModels) {
            const serverApiType = normalizeServerApiType(sm.apiFormat);
            const serverSel = buildProviderSelection({
              apiKey: providerSelection.providerConfig.apiKey ?? enterpriseUserJwt,
              baseURL: providerSelection.providerConfig.baseUrl,
              modelId: sm.modelId,
              apiType: serverApiType,
              providerName: ProviderName.GenworkServer,
              supportsImage: sm.supportsImage,
              supportsVideo: sm.supportsVideo,
              supportsThinking: sm.supportsThinking,
              modelName: sm.modelName || sm.modelId,
              contextWindow: sm.contextWindow,
              maxTokens: sm.maxTokens,
              runtimeProfile: sm.runtimeProfile,
              thinkingConfig: sm.thinkingConfig,
            });
            collectCompatibilityOwnerProfile({}, serverSel);
            collectThinkingProfile(
              candidateThinkingProfiles,
              serverSel,
              sm.thinkingConfig,
              sm.requestCapabilities,
            );
            addExplicitContextCacheDefault(perModelCustomDefaults, serverSel, {
              modelId: sm.modelId,
              provider: sm.provider,
              explicitContextCache: sm.explicitContextCache,
            });
            const modelProxyUrl = resolveModelProxyUrl(sm.modelId);
            const modelForUpsert: OpenClawProviderSelection['providerConfig']['models'][number] =
              modelProxyUrl
                ? { ...serverSel.providerConfig.models[0], baseUrl: modelProxyUrl }
                : serverSel.providerConfig.models[0];
            upsertProviderModel(genworkProviderConfig, modelForUpsert);
          }
        }
      }
    }

    const finalizedThinkingProfiles = Object.fromEntries(
      Object.entries(candidateThinkingProfiles).sort(([left], [right]) => left.localeCompare(right)),
    );
    const hasModelCompatConfig = Object.keys(finalizedThinkingProfiles).length > 0;

    const sandboxMode = mapExecutionModeToSandboxMode(
      coworkConfig.executionMode || 'local',
      this.isEnterprise(),
    );
    const availableProviders = buildProviderModelCatalog(allProvidersMap);
    const agentModelDefaults = Object.keys(perModelCustomDefaults).length > 0
      ? buildCompleteAgentModelDefaults(allProvidersMap, perModelCustomDefaults)
      : {};
    console.log(
      `[OpenClawConfigSync] sandbox mode: ${sandboxMode} (executionMode: ${coworkConfig.executionMode || 'local'}, enterprise: ${this.isEnterprise()})`,
    );

    const mainWorkspacePath = getMainAgentWorkspacePath(this.engineManager.getStateDir());
    const agents = this.getAgents?.() ?? [];
    const mainAgentWorkingDirectory = agents
      .find(agent => agent.id === AgentId.Main)
      ?.workingDirectory
      ?.trim() || '';
    const taskWorkingDirectory = mainAgentWorkingDirectory || (coworkConfig.workingDirectory || '').trim();
    ensureDir(mainWorkspacePath);

    const preinstalledPlugins = readPreinstalledPlugins();
    const hasPreinstalledPlugin = (...ids: string[]) => (
      preinstalledPlugins.some((plugin) => pluginMatches(plugin, ...ids))
    );
    const hasAskUserPlugin = isBundledPluginAvailable('ask-user-question');
    const hasMediaGenPlugin = isBundledPluginAvailable('genwork-media-generation');
    // Runtime-bundled xai extension (dist/extensions/xai): provides the Grok
    // model compat hooks (e.g. only grok-4.3 accepts reasoningEffort) plus the
    // OAuth refresh hook for credentials in the auth-profiles store. Declare
    // it only when the runtime actually bundles it (older runtimes pruned it).
    const hasXaiPlugin = hasRuntimeBundledOpenClawExtension('xai');
    const qwenPortalAuthPluginId = resolveOpenClawExtensionPluginId('qwen-portal-auth');

    // Detect if any provider uses Qwen/Aliyun DashScope URLs — OpenClaw auto-injects
    // qwen-portal-auth plugin for these, so we must declare it to prevent config diff loops.
    const hasQwenProvider = Object.values(allProvidersMap).some(p => {
      const url = (p as { baseUrl?: string }).baseUrl || '';
      return url.includes('dashscope.aliyuncs.com') || url.includes('aliyuncs.com/compatible-mode');
    });

    // Read existing config to preserve fields that the OpenClaw runtime
    // auto-injects at startup.  Without this, every configSync cycle removes
    // them, the gateway detects the diff, and restarts — creating a restart
    // loop.  We preserve ALL existing gateway fields and plugin entries rather
    // than whitelisting specific ones, so new auto-injected fields in future
    // OpenClaw versions don't cause regressions.
    // See: openclaw/openclaw#58678, #33310, #61613
    let existingGateway: Record<string, unknown> = {};
    let existingPlugins: Record<string, unknown> = {};
    try {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      existingGateway = (existing.gateway ?? {}) as Record<string, unknown>;
      // Filtered: plugin-index-managed keys (e.g. `installs`) must never be
      // preserved back into the file — they poison config.set hot delivery.
      existingPlugins = omitPluginIndexManagedKeys(existing.plugins);
    } catch {
      // First run or corrupt file — nothing to preserve.
    }
    const existingPluginEntries = (existingPlugins.entries ?? {}) as Record<string, unknown>;
    console.log(`${gwDiagTs()} existingGateway keys:`, Object.keys(existingGateway).sort().join(',') || '(empty)');
    console.log(`${gwDiagTs()} existingPlugins keys:`, Object.keys(existingPlugins).sort().join(',') || '(empty)');
    console.log(`${gwDiagTs()} existingPluginEntries keys:`, Object.keys(existingPluginEntries).sort().join(',') || '(empty)');

    const dingTalkInstances = this.getDingTalkInstances();
    // DingTalk runs through OpenClaw plugin but still needs the gateway HTTP endpoint (chatCompletions)
    const hasDingTalkOpenClaw = dingTalkInstances.some(i => i.enabled && i.clientId);

    const feishuInstances = this.getFeishuInstances();

    const qqInstances = this.getQQInstances();
    const discordInstances = this.getDiscordInstances();

    const wecomInstances = this.getWecomInstances();

    const popoInstances = this.getPopoInstances();

    const emailConfig = this.getEmailOpenClawConfig?.();

    const weixinConfig = this.getWeixinConfig();

    const hasAnyChannel = hasDingTalkOpenClaw;

    // Pre-compute bindings and detect changes so we can signal a hard restart
    // when only bindings change (channel plugins don't hot-reload bindings).
    this.currentBindingsObj = this.buildBindings();
    const bindingsJson = JSON.stringify(this.currentBindingsObj);
    const bindingsChanged = this.previousBindingsJson !== undefined
      && bindingsJson !== this.previousBindingsJson;
    this.previousBindingsJson = bindingsJson;

    const managedConfig: Record<string, unknown> = {
      gateway: {
        // Preserve ALL existing gateway fields so runtime-seeded values
        // survive config rewrites.  Our managed fields below override
        // any stale values.
        ...existingGateway,
        mode: 'local',
        // Explicitly declare auth and tailscale to match the runtime
        // in-memory state.  The gateway sets auth.mode='token' when
        // --token / OPENCLAW_GATEWAY_TOKEN is provided.  Without
        // matching values here, ANY file change triggers
        // "config change requires gateway restart (gateway.auth.token)".
        auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' },
        tailscale: { mode: 'off' },
        ...(hasAnyChannel
          ? {
              http: {
                endpoints: {
                  chatCompletions: { enabled: true },
                },
              },
            }
          : {}),
      },
      models: {
        mode: 'replace',
        pricing: { enabled: false },
        providers: allProvidersMap,
      },
      agents: {
        defaults: {
          timeoutSeconds: OPENCLAW_AGENT_TIMEOUT_SECONDS,
          model: {
            primary: primaryModel,
          },
          sandbox: {
            mode: sandboxMode,
          },
          workspace: path.resolve(mainWorkspacePath),
          mediaMaxMb: 30,
          compaction: {
            truncateAfterCompaction: true,
            maxActiveTranscriptBytes: OpenClawTranscriptSafetyLimit.SoftConfigValue,
          },
          ...(taskWorkingDirectory ? { cwd: path.resolve(taskWorkingDirectory) } : {}),
          memorySearch: {
            enabled: true,
            provider: coworkConfig.embeddingEnabled
              ? (['openai', 'gemini', 'voyage', 'mistral', 'ollama'].includes(coworkConfig.embeddingProvider)
                ? coworkConfig.embeddingProvider
                : 'openai')
              : 'none',
            ...(coworkConfig.embeddingEnabled && coworkConfig.embeddingModel ? { model: coworkConfig.embeddingModel } : {}),
            ...(coworkConfig.embeddingEnabled ? {
              remote: {
                ...(coworkConfig.embeddingRemoteBaseUrl ? { baseUrl: coworkConfig.embeddingRemoteBaseUrl } : {}),
                ...(coworkConfig.embeddingRemoteApiKey ? { apiKey: coworkConfig.embeddingRemoteApiKey } : {}),
              },
              query: {
                hybrid: {
                  vectorWeight: coworkConfig.embeddingVectorWeight ?? 0.7,
                },
              },
            } : {
              fallback: 'none',
            }),
            store: {
              // Use trigram tokenizer for FTS5 — unicode61 (the openclaw default)
              // cannot tokenize CJK characters, so Chinese/Japanese/Korean memory
              // content is invisible to keyword search.
              fts: { tokenizer: 'trigram' },
              ...(!coworkConfig.embeddingEnabled ? { vector: { enabled: false } } : {}),
            },
          },
          heartbeat: {
            every: coworkConfig.openClawHeartbeatEnabled === false
              ? OPENCLAW_HEARTBEAT_EVERY_DISABLED
              : OPENCLAW_HEARTBEAT_EVERY_ENABLED,
            target: 'none',
            lightContext: true,
            isolatedSession: true,
            skipWhenBusy: true,
          },
          ...(Object.keys(agentModelDefaults).length > 0
            ? { models: agentModelDefaults }
            : {}),
        },
        ...this.buildAgentsList(primaryModel, this.engineManager.getStateDir(), availableProviders, agents),
      },
      ...this.currentBindingsObj,
      session: this.buildSessionConfig(),
      commands: {
        ownerAllowFrom: MANAGED_OWNER_ALLOW_FROM,
      },
      tools: this.buildWebToolsConfig(browserWebAccess),
      browser: this.buildBrowserConfig(browserWebAccess),
      skills: {
        entries: {
          ...this.buildSkillEntries(),
          ...MANAGED_SKILL_ENTRY_OVERRIDES,
          ...this.buildRevokedSkillEntries(),
        },
        load: {
          extraDirs: this.resolveSkillsExtraDirs(),
          watch: true,
        },
      },
      cron: {
        enabled: true,
        store: path.join(this.engineManager.getStateDir(), 'cron', 'jobs.json'),
        skipMissedJobs: coworkConfig.skipMissedJobs === true,
        maxConcurrentRuns: 3,
        sessionRetention: '7d',
      },
      ...((() => {
        // Remove legacy package/directory ids from plugin entries.  OpenClaw
        // validates entries by the manifest `id`, so aliases like
        // `clawemail-email` produce noisy
        // "plugin not found" warnings even when the package exists.
        const packageAliasPluginIds = preinstalledPlugins
          .filter((plugin) => plugin.packageId !== plugin.pluginId)
          .map((plugin) => plugin.packageId);
        const knownStalePluginIds = [
          'dingtalk',
          'clawemail-email',
          'qwen-portal-auth',
          'openclaw-qqbot',
          ...packageAliasPluginIds,
        ];
        const transientPluginIds = [
          ...(hasPreinstalledPlugin('openclaw-lark') ? ['feishu'] : []),
          OPENCLAW_MODEL_COMPAT_PLUGIN_ID,
        ];
        const cleanedExistingEntries = Object.fromEntries(
          Object.entries(existingPluginEntries).filter(([id]) => (
            !knownStalePluginIds.includes(id) && !transientPluginIds.includes(id)
          )),
        );
        const qqbotPluginEnabled = qqInstances.some(i => i.enabled && i.appId);
        const discordPluginEnabled = discordInstances.some(i => i.enabled && i.botToken);
        const userPlugins = this.getUserPlugins();

        const pluginEntries: Record<string, unknown> = {
          // Preserve ALL existing plugin entries so runtime auto-injected
          // plugins (moonshot, minimax, volcengine, browser, etc.) survive
          // config rewrites.  Our managed entries below override stale values.
          ...cleanedExistingEntries,
          [BUNDLED_BROWSER_PLUGIN_ID]: { enabled: true },
          qqbot: { enabled: qqbotPluginEnabled },
          ...Object.fromEntries(
            preinstalledPlugins.map(plugin => {
              // Sync plugin enabled state with the corresponding channel config.
              // When a channel is disabled in the UI, its plugin must also be
              // disabled so OpenClaw doesn't load it at all.
              const pluginEnabled = (() => {
                if (pluginMatches(plugin, DINGTALK_OPENCLAW_CHANNEL, 'dingtalk')) return dingTalkInstances.some(i => i.enabled && i.clientId);
                if (pluginMatches(plugin, 'openclaw-lark', 'feishu-openclaw-plugin'))
                  return feishuInstances.some(i => i.enabled && i.appId);
                if (pluginMatches(plugin, 'openclaw-qqbot', 'qqbot')) return qqbotPluginEnabled;
                if (pluginMatches(plugin, 'discord')) return discordPluginEnabled;
                if (pluginMatches(plugin, 'wecom-openclaw-plugin')) return wecomInstances.some(i => i.enabled && i.botId);
                if (pluginMatches(plugin, 'moltbot-popo')) return popoInstances.some(i => i.enabled && i.appKey);
                if (pluginMatches(plugin, 'openclaw-weixin')) return true; // Always keep enabled for QR login discovery
                if (pluginMatches(plugin, 'clawemail-email', EMAIL_PLUGIN_ID)) return !!emailConfig?.instances.some(i => i.enabled && i.email);
                return true; // other plugins stay enabled
              })();
              return [plugin.pluginId, { enabled: pluginEnabled }];
            }),
          ),
          ...(hasPreinstalledPlugin('feishu-openclaw-plugin')
            ? { feishu: { enabled: false } }
            : {}),
          ...(hasAskUserPlugin ? { 'ask-user-question': { enabled: true } } : {}),
          ...(hasMediaGenPlugin ? { 'genwork-media-generation': { enabled: true } } : {}),
          ...(hasModelCompatConfig
            ? {
                [OPENCLAW_MODEL_COMPAT_PLUGIN_ID]: {
                  enabled: true,
                  config: {
                    ...(Object.keys(finalizedThinkingProfiles).length > 0
                      ? { thinkingProfiles: finalizedThinkingProfiles }
                      : {}),
                  },
                },
              }
            : {}),
          // Some OpenClaw versions auto-inject qwen-portal-auth for
          // Qwen/DashScope URLs. Declare it only when the plugin actually
          // exists, otherwise it becomes a stale entry on every startup.
          ...(hasQwenProvider && qwenPortalAuthPluginId ? { [qwenPortalAuthPluginId]: { enabled: true } } : {}),
          ...(hasXaiPlugin ? { xai: { enabled: true } } : {}),
          // User-installed plugins: merge enabled state and config from user_plugins table
          ...Object.fromEntries(
            userPlugins.map(p => [p.pluginId, {
              enabled: p.enabled,
              ...(p.config && Object.keys(p.config).length > 0 ? { config: p.config } : {}),
            }]),
          ),
          // Disable acpx (ACP agent runtime) — GenWork does not use ACP and
          // the embedded probe adds ~11s to gateway startup while it waits for
          // a process that always fails.  See openclaw/openclaw#62588.
          'acpx': { enabled: false },
        };
        const existingAllow = Array.isArray((existingPlugins as Record<string, unknown>).allow)
          ? ((existingPlugins as Record<string, unknown>).allow as unknown[])
              .filter((id): id is string => typeof id === 'string' && id.length > 0)
              .filter(id => id !== OPENCLAW_MODEL_COMPAT_PLUGIN_ID)
          : [];
        const trustedPluginAllow = Array.from(new Set([
          ...existingAllow,
          BUNDLED_BROWSER_PLUGIN_ID,
          OPENCLAW_MEMORY_CORE_PLUGIN_ID,
          // A non-empty plugins.allow is a strict allowlist in OpenClaw
          // (manifest-owner-policy "not-in-allowlist"), so runtime-bundled
          // plugins we rely on must be listed here explicitly or they never
          // load — entries.enabled alone is not enough.
          ...(hasXaiPlugin ? ['xai'] : []),
          ...(hasModelCompatConfig
            ? [OPENCLAW_MODEL_COMPAT_PLUGIN_ID]
            : []),
          ...preinstalledPlugins.map(plugin => plugin.pluginId),
          ...userPlugins.filter(plugin => plugin.enabled).map(plugin => plugin.pluginId),
        ])).sort();

        return Object.keys(pluginEntries).length > 0
          ? {
              plugins: {
                // Preserve existing plugins fields (load, deny, etc.) so
                // runtime-seeded values survive config rewrites and don't
                // cause a plugins diff → gateway restart.
                ...existingPlugins,
                // Third-party plugins live in a separate `extensions/` dir (not
                // `dist/extensions/`) and need `load.paths` so the gateway discovers
                // them with origin="config", bypassing the bundled-channel-entry
                // contract check.  See openclaw/openclaw#60196.
                ...((() => {
                  const paths = [
                    findBundledExtensionsDir(),
                    findThirdPartyExtensionsDir(),
                  ].filter((p): p is string => p !== null);
                  return paths.length > 0 ? { load: { paths } } : {};
                })()),
                // Deny list cleared — unused bundled plugins are physically removed
                // from dist/extensions/ at build time (see prune-openclaw-runtime.cjs).
                // OpenClaw validates deny IDs against discovered plugins, so denying
                // a removed plugin causes "Config invalid: plugin not found" errors.
                allow: trustedPluginAllow,
                deny: [],
                slots: {
                  ...((existingPlugins as Record<string, unknown>).slots as Record<string, unknown> | undefined),
                  memory: OPENCLAW_MEMORY_CORE_PLUGIN_ID,
                },
                entries: pluginEntries,
              },
            }
          : {};
      })())
    };

    // Sync MCP servers into OpenClaw's native mcp.servers config field.
    // OpenClaw handles connection, tool discovery, and execution natively.
    const resolvedMcpServers = this.getResolvedMcpServers?.() ?? [];
    if (resolvedMcpServers.length > 0) {
      (managedConfig as Record<string, unknown>).mcp = {
        servers: buildOpenClawMcpServers(resolvedMcpServers),
      };
    }
    console.log(`[OpenClawConfigSync] mcp.servers: ${resolvedMcpServers.length} server(s)`);

    // Sync AskUserQuestion plugin config
    const askUserCallbackUrl = this.getAskUserCallbackUrl?.();
    if (hasAskUserPlugin && askUserCallbackUrl && managedConfig.plugins) {
      const plugins = managedConfig.plugins as Record<string, unknown>;
      const entries = plugins.entries as Record<string, Record<string, unknown>>;
      entries['ask-user-question'] = {
        enabled: true,
        config: {
          callbackUrl: askUserCallbackUrl,
          secret: '${GENWORK_MCP_BRIDGE_SECRET}',
        },
      };
    }

    // Sync GenworkMediaGeneration plugin config — uses media callback endpoint
    const mediaCallbackUrl = this.getMediaCallbackUrl?.();
    if (hasMediaGenPlugin && mediaCallbackUrl && managedConfig.plugins) {
      const plugins = managedConfig.plugins as Record<string, unknown>;
      const entries = plugins.entries as Record<string, Record<string, unknown>>;
      entries['genwork-media-generation'] = {
        enabled: true,
        config: {
          callbackUrl: mediaCallbackUrl,
          secret: '${GENWORK_MCP_BRIDGE_SECRET}',
          requestTimeoutMs: 150000,
        },
      };
    }

    // Sync Dreaming config into memory-core plugin
    if (managedConfig.plugins) {
      const plugins = managedConfig.plugins as Record<string, unknown>;
      const entries = plugins.entries as Record<string, Record<string, unknown>>;
      const existingMemoryCore = entries[OPENCLAW_MEMORY_CORE_PLUGIN_ID] ?? {};
      const existingMemoryCoreConfig = (existingMemoryCore as Record<string, unknown>).config as Record<string, unknown> | undefined;
      if (coworkConfig.dreamingEnabled) {
        entries[OPENCLAW_MEMORY_CORE_PLUGIN_ID] = {
          ...existingMemoryCore,
          enabled: true,
          config: {
            ...existingMemoryCoreConfig,
            dreaming: {
              enabled: true,
              frequency: coworkConfig.dreamingFrequency || '0 3 * * *',
            },
          },
        };
      } else {
        entries[OPENCLAW_MEMORY_CORE_PLUGIN_ID] = {
          ...existingMemoryCore,
          enabled: true,
          config: {
            ...existingMemoryCoreConfig,
            dreaming: {
              enabled: false,
            },
          },
        };
      }
    }

    // Sync Telegram OpenClaw channel config — multi-instance via accounts
    const telegramInstances = this.getTelegramInstances();
    const enabledTelegramInstances = telegramInstances.filter(i => i.enabled && i.botToken);
    if (enabledTelegramInstances.length > 0) {
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledTelegramInstances.length; idx++) {
        const inst = enabledTelegramInstances[idx];
        const tokenVar = idx === 0 ? 'GENWORK_TG_BOT_TOKEN' : `GENWORK_TG_BOT_TOKEN_${idx}`;
        const webhookSecretVar = idx === 0 ? 'GENWORK_TG_WEBHOOK_SECRET' : `GENWORK_TG_WEBHOOK_SECRET_${idx}`;
        const account: Record<string, unknown> = {
          enabled: true,
          name: inst.instanceName,
          botToken: `\${${tokenVar}}`,
          dmPolicy: inst.dmPolicy || 'open',
          allowFrom: (() => {
            const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
            if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
          groupPolicy: inst.groupPolicy || 'allowlist',
          groupAllowFrom: (() => {
            const ids = inst.groupAllowFrom?.length ? [...inst.groupAllowFrom] : [];
            if (inst.groupPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
          groups:
            inst.groups && Object.keys(inst.groups).length > 0
              ? inst.groups
              : { '*': { requireMention: true } },
          historyLimit: inst.historyLimit || 50,
          replyToMode: inst.replyToMode || 'off',
          linkPreview: inst.linkPreview ?? true,
          streaming: buildStreamingModeConfig(inst.streaming || 'off'),
          mediaMaxMb: inst.mediaMaxMb || 5,
        };
        if (inst.proxy) {
          account.proxy = inst.proxy;
        }
        if (inst.webhookUrl) {
          account.webhookUrl = inst.webhookUrl;
          if (inst.webhookSecret) {
            account.webhookSecret = `\${${webhookSecretVar}}`;
          }
        }
        accounts[inst.instanceId.slice(0, 8)] = account;
      }
      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        telegram: { enabled: true, accounts },
      };
    }
    // When disabled, omit the channel key entirely so OpenClaw won't load the plugin.

    // Sync Discord OpenClaw channel config — multi-instance via accounts
    const enabledDiscordInstances = discordInstances.filter(i => i.enabled && i.botToken);
    if (enabledDiscordInstances.length > 0) {
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledDiscordInstances.length; idx++) {
        const inst = enabledDiscordInstances[idx];
        const tokenVar = idx === 0 ? 'GENWORK_DC_BOT_TOKEN' : `GENWORK_DC_BOT_TOKEN_${idx}`;
        const account: Record<string, unknown> = {
          enabled: true,
          name: inst.instanceName,
          token: `\${${tokenVar}}`,
          dm: {
            policy: inst.dmPolicy || 'open',
            allowFrom: (() => {
              const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
              if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
              return ids;
            })(),
          },
          groupPolicy: inst.groupPolicy || 'allowlist',
          guilds: (() => {
            const guilds: Record<string, unknown> = {};
            if (inst.groupAllowFrom?.length) {
              for (const guildId of inst.groupAllowFrom) {
                guilds[guildId] = inst.guilds?.[guildId] || {};
              }
            }
            if (inst.guilds && Object.keys(inst.guilds).length > 0) {
              for (const [key, guildConfig] of Object.entries(inst.guilds)) {
                const existing = (guilds[key] || {}) as Record<string, unknown>;
                guilds[key] = {
                  ...existing,
                  ...(guildConfig.requireMention !== undefined
                    ? { requireMention: guildConfig.requireMention }
                    : {}),
                  ...(guildConfig.allowFrom?.length ? { users: guildConfig.allowFrom } : {}),
                  ...(guildConfig.systemPrompt ? { systemPrompt: guildConfig.systemPrompt } : {}),
                };
              }
            }
            return Object.keys(guilds).length > 0 ? guilds : { '*': { requireMention: true } };
          })(),
          historyLimit: inst.historyLimit || 50,
          streaming: buildStreamingModeConfig(inst.streaming || 'off'),
          mediaMaxMb: inst.mediaMaxMb || 25,
        };
        if (inst.proxy) {
          account.proxy = inst.proxy;
        }
        accounts[inst.instanceId.slice(0, 8)] = account;
      }
      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        discord: { enabled: true, accounts },
      };
    }

    // Sync Feishu OpenClaw channel config (via @larksuite/openclaw-lark) — multi-instance via accounts
    const enabledFeishuInstances = feishuInstances.filter(i => i.enabled && i.appId);
    if (enabledFeishuInstances.length > 0) {
      const buildFeishuAccountConfig = (
        inst: (typeof enabledFeishuInstances)[0],
        secretEnvVar: string,
      ): Record<string, unknown> => ({
        enabled: true,
        name: inst.instanceName,
        appId: inst.appId,
        appSecret: `\${${secretEnvVar}}`,
        domain: inst.domain || 'feishu',
        dmPolicy: inst.dmPolicy || 'open',
        allowFrom: (() => {
          const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
          if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
          return ids;
        })(),
        groupPolicy: inst.groupPolicy || 'allowlist',
        groupAllowFrom: (() => {
          const ids = inst.groupAllowFrom?.length ? [...inst.groupAllowFrom] : [];
          if (inst.groupPolicy === 'open' && !ids.includes('*')) ids.push('*');
          return ids;
        })(),
        groups:
          inst.groups && Object.keys(inst.groups).length > 0
            ? inst.groups
            : { '*': { requireMention: true } },
        historyLimit: inst.historyLimit || 50,
        streaming: inst.streaming ?? true,
        replyMode: inst.replyMode || 'auto',
        blockStreaming: inst.blockStreaming ?? false,
        ...(inst.footer ? { footer: inst.footer } : {}),
        ...(inst.blockStreamingCoalesce
          ? { blockStreamingCoalesce: inst.blockStreamingCoalesce }
          : {}),
        mediaMaxMb: inst.mediaMaxMb || 30,
      });

      // All instances go into `accounts` dict
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledFeishuInstances.length; idx++) {
        const inst = enabledFeishuInstances[idx];
        const secretVar =
          idx === 0 ? 'GENWORK_FEISHU_APP_SECRET' : `GENWORK_FEISHU_APP_SECRET_${idx}`;
        accounts[inst.instanceId.slice(0, 8)] = buildFeishuAccountConfig(inst, secretVar);
      }

      managedConfig.channels = { ...(managedConfig.channels as Record<string, unknown> || {}), feishu: { enabled: true, accounts } };
    }

    // Sync DingTalk OpenClaw channel config (via dingtalk-connector plugin) — multi-instance via accounts
    const enabledDingTalkInstances = dingTalkInstances.filter(i => i.enabled && i.clientId);
    if (enabledDingTalkInstances.length > 0) {
      const buildDingTalkAccountConfig = (
        inst: (typeof enabledDingTalkInstances)[0],
        secretEnvVar: string,
      ): Record<string, unknown> => ({
        enabled: true,
        name: inst.instanceName,
        clientId: inst.clientId,
        clientSecret: `\${${secretEnvVar}}`,
        // v3.5.x schema: dmPolicy/groupPolicy/allowFrom are valid; sessionTimeout/
        // separateSessionByConversation/groupSessionScope/sharedMemoryAcrossConversations/
        // gatewayBaseUrl were GenWork-specific and are not in the plugin schema.
        dmPolicy: inst.dmPolicy || 'open',
        allowFrom: (() => {
          const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
          if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
          return ids;
        })(),
        groupPolicy: inst.groupPolicy || 'open',
      });

      // All instances go into `accounts` dict
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledDingTalkInstances.length; idx++) {
        const inst = enabledDingTalkInstances[idx];
        const secretVar =
          idx === 0 ? 'GENWORK_DINGTALK_CLIENT_SECRET' : `GENWORK_DINGTALK_CLIENT_SECRET_${idx}`;
        accounts[inst.instanceId.slice(0, 8)] = buildDingTalkAccountConfig(inst, secretVar);
      }

      const dingtalkChannel: Record<string, unknown> = { enabled: true, accounts };

      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        [DINGTALK_OPENCLAW_CHANNEL]: dingtalkChannel,
      };
    }

    // Sync QQ OpenClaw channel config (via qqbot plugin) — multi-instance via accounts
    const enabledQQInstances = qqInstances.filter(i => i.enabled && i.appId);
    if (enabledQQInstances.length > 0) {
      const buildQQAccountConfig = (
        inst: (typeof enabledQQInstances)[0],
        secretEnvVar: string,
      ): Record<string, unknown> => {
        const account: Record<string, unknown> = {
          enabled: true,
          name: inst.instanceName,
          appId: inst.appId,
          clientSecret: `\${${secretEnvVar}}`,
          // v2026.4.8 schema removed dmPolicy/groupPolicy/groupAllowFrom/historyLimit.
          // Only allowFrom and markdownSupport remain as valid account properties.
          allowFrom: (() => {
            const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
            if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
          markdownSupport: inst.markdownSupport ?? true,
        };
        if (inst.imageServerBaseUrl) {
          account.imageServerBaseUrl = inst.imageServerBaseUrl;
        }
        return account;
      };

      // All instances go into `accounts` dict
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledQQInstances.length; idx++) {
        const inst = enabledQQInstances[idx];
        const secretVar =
          idx === 0 ? 'GENWORK_QQ_CLIENT_SECRET' : `GENWORK_QQ_CLIENT_SECRET_${idx}`;
        accounts[inst.instanceId.slice(0, 8)] = buildQQAccountConfig(inst, secretVar);
      }

      managedConfig.channels = { ...(managedConfig.channels as Record<string, unknown> || {}), qqbot: { enabled: true, accounts } };
    }

    // Sync WeCom OpenClaw channel config (via wecom-openclaw-plugin) — multi-instance via accounts
    const enabledWecomInstances = wecomInstances.filter(i => i.enabled && i.botId);
    if (enabledWecomInstances.length > 0) {
      const accounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledWecomInstances.length; idx++) {
        const inst = enabledWecomInstances[idx];
        const secretVar = idx === 0 ? 'GENWORK_WECOM_SECRET' : `GENWORK_WECOM_SECRET_${idx}`;
        accounts[inst.instanceId.slice(0, 8)] = {
          enabled: true,
          name: inst.instanceName,
          botId: inst.botId,
          secret: `\${${secretVar}}`,
          dmPolicy: inst.dmPolicy || 'open',
          allowFrom: (() => {
            const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
            if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
          groupPolicy: inst.groupPolicy || 'open',
          groupAllowFrom: (() => {
            const ids = inst.groupAllowFrom?.length ? [...inst.groupAllowFrom] : [];
            if (inst.groupPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
          sendThinkingMessage: inst.sendThinkingMessage ?? true,
        };
      }
      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        wecom: { accounts },
      };
    }

    // Sync POPO OpenClaw channel config (via moltbot-popo plugin) — multi-instance via accounts
    const enabledPopoInstances = popoInstances.filter(i => i.enabled && i.appKey);
    if (enabledPopoInstances.length > 0) {
      const popoAccounts: Record<string, unknown> = {};
      for (let idx = 0; idx < enabledPopoInstances.length; idx++) {
        const inst = enabledPopoInstances[idx];
        // Migration: old configs lack connectionMode. If token is set, the user
        // was using webhook mode; otherwise default to the new websocket mode.
        const effectiveConnectionMode =
          inst.connectionMode || (inst.token ? 'webhook' : 'websocket');
        const isWebSocket = effectiveConnectionMode === 'websocket';
        const secretVar = idx === 0 ? 'GENWORK_POPO_APP_SECRET' : `GENWORK_POPO_APP_SECRET_${idx}`;
        const account: Record<string, unknown> = {
          enabled: true,
          name: inst.instanceName,
          connectionMode: effectiveConnectionMode,
          appKey: inst.appKey,
          appSecret: `\${${secretVar}}`,
          aesKey: inst.aesKey,
          dmPolicy: inst.dmPolicy || 'open',
          allowFrom: (() => {
            const ids = inst.allowFrom?.length ? [...inst.allowFrom] : [];
            if (inst.dmPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
          groupPolicy: inst.groupPolicy || 'open',
          groupAllowFrom: (() => {
            const ids = inst.groupAllowFrom?.length ? [...inst.groupAllowFrom] : [];
            if (inst.groupPolicy === 'open' && !ids.includes('*')) ids.push('*');
            return ids;
          })(),
        };
        // Webhook-only fields
        if (!isWebSocket) {
          const tokenVar = idx === 0 ? 'GENWORK_POPO_TOKEN' : `GENWORK_POPO_TOKEN_${idx}`;
          account.token = `\${${tokenVar}}`;
          account.webhookPort = inst.webhookPort || 3100;
          if (inst.webhookBaseUrl) {
            account.webhookBaseUrl = inst.webhookBaseUrl;
          }
          if (inst.webhookPath && inst.webhookPath !== '/popo/callback') {
            account.webhookPath = inst.webhookPath;
          }
        }
        if (inst.textChunkLimit && inst.textChunkLimit !== 3000) {
          account.textChunkLimit = inst.textChunkLimit;
        }
        if (inst.richTextChunkLimit && inst.richTextChunkLimit !== 5000) {
          account.richTextChunkLimit = inst.richTextChunkLimit;
        }
        popoAccounts[inst.instanceId.slice(0, 8)] = account;
      }
      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        'moltbot-popo': { enabled: true, accounts: popoAccounts },
      };
    }

    // Sync Email OpenClaw channel config (multi-instance)
    if (emailConfig?.instances && emailConfig.instances.length > 0) {
      const enabledInstances = emailConfig.instances.filter(i => i.enabled && i.email);

      if (enabledInstances.length > 0) {
        const accounts: Record<string, unknown> = {};

        for (const inst of enabledInstances) {
          const accountId = inst.instanceId;
          // Transform instanceId: email-1 → 1, email-work → WORK, uuid → UUID (dashes replaced with underscores)
          const envSuffix = accountId.replace(/^email-/, '').replace(/-/g, '_').toUpperCase();

          const accountConfig: Record<string, unknown> = {
            enabled: true,
            name: inst.instanceName,
            email: inst.email,
            transport: inst.transport,
          };

          // IMAP/SMTP mode configuration
          if (inst.transport === 'imap') {
            accountConfig.password = `\${GENWORK_EMAIL_${envSuffix}_PASSWORD}`;
            if (inst.imapHost) accountConfig.imapHost = inst.imapHost;
            if (inst.imapPort) accountConfig.imapPort = inst.imapPort;
            if (inst.smtpHost) accountConfig.smtpHost = inst.smtpHost;
            if (inst.smtpPort) accountConfig.smtpPort = inst.smtpPort;
          }

          // WebSocket mode configuration
          if (inst.transport === 'ws') {
            accountConfig.apiKey = `\${GENWORK_EMAIL_${envSuffix}_APIKEY}`;
          }

          // Common configuration
          if (inst.allowFrom?.length) {
            accountConfig.allowFrom = inst.allowFrom;
          }
          if (inst.replyMode) {
            accountConfig.replyMode = inst.replyMode;
          }
          if (inst.replyTo) {
            accountConfig.replyTo = inst.replyTo;
          }

          // A2A configuration
          if (
            inst.a2aEnabled !== undefined ||
            inst.a2aAgentDomains?.length ||
            inst.a2aMaxPingPongTurns
          ) {
            accountConfig.a2a = {
              enabled: inst.a2aEnabled ?? true,
              ...(inst.a2aAgentDomains?.length ? { agentDomains: inst.a2aAgentDomains } : {}),
              ...(inst.a2aMaxPingPongTurns ? { maxPingPongTurns: inst.a2aMaxPingPongTurns } : {}),
            };
          }

          accounts[accountId] = accountConfig;
        }

        managedConfig.channels = {
          ...((managedConfig.channels as Record<string, unknown>) || {}),
          email: {
            enabled: true,
            accounts,
          },
        };
      }
    }
    // Sync Weixin OpenClaw channel config (via openclaw-weixin plugin)
    // Only write the channel entry when the plugin is actually installed,
    // otherwise the gateway rejects the config as invalid.
    if (hasPreinstalledPlugin('openclaw-weixin')) {
      const weixinChannelEnabled = !!weixinConfig?.enabled;
      const weixinChannel: Record<string, unknown> = {
        enabled: weixinChannelEnabled,
        dmPolicy: weixinConfig?.dmPolicy || 'open',
        allowFrom: (() => {
          const ids = weixinConfig?.allowFrom?.length ? [...weixinConfig.allowFrom] : [];
          if ((weixinConfig?.dmPolicy || 'open') === 'open' && !ids.includes('*')) ids.push('*');
          return ids;
        })(),
      };
      managedConfig.channels = {
        ...((managedConfig.channels as Record<string, unknown>) || {}),
        'openclaw-weixin': weixinChannel,
      };
    }

    // Binding changes are detected via bindingsChanged (line ~1035) which
    // triggers a hard gateway restart in the caller.  We no longer inject
    // _agentBinding into channel configs because OpenClaw plugins using
    // additionalProperties:false reject the extra field and crash.

    const nextContent = `${JSON.stringify(managedConfig, null, 2)}\n`;
    console.log('[OpenClawConfigSync] sync() managedConfig key fields:', {
      providers: (managedConfig.models as Record<string, unknown>)?.providers,
      primaryModel: (
        (managedConfig.agents as Record<string, unknown>)?.defaults as Record<string, unknown>
      )?.model,
    });
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(configPath, 'utf8');
    } catch {
      currentContent = '';
    }

    // Compare ignoring `meta` — it contains timestamps that change on every
    // write and should not trigger a gateway restart.
    const configChanged = (() => {
      if (!currentContent) return true;
      try {
        const cur = JSON.parse(currentContent);
        delete cur.meta;
        const nxt = JSON.parse(nextContent);
        delete nxt.meta;
        return JSON.stringify(cur) !== JSON.stringify(nxt);
      } catch {
        return currentContent !== nextContent;
      }
    })();
    const modelCompatRestartRequired = (() => {
      if (!configChanged) return false;
      let previousConfig: unknown = {};
      try {
        previousConfig = currentContent ? JSON.parse(currentContent) : {};
      } catch {
        // Treat an unreadable previous config as having no trusted managed
        // compatibility ownership. The next generated config remains valid.
      }
      return modelCompatConfigChangeRequiresRestart(
        previousConfig,
        JSON.parse(nextContent),
      );
    })();

    let changedTopLevelKeys: string[] = [];
    if (configChanged) {
      // Diagnostic: diff gateway and plugins sections to identify what triggers OpenClaw restart
      try {
        const currentObj = currentContent ? JSON.parse(currentContent) : {};
        const nextObj = JSON.parse(nextContent);
        const curGw = JSON.stringify(currentObj.gateway ?? {});
        const nxtGw = JSON.stringify(nextObj.gateway ?? {});
        const curPl = JSON.stringify(currentObj.plugins ?? {});
        const nxtPl = JSON.stringify(nextObj.plugins ?? {});
        if (curGw !== nxtGw) {
          console.log(`${gwDiagTs()} gateway DIFF:`);
          console.log(`${gwDiagTs()} old gateway keys:`, Object.keys(currentObj.gateway ?? {}).sort().join(','));
          console.log(`${gwDiagTs()} new gateway keys:`, Object.keys(nextObj.gateway ?? {}).sort().join(','));
          console.log(`${gwDiagTs()} old gateway:`, curGw.slice(0, 500));
          console.log(`${gwDiagTs()} new gateway:`, nxtGw.slice(0, 500));
        } else {
          console.log(`${gwDiagTs()} gateway section UNCHANGED`);
        }
        if (curPl !== nxtPl) {
          console.log(`${gwDiagTs()} plugins DIFF:`);
          console.log(`${gwDiagTs()} old plugin entry keys:`, Object.keys((currentObj.plugins?.entries) ?? {}).sort().join(','));
          console.log(`${gwDiagTs()} new plugin entry keys:`, Object.keys((nextObj.plugins?.entries) ?? {}).sort().join(','));
        } else {
          console.log(`${gwDiagTs()} plugins section UNCHANGED`);
        }
        // Check which top-level keys actually changed
        const allKeys = new Set([...Object.keys(currentObj), ...Object.keys(nextObj)]);
        changedTopLevelKeys = [...allKeys].filter(k => {
          if (k === 'meta') return false;
          return JSON.stringify(currentObj[k]) !== JSON.stringify(nextObj[k]);
        });
        console.log(`${gwDiagTs()} top-level changed keys:`, changedTopLevelKeys.join(',') || '(none)');
      } catch { /* ignore parse errors in diag */ }
      try {
        ensureDir(path.dirname(configPath));
        const stampedContent = `${JSON.stringify(this.stampConfigMeta(managedConfig), null, 2)}\n`;
        const tmpPath = `${configPath}.tmp-${Date.now()}`;
        fs.writeFileSync(tmpPath, stampedContent, 'utf8');
        fs.renameSync(tmpPath, configPath);
      } catch (error) {
        return {
          ok: false,
          changed: false,
          configPath,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const sessionStoreChanged = this.syncManagedSessionStore(providerSelection, allProvidersMap);

    // Ensure exec-approvals.json has security=full + ask=off so the gateway
    // never triggers approval-pending for any command.
    this.ensureExecApprovalDefaults();

    // Sync AGENTS.md with skills routing prompt to the OpenClaw workspace directory.
    // This runs on every sync regardless of openclaw.json changes, because skills
    // may have been installed/enabled/disabled independently.
    const agentsMdWarning = this.syncAgentsMd(mainWorkspacePath, coworkConfig);

    // Sync per-agent workspace files (SOUL.md, IDENTITY.md, AGENTS.md) for non-main agents
    this.syncPerAgentWorkspaces(mainWorkspacePath, coworkConfig);

    return {
      ok: true,
      changed: configChanged || sessionStoreChanged,
      configPath,
      ...(bindingsChanged ? { bindingsChanged } : {}),
      ...(changedTopLevelKeys.length > 0 ? { changedTopLevelKeys } : {}),
      ...(changedTopLevelKeys.includes('mcp') || modelCompatRestartRequired
        ? { restartImpact: OpenClawConfigImpact.Restart }
        : {}),
      ...(agentsMdWarning ? { agentsMdWarning } : {}),
    };
  }

  /**
   * Collect all secret values that should be injected as environment variables
   * into the OpenClaw gateway process. The openclaw.json file uses `${VAR}`
   * placeholders for these values so that no plaintext secrets are stored on disk.
   */
  collectSecretEnvVars(): Record<string, string> {
    const env: Record<string, string> = {};

    // Provider API Keys — one per configured provider so switching models
    // never changes env vars and avoids gateway process restarts.
    const allApiKeys = resolveAllProviderApiKeys();
    for (const [envSuffix, apiKey] of Object.entries(allApiKeys)) {
      console.info(`[OpenClawConfigSync] set secret env var GENWORK_APIKEY_${envSuffix} for provider ${envSuffix}`);
      env[`GENWORK_APIKEY_${envSuffix}`] = apiKey;
    }
    // Legacy fallback: keep GENWORK_PROVIDER_API_KEY set to a stable value so stale
    // openclaw.json files with the old placeholder don't crash the gateway.
    // Use the active provider's key if available, but ONLY for the first sync —
    // after that, openclaw.json uses provider-specific placeholders and this var
    // is never resolved. Use a fixed value to avoid secretEnvVarsChanged on switch.
    env.GENWORK_PROVIDER_API_KEY = 'legacy-unused';

    env.GENWORK_PROXY_TOKEN = getCoworkOpenAICompatProxyToken() || 'unconfigured';

    // MCP Bridge Secret — always set so stale openclaw.json with
    // ${GENWORK_MCP_BRIDGE_SECRET} placeholder doesn't crash the gateway.
    // Used by the ask-user-question plugin.
    env.GENWORK_MCP_BRIDGE_SECRET = this.getMcpBridgeSecret?.() || 'unconfigured';

    // Telegram — per-instance secrets (must match sync() indexing: enabled instances only)
    const tgInstances = this.getTelegramInstances();
    const enabledTelegram = tgInstances.filter(i => i.enabled && i.botToken);
    for (let idx = 0; idx < enabledTelegram.length; idx++) {
      const inst = enabledTelegram[idx];
      if (idx === 0) {
        env.GENWORK_TG_BOT_TOKEN = inst.botToken;
        if (inst.webhookSecret) env.GENWORK_TG_WEBHOOK_SECRET = inst.webhookSecret;
      } else {
        env[`GENWORK_TG_BOT_TOKEN_${idx}`] = inst.botToken;
        if (inst.webhookSecret) env[`GENWORK_TG_WEBHOOK_SECRET_${idx}`] = inst.webhookSecret;
      }
    }

    // Discord — per-instance secrets (must match sync() indexing: enabled instances only)
    const dcInstances = this.getDiscordInstances();
    const enabledDiscord = dcInstances.filter(i => i.enabled && i.botToken);
    for (let idx = 0; idx < enabledDiscord.length; idx++) {
      if (idx === 0) {
        env.GENWORK_DC_BOT_TOKEN = enabledDiscord[idx].botToken;
      } else {
        env[`GENWORK_DC_BOT_TOKEN_${idx}`] = enabledDiscord[idx].botToken;
      }
    }

    // Feishu — per-instance secrets (must match sync() indexing: enabled instances only)
    const feishuInstances = this.getFeishuInstances();
    const enabledFeishu = feishuInstances.filter(i => i.enabled && i.appSecret);
    for (let idx = 0; idx < enabledFeishu.length; idx++) {
      if (idx === 0) {
        env.GENWORK_FEISHU_APP_SECRET = enabledFeishu[idx].appSecret;
      } else {
        env[`GENWORK_FEISHU_APP_SECRET_${idx}`] = enabledFeishu[idx].appSecret;
      }
    }

    // DingTalk — per-instance secrets (must match sync() indexing: enabled instances only)
    const dingTalkInstances = this.getDingTalkInstances();
    const enabledDingTalk = dingTalkInstances.filter(i => i.enabled && i.clientSecret);
    for (let idx = 0; idx < enabledDingTalk.length; idx++) {
      if (idx === 0) {
        env.GENWORK_DINGTALK_CLIENT_SECRET = enabledDingTalk[idx].clientSecret;
      } else {
        env[`GENWORK_DINGTALK_CLIENT_SECRET_${idx}`] = enabledDingTalk[idx].clientSecret;
      }
    }
    // Gateway token is shared (not per-instance)
    const gatewayToken = this.engineManager.getGatewayToken();
    if (gatewayToken) {
      env.GENWORK_DINGTALK_GW_TOKEN = gatewayToken;
    }

    // QQ — per-instance secrets (must match sync() indexing: enabled instances only)
    const qqInstances = this.getQQInstances();
    const enabledQQ = qqInstances.filter(i => i.enabled && i.appSecret);
    for (let idx = 0; idx < enabledQQ.length; idx++) {
      if (idx === 0) {
        env.GENWORK_QQ_CLIENT_SECRET = enabledQQ[idx].appSecret;
      } else {
        env[`GENWORK_QQ_CLIENT_SECRET_${idx}`] = enabledQQ[idx].appSecret;
      }
    }

    // WeCom — per-instance secrets (must match sync() indexing: enabled instances only)
    const wecomInstances = this.getWecomInstances();
    const enabledWecom = wecomInstances.filter(i => i.enabled && i.secret);
    for (let idx = 0; idx < enabledWecom.length; idx++) {
      if (idx === 0) {
        env.GENWORK_WECOM_SECRET = enabledWecom[idx].secret;
      } else {
        env[`GENWORK_WECOM_SECRET_${idx}`] = enabledWecom[idx].secret;
      }
    }

    // POPO — per-instance secrets (must match sync() indexing: enabled instances only)
    const enabledPopo = this.getPopoInstances().filter(i => i.enabled && i.appSecret);
    for (let idx = 0; idx < enabledPopo.length; idx++) {
      if (idx === 0) {
        env.GENWORK_POPO_APP_SECRET = enabledPopo[idx].appSecret;
        if (enabledPopo[idx].token) {
          env.GENWORK_POPO_TOKEN = enabledPopo[idx].token;
        } else {
          // Provide non-empty fallback so stale openclaw.json files that still
          // contain ${GENWORK_POPO_TOKEN} from a previous webhook config
          // don't crash the gateway with MissingEnvVarError.
          env.GENWORK_POPO_TOKEN = 'unconfigured';
        }
      } else {
        env[`GENWORK_POPO_APP_SECRET_${idx}`] = enabledPopo[idx].appSecret;
        if (enabledPopo[idx].token) {
          env[`GENWORK_POPO_TOKEN_${idx}`] = enabledPopo[idx].token;
        } else {
          env[`GENWORK_POPO_TOKEN_${idx}`] = 'unconfigured';
        }
      }
    }

    // Email credentials
    const emailConfig = this.getEmailOpenClawConfig?.();
    if (emailConfig?.instances) {
      for (const inst of emailConfig.instances) {
        if (!inst.enabled || !inst.email) continue;

        const envSuffix = inst.instanceId.replace(/^email-/, '').replace(/-/g, '_').toUpperCase();

        if (inst.transport === 'imap' && inst.password) {
          env[`GENWORK_EMAIL_${envSuffix}_PASSWORD`] = inst.password;
        }

        if (inst.transport === 'ws' && inst.apiKey) {
          env[`GENWORK_EMAIL_${envSuffix}_APIKEY`] = inst.apiKey;
        }
      }
    }

    const D = gwDiagTs;
    const keysSummary = Object.keys(env).sort().map(k => {
      const v = env[k];
      return `${k}=${v.length > 6 ? v.slice(0, 3) + '***' + v.slice(-2) : '***'}`;
    });
    console.log(`${D()} collectSecretEnvVars: ${Object.keys(env).length} keys: ${keysSummary.join(', ')}`);

    return env;
  }

  /**
   * Ensures exec-approvals.json under the GenWork-managed openclaw home has
   * security=full + ask=off so the gateway never triggers approval-pending
   * for any command. The path must match the OPENCLAW_HOME env var passed to
   * the gateway process so both sides read/write the same file.
   * Delete-command protection is handled via the system prompt instead.
   */
  private ensureExecApprovalDefaults(): void {
    const filePath = path.join(this.engineManager.getBaseDir(), '.openclaw', 'exec-approvals.json');

    type AgentEntry = { security?: string; ask?: string; [key: string]: unknown };
    type ApprovalsFile = {
      version: number;
      agents?: Record<string, AgentEntry>;
      [key: string]: unknown;
    };

    let file: ApprovalsFile;
    try {
      if (fs.existsSync(filePath)) {
        file = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ApprovalsFile;
        if (file?.version !== 1) file = { version: 1 };
      } else {
        file = { version: 1 };
      }
    } catch {
      file = { version: 1 };
    }

    if (!file.agents) file.agents = {};
    if (!file.agents.main) file.agents.main = {};
    const agent = file.agents.main;

    if (agent.security === 'full' && agent.ask === 'off') return;

    agent.security = 'full';
    agent.ask = 'off';

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.atomicWriteFile(filePath, `${JSON.stringify(file, null, 2)}\n`);
      console.log('[OpenClawConfigSync] set exec-approvals security=full ask=off');
    } catch (error) {
      console.warn('[OpenClawConfigSync] failed to write exec-approvals.json:', error);
    }
  }

  private syncManagedSessionStore(
    selection: OpenClawProviderSelection,
    availableProviders: Record<string, OpenClawProviderSelection['providerConfig']>,
  ): boolean {
    const shouldMigrateManagedModelRefs = !(
      selection.providerId === 'genwork' && selection.sessionModelId === selection.legacyModelId
    );
    const fallbackTarget = parsePrimaryModelRef(selection.primaryModel) ?? {
      providerId: selection.providerId,
      modelId: selection.sessionModelId,
      primaryModel: selection.primaryModel,
    };
    const configuredAgents = this.getAgents?.() ?? [];
    const agentById = new Map(configuredAgents.map(agent => [agent.id, agent]));
    if (!agentById.has(AgentId.Main)) {
      agentById.set(AgentId.Main, {
        id: AgentId.Main,
        name: DefaultAgentProfile.Name,
        description: '',
        systemPrompt: '',
        identity: '',
        aboutYou: '',
        model: '',
        thinkingLevel: '',
        workingDirectory: '',
        icon: '',
        skillIds: [],
        subagentAllowAgentIds: [],
        serverSkillIds: [],
        serverSubagentAllowAgentIds: [],
        serverImChannels: [],
        enabled: true,
        pinned: false,
        pinOrder: null,
        isDefault: true,
        source: 'custom',
        presetId: '',
        createdAt: 0,
        updatedAt: 0,
      });
    }

    let anyChanged = false;
    for (const [agentId, agent] of agentById.entries()) {
      const agentModel = this.getAgentModelOverride
        ? effectiveAgentModelRef(agent, this.getAgentModelOverride)
        : agent.model;
      const qualification = resolveQualifiedAgentModelRef({
        agentModel,
        availableProviders,
      });
      if (qualification.status === 'ambiguous') {
        console.warn(
          `[OpenClawConfigSync] Skipped ambiguous managed session model sync for "${agent.id}" because "${qualification.modelId}" matches multiple providers: ${qualification.providerIds.join(', ')}`,
        );
      }

      const sessionStorePath = path.join(
        this.engineManager.getStateDir(),
        'agents',
        agentId,
        'sessions',
        'sessions.json',
      );

      let storeContent = '';
      try {
        storeContent = fs.readFileSync(sessionStorePath, 'utf8');
      } catch {
        continue;
      }

      let sessionStore: Record<string, unknown>;
      try {
        sessionStore = JSON.parse(storeContent) as Record<string, unknown>;
      } catch {
        continue;
      }

      let changed = false;
      for (const [sessionKey, rawEntry] of Object.entries(sessionStore)) {
        if (!rawEntry || typeof rawEntry !== 'object') {
          continue;
        }

        const entry = rawEntry as Record<string, unknown>;
        if (parseChannelSessionKey(sessionKey) !== null) {
          const execSecurity =
            typeof entry.execSecurity === 'string' ? entry.execSecurity.trim() : '';
          if (execSecurity !== 'full') {
            entry.execSecurity = 'full';
            changed = true;
          }
          if (sessionSnapshotContainsDisabledManagedSkill(entry)) {
            delete entry.skillsSnapshot;
            changed = true;
          }
        }

        if (!/^agent:[^:]+:genwork:/.test(sessionKey)) {
          continue;
        }

        const entryProvider =
          typeof entry.modelProvider === 'string' ? entry.modelProvider.trim() : '';
        if (qualification.status === 'ambiguous') {
          continue;
        }

        const target = resolveManagedSessionModelTarget({
          agentModel:
            qualification.status === 'qualified' ? qualification.primaryModel : agentModel,
          fallbackPrimaryModel: fallbackTarget.primaryModel,
          availableProviders,
          currentProviderId: entryProvider,
        });

        if (shouldMigrateManagedModelRefs) {
          const entryModel = typeof entry.model === 'string' ? entry.model.trim() : '';
          if (entryProvider !== target.providerId || entryModel !== target.modelId) {
            entry.modelProvider = target.providerId;
            entry.model = target.modelId;
            changed = true;
          }

          const systemPromptReport = entry.systemPromptReport;
          if (systemPromptReport && typeof systemPromptReport === 'object') {
            const report = systemPromptReport as Record<string, unknown>;
            const reportProvider =
              typeof report.provider === 'string' ? report.provider.trim() : '';
            const reportModel = typeof report.model === 'string' ? report.model.trim() : '';
            if (reportProvider !== target.providerId) {
              report.provider = target.providerId;
              changed = true;
            }
            if (reportModel !== target.modelId) {
              report.model = target.modelId;
              changed = true;
            }
          }
        }
      }

      if (!changed) {
        continue;
      }

      try {
        this.atomicWriteFile(sessionStorePath, `${JSON.stringify(sessionStore, null, 2)}\n`);
        anyChanged = true;
      } catch (error) {
        console.warn(
          '[OpenClawConfigSync] Failed to update managed session store:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return anyChanged;
  }

  /**
   * Resolve the GenWork SKILLs installation directory for OpenClaw's
   * `skills.load.extraDirs` configuration.
   *
   * Cross-platform paths (via Electron app.getPath('userData')):
   *   macOS:   ~/Library/Application Support/GenWork/SKILLs
   *   Windows: %APPDATA%/GenWork/SKILLs
   *   Linux:   ~/.config/GenWork/SKILLs
   */
  private resolveSkillsExtraDirs(): string[] {
    const userDataSkillsDir = path.join(app.getPath('userData'), 'SKILLs');
    try {
      if (fs.statSync(userDataSkillsDir).isDirectory()) {
        return [userDataSkillsDir];
      }
    } catch (err: unknown) {
      // ENOENT is expected on fresh installs before any skills sync.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        console.warn('[OpenClawConfigSync] Failed to stat SKILLs directory:', err);
      }
    }
    return [];
  }

  /**
   * Build per-skill `enabled` overrides from the GenWork SkillManager state,
   * so that skills disabled in the GenWork UI are also hidden from OpenClaw.
   *
   * Entries must be keyed by the skill's frontmatter `name`, not the
   * directory-derived `id`: OpenClaw resolves these overrides through
   * `resolveSkillKey()`, which uses the frontmatter name (falling back to the
   * directory name only when the frontmatter has none — the same fallback
   * SkillManager applies to `SkillRecord.name`).
   */
  private buildSkillEntries(): Record<string, { enabled: boolean }> {
    const skills = this.getSkillsList?.() ?? [];
    const entries: Record<string, { enabled: boolean }> = {};
    for (const skill of skills) {
      const existing = entries[skill.name];
      if (existing && existing.enabled !== skill.enabled) {
        console.warn(
          `[OpenClawConfigSync] Skills with duplicate name "${skill.name}" disagree on enabled state; last one wins`,
        );
      }
      entries[skill.name] = { enabled: skill.enabled };
    }
    return entries;
  }

  /**
   * Update the set of frontmatter names the access gate has marked revoked
   * (installed org skills no longer visible to the caller). Called by the
   * periodic marketplace re-fetch in `main.ts` whenever the set changes.
   */
  setRevokedSkillNames(names: Iterable<string>): void {
    this.revokedSkillNames = new Set(names);
  }

  /**
   * Hard `enabled=false` overrides for revoked skills. Merged **after**
   * `buildSkillEntries()` and `MANAGED_SKILL_ENTRY_OVERRIDES` so a revoked
   * org skill is blocked even when its local record says enabled. Keyed by
   * frontmatter `name` (the same key OpenClaw's `resolveSkillKey` uses).
   */
  private buildRevokedSkillEntries(): Record<string, { enabled: boolean }> {
    const entries: Record<string, { enabled: boolean }> = {};
    for (const name of this.revokedSkillNames) {
      entries[name] = { enabled: false };
    }
    return entries;
  }

  /**
   * Sync AGENTS.md to the OpenClaw workspace directory.
   * Embeds the skills routing prompt and system prompt so that OpenClaw's
   * native channel connectors (DingTalk, Feishu, etc.) can discover and
   * invoke GenWork skills.
   */
  private syncAgentsMd(workspaceDir: string, coworkConfig: GenWorkConfig): string | undefined {
    try {
      ensureDir(workspaceDir);
      const agentsMdPath = path.join(workspaceDir, 'AGENTS.md');

      // Build the managed section
      const sections: string[] = [];

      // Add system prompt if configured — strip the marker to prevent content corruption
      const systemPrompt = stripAgentsManagedMarkers((coworkConfig.systemPrompt || '').trim());
      if (systemPrompt) {
        sections.push(`## System Prompt\n\n${systemPrompt}`);
      }

      // Skills are now loaded by OpenClaw natively via skills.load.extraDirs
      // in openclaw.json, so we no longer embed the skills routing prompt here.

      sections.push(MANAGED_WEB_SEARCH_POLICY_PROMPT);
      sections.push(MANAGED_BROWSER_POLICY_PROMPT);
      sections.push(MANAGED_EXEC_SAFETY_PROMPT);
      sections.push(MANAGED_DELIVERABLE_LINKS_PROMPT);
      sections.push(MANAGED_MATH_FORMAT_PROMPT);
      sections.push(MANAGED_MEMORY_POLICY_PROMPT);
      sections.push(MANAGED_HEARTBEAT_POLICY_PROMPT);
      sections.push(MANAGED_IDENTITY_POLICY_PROMPT);
      sections.push(buildManagedSkillCreationPrompt(resolveSkillCreationPath()));

      // Keep scheduled-task policy after skills so native channel sessions
      // treat it as the final app-managed override for reminder handling.
      const scheduledTaskPrompt = stripAgentsManagedMarkers(buildScheduledTaskEnginePrompt());
      if (scheduledTaskPrompt) {
        sections.push(scheduledTaskPrompt);
      }

      // Read existing file once to avoid TOCTOU issues
      let existingContent = '';
      try {
        existingContent = fs.readFileSync(agentsMdPath, 'utf8');
      } catch {
        // File doesn't exist yet.
      }

      // Extract user content (everything before the marker).
      const markerIdx = findAgentsManagedMarker(existingContent);
      const userContent =
        markerIdx >= 0 ? existingContent.slice(0, markerIdx).trimEnd() : existingContent.trimEnd();
      const preservedUserContent = userContent || readBundledOpenClawAgentsTemplate();

      if (sections.length === 0) {
        // No managed content — remove the managed section if present,
        // but preserve user content.
        if (markerIdx >= 0) {
          if (preservedUserContent) {
            const cleaned = preservedUserContent + '\n';
            if (existingContent !== cleaned) {
              this.atomicWriteFile(agentsMdPath, cleaned);
            }
          } else {
            try {
              fs.unlinkSync(agentsMdPath);
            } catch {
              /* already gone */
            }
          }
        }
        return;
      }

      const managedContent = `${GENWORK_AGENTS_MARKER}\n\n${sections.join('\n\n')}`;
      const nextContent = preservedUserContent
        ? `${preservedUserContent}\n\n${managedContent}\n`
        : `${managedContent}\n`;

      // Only write if content actually changed
      if (existingContent === nextContent) return;

      this.atomicWriteFile(agentsMdPath, nextContent);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('[OpenClawConfigSync] Failed to sync AGENTS.md:', msg);
      return msg;
    }
  }

  /**
   * Build the `agents.list` config array for openclaw.json.
   *
   * The main agent uses the user's configured workspace directory (via
   * `agents.defaults.workspace`).  Non-main agents omit `workspace` so
   * OpenClaw falls back to its default: `{STATE_DIR}/workspace-{agentId}/`.
   * This keeps custom agent workspaces under the openclaw state directory
   * rather than coupling them to the user's working directory.
   *
   * Per-agent `identity` (name, emoji) is set from the agent database so
   * OpenClaw picks it up natively.
   */
  private buildAgentsList(
    defaultPrimaryModel: string,
    stateDir?: string,
    availableProviders?: Record<string, { models: Array<{ id: string }> }>,
    agentsOverride?: Agent[],
  ): { list?: Array<Record<string, unknown>> } {
    const agents = agentsOverride ?? this.getAgents?.() ?? [];
    // Enterprise (server-owned) agents run with a locally persisted model
    // override when one is set; swap it into the row's model field before
    // entries are built so `agents.list[].model.primary` is the model the
    // agent actually runs with (IM/channel sessions resolve their default
    // from here). Non-enterprise agents pass through unchanged.
    const getAgentModelOverride = this.getAgentModelOverride;
    const effectiveAgents = getAgentModelOverride
      ? agents.map((agent) =>
          agent.source === 'enterprise'
            ? { ...agent, model: effectiveAgentModelRef(agent, getAgentModelOverride) }
            : agent,
        )
      : agents;
    const mainAgent = effectiveAgents.find(agent => agent.id === AgentId.Main);

    const list: Array<Record<string, unknown>> = [
      mainAgent
        ? buildAgentEntry(mainAgent, defaultPrimaryModel, { availableProviders })
        : {
            id: AgentId.Main,
            default: true,
            identity: {
              name: DefaultAgentProfile.Name,
            },
            model: {
              primary: defaultPrimaryModel,
            },
          },
      ...buildManagedAgentEntries({
        agents: effectiveAgents,
        fallbackPrimaryModel: defaultPrimaryModel,
        stateDir,
        availableProviders,
      }),
    ];

    return list.length > 0 ? { list } : {};
  }

  /**
   * Build the `bindings` config array for openclaw.json.
   *
   * Each IM platform can be independently bound to a different agent via
   * `IMSettings.platformAgentBindings`.  Only channels with an explicit
   * non-main binding produce an entry.
   */
  private buildBindings(): { bindings?: Array<Record<string, unknown>> } {
    const imSettings = this.getIMSettings?.();
    const platformBindings = imSettings?.platformAgentBindings;
    if (!platformBindings || Object.keys(platformBindings).length === 0) return {};

    const agents = this.getAgents?.() ?? [];

    const bindings: Array<Record<string, unknown>> = [];

    // Handle per-instance bindings for multi-instance platforms
    const multiInstanceChannels: Record<string, { channel: string; getInstances: () => Array<{ instanceId: string; enabled: boolean; appKey?: string; account?: string }> }> = {
      dingtalk: { channel: DINGTALK_OPENCLAW_CHANNEL, getInstances: () => this.getDingTalkInstances() },
      feishu: { channel: 'feishu', getInstances: () => this.getFeishuInstances() },
      qq: { channel: 'qqbot', getInstances: () => this.getQQInstances() },
      wecom: { channel: 'wecom', getInstances: () => this.getWecomInstances() },
      telegram: { channel: 'telegram', getInstances: () => this.getTelegramInstances() },
      discord: { channel: 'discord', getInstances: () => this.getDiscordInstances() },
      popo: { channel: 'moltbot-popo', getInstances: () => this.getPopoInstances() },
    };

    for (const [platform, { channel, getInstances }] of Object.entries(multiInstanceChannels)) {
      try {
        const instances = getInstances();
        for (const inst of instances) {
          if (!inst.enabled) continue;
          // Check for per-instance binding: `platform:instanceId`
          const bindingKey = `${platform}:${inst.instanceId}`;
          const agentId = platformBindings[bindingKey];
          if (!agentId || agentId === 'main') continue;
          const targetAgent = agents.find(a => a.id === agentId && a.enabled);
          if (!targetAgent) continue;
          const accountId = inst.instanceId.slice(0, 8);
          if (!accountId) continue;
          bindings.push({ agentId, match: { channel, accountId } });
        }
        // Also check legacy platform-level binding
        const platformAgentId = platformBindings[platform];
        if (platformAgentId && platformAgentId !== 'main') {
          const targetAgent = agents.find(a => a.id === platformAgentId && a.enabled);
          if (targetAgent && instances.some(i => i.enabled)) {
            bindings.push({
              agentId: platformAgentId,
              match: { channel, accountId: OPENCLAW_BINDING_ANY_ACCOUNT_ID },
            });
          }
        }
      } catch {
        // Skip platforms that fail to load config
      }
    }

    // Handle single-instance platforms
    const singleInstanceChannels: Array<{
      getter: () => { enabled: boolean } | null;
      channel: string;
      platform: string;
    }> = [
      { getter: () => this.getWeixinConfig(), channel: 'openclaw-weixin', platform: 'weixin' },
    ];

    for (const { getter, channel, platform } of singleInstanceChannels) {
      const agentId = platformBindings[platform];
      if (!agentId || agentId === 'main') continue;

      const targetAgent = agents.find(a => a.id === agentId && a.enabled);
      if (!targetAgent) continue;

      try {
        const cfg = getter();
        if (cfg?.enabled) {
          bindings.push({
            agentId,
            match: { channel, accountId: OPENCLAW_BINDING_ANY_ACCOUNT_ID },
          });
        }
      } catch {
        // Skip channels that fail to load config
      }
    }

    return bindings.length > 0 ? { bindings } : {};
  }

  /**
   * Sync workspace files (SOUL.md, IDENTITY.md, AGENTS.md) for each non-main agent.
   * The main agent's workspace is synced by `syncAgentsMd`. Non-main agents
   * get their own workspace directories under the openclaw state directory.
   */
  private syncPerAgentWorkspaces(mainWorkspaceDir: string, coworkConfig: GenWorkConfig): void {
    const agents = this.getAgents?.() ?? [];
    // Use the openclaw state directory as base, matching OpenClaw's own fallback
    // logic: {STATE_DIR}/workspace-{agentId}/
    const stateDir = this.engineManager.getStateDir();
    try {
      if (repairHeartbeatFile(mainWorkspaceDir)) {
        console.log('[OpenClawConfigSync] Repaired legacy HEARTBEAT.md in main workspace');
      }
    } catch (error) {
      console.warn(
        '[OpenClawConfigSync] Failed to repair HEARTBEAT.md in main workspace:',
        error instanceof Error ? error.message : String(error),
      );
    }

    for (const agent of agents) {
      if (agent.id === 'main' || !agent.enabled) continue;

      const agentWorkspace = path.join(stateDir, `workspace-${agent.id}`);
      try {
        ensureDir(agentWorkspace);

        if (repairHeartbeatFile(agentWorkspace)) {
          console.log(`[OpenClawConfigSync] Repaired legacy HEARTBEAT.md for agent ${agent.id}`);
        }

        // Sync SOUL.md — agent's system prompt
        const soulPath = path.join(agentWorkspace, 'SOUL.md');
        const soulContent = (agent.systemPrompt || '').trim();
        this.syncFileIfChanged(soulPath, soulContent ? `${soulContent}\n` : '');

        // Sync IDENTITY.md — agent's identity description
        const identityPath = path.join(agentWorkspace, 'IDENTITY.md');
        const identityContent = (agent.identity || '').trim();
        this.syncFileIfChanged(identityPath, identityContent ? `${identityContent}\n` : '');

        // Sync AGENTS.md for this agent (reuse same logic as main agent)
        this.syncAgentsMd(agentWorkspace, {
          ...coworkConfig,
          systemPrompt: agent.systemPrompt || '',
        });

        // Ensure memory directory exists
        const memoryDir = path.join(agentWorkspace, 'memory');
        ensureDir(memoryDir);

        // Ensure MEMORY.md exists
        const memoryPath = path.join(agentWorkspace, 'MEMORY.md');
        if (!fs.existsSync(memoryPath)) {
          fs.writeFileSync(memoryPath, '', 'utf8');
        }
      } catch (error) {
        console.warn(
          `[OpenClawConfigSync] Failed to sync workspace for agent ${agent.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /** Write a file only if its content has changed. */
  private syncFileIfChanged(filePath: string, content: string): void {
    try {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing === content) return;
    } catch {
      // File doesn't exist yet
    }
    if (content) {
      this.atomicWriteFile(filePath, content);
    } else {
      // Empty content — create empty file if it doesn't exist
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', 'utf8');
      }
    }
  }

  /** Atomic file write via tmp + rename, consistent with openclaw.json writes. */
  private atomicWriteFile(filePath: string, content: string): void {
    const tmpPath = `${filePath}.tmp-${Date.now()}`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Write a minimal openclaw.json that lets the gateway start without any
   * model/provider configured.  The full config will be synced once the
   * user sets up a model in the UI.
   */
  private writeMinimalConfig(configPath: string, _reason: string): OpenClawConfigSyncResult {
    const baseMinimalConfig: Record<string, unknown> = {
      gateway: {
        mode: 'local',
      },
      // Don't enable plugins in minimal config — plugin loading via jiti happens
      // synchronously BEFORE the HTTP server binds, and can block gateway startup
      // for minutes on a fresh install.  Plugins will be enabled when the user
      // configures an API model and a full config sync runs.
    };

    let currentContent = '';
    try {
      currentContent = fs.readFileSync(configPath, 'utf8');
    } catch {
      currentContent = '';
    }

    // Build the config to write: start from the base minimal config, then
    // selectively preserve non-provider sections from the existing file.
    // Critically, we do NOT preserve existing.models — it may contain
    // ${GENWORK_APIKEY_X} placeholders for providers that are no longer
    // configured, causing the gateway to fail to start because those env
    // vars are no longer injected.
    let mergedConfig: Record<string, unknown> = { ...baseMinimalConfig };
    if (currentContent) {
      try {
        const existing = JSON.parse(currentContent);
        // Preserve IM channel plugin entries — these reference their own env
        // vars (${GENWORK_TG_BOT_TOKEN} etc.) that are still injected when
        // the corresponding IM channels remain enabled. Plugin-index-managed
        // keys (`installs`) are filtered out — see omitPluginIndexManagedKeys.
        if (existing.plugins) {
          mergedConfig.plugins = omitPluginIndexManagedKeys(existing.plugins);
        }
        // Preserve non-default gateway settings (e.g. custom port).
        if (existing.gateway && existing.gateway.mode !== 'local') {
          mergedConfig.gateway = existing.gateway;
        }
        // existing.models is intentionally NOT preserved — it references
        // ${GENWORK_APIKEY_*} env vars that may no longer be set.
      } catch {
        // Malformed JSON — overwrite with base minimal config.
      }
    }

    const nextContent = `${JSON.stringify(mergedConfig, null, 2)}\n`;

    // Compare ignoring `meta` timestamps to avoid unnecessary writes.
    const unchanged = (() => {
      if (!currentContent) return false;
      try {
        const cur = JSON.parse(currentContent);
        delete cur.meta;
        const nxt = JSON.parse(nextContent);
        delete nxt.meta;
        return JSON.stringify(cur) === JSON.stringify(nxt);
      } catch {
        return currentContent === nextContent;
      }
    })();
    if (unchanged) {
      return { ok: true, changed: false, configPath };
    }

    try {
      ensureDir(path.dirname(configPath));
      const stampedContent = `${JSON.stringify(this.stampConfigMeta(mergedConfig), null, 2)}\n`;
      const tmpPath = `${configPath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpPath, stampedContent, 'utf8');
      fs.renameSync(tmpPath, configPath);
      return { ok: true, changed: true, configPath };
    } catch (error) {
      return {
        ok: false,
        changed: false,
        configPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
