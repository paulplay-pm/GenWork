/**
 * Provider Constants — Single Source of Truth
 *
 * All LLM provider identifiers are defined here. Both main and renderer
 * processes import from this module.
 *
 * When adding a new provider:
 * 1. Add the provider key to ProviderName
 * 2. Add the OpenClaw provider ID to OpenClawProviderId (if different)
 *
 * String literal constants follow AGENTS.md "String Literal Constants" spec,
 * modeled after src/scheduledTask/constants.ts.
 */

// ═══════════════════════════════════════════════════════
// 1. String Literal Constants
// ═══════════════════════════════════════════════════════

// ─── Provider Name ──────────────────────────────────────────────────────
// providerName identifies the GenWork internal provider (config key).
export const ProviderName = {
  OpenAI: 'openai',
  Gemini: 'gemini',
  Xai: 'xai',
  Anthropic: 'anthropic',
  DeepSeek: 'deepseek',
  Moonshot: 'moonshot',
  Zhipu: 'zhipu',
  Minimax: 'minimax',
  Youdaozhiyun: 'youdaozhiyun',
  Qwen: 'qwen',
  Qianfan: 'qianfan',
  Xiaomi: 'xiaomi',
  StepFun: 'stepfun',
  Volcengine: 'volcengine',
  OpenRouter: 'openrouter',
  Ollama: 'ollama',
  LmStudio: 'lm-studio',
  Custom: 'custom',
  GenworkServer: 'genwork-server',
  Copilot: 'github-copilot',
} as const;
export type ProviderName = typeof ProviderName[keyof typeof ProviderName];

// ─── OpenClaw Provider ID ───────────────────────────────────────────────
// OpenClaw gateway provider identifiers. May differ from ProviderName.
export const OpenClawProviderId = {
  GenworkServer: 'genwork-server',
  Moonshot: 'moonshot',
  Google: 'google',
  Xai: 'xai',
  Anthropic: 'anthropic',
  OpenAI: 'openai',
  OpenAICodex: 'openai-codex',
  DeepSeek: 'deepseek',
  Qianfan: 'qianfan',
  Qwen: 'qwen',
  Zai: 'zai', // OpenClaw official provider ID for Zhipu/GLM
  Volcengine: 'volcengine',
  Minimax: 'minimax',
  MinimaxPortal: 'minimax-portal',
  Youdaozhiyun: 'youdaozhiyun',
  StepFun: 'stepfun',
  Xiaomi: 'xiaomi',
  OpenRouter: 'openrouter',
  Copilot: 'github-copilot',
  GenworkCopilot: 'genwork-copilot',
  Ollama: 'ollama',
  LmStudio: 'lm-studio',
  Genwork: 'genwork',
} as const;
export type OpenClawProviderId = typeof OpenClawProviderId[keyof typeof OpenClawProviderId];

// ─── OpenClaw API Protocol ──────────────────────────────────────────────
export const OpenClawApi = {
  AnthropicMessages: 'anthropic-messages',
  OpenAICompletions: 'openai-completions',
  OpenAIResponses: 'openai-responses',
  OpenAICodexResponses: 'openai-codex-responses',
  OpenAIChatGPTResponses: 'openai-chatgpt-responses',
  GoogleGenerativeAI: 'google-generative-ai',
} as const;
export type OpenClawApi = typeof OpenClawApi[keyof typeof OpenClawApi];

// ─── API Format (provider default protocol format) ──────────────────────
export const ApiFormat = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  Gemini: 'gemini',
} as const;
export type ApiFormat = typeof ApiFormat[keyof typeof ApiFormat];

// ─── Auth Type ──────────────────────────────────────────────────────────
export const AuthType = {
  ApiKey: 'api-key',
  OAuth: 'oauth',
} as const;
export type AuthType = typeof AuthType[keyof typeof AuthType];

export const ProviderAuthType = {
  ApiKey: 'apikey',
  OAuth: 'oauth',
} as const;
export type ProviderAuthType = typeof ProviderAuthType[keyof typeof ProviderAuthType];

// ═══════════════════════════════════════════════════════
// 2. Provider Definition Shape
// ═══════════════════════════════════════════════════════

export interface ProviderDef {
  /** Provider identifier (e.g. 'openai', 'moonshot') */
  readonly id: string;
  /** Human-readable display name shown in UI */
  readonly label: string;
  /** Provider console / product website URL */
  readonly website?: string;
  /** API key creation page URL */
  readonly apiKeyUrl?: string;
  /** Default base URL */
  readonly defaultBaseUrl: string;
  /** Default API format */
  readonly defaultApiFormat: ApiFormat;
  /** Whether this provider supports codingPlan mode */
  readonly codingPlanSupported: boolean;
  /** Coding Plan dedicated endpoints */
  readonly codingPlanUrls?: {
    readonly openai?: string;
    readonly anthropic?: string;
  };
  /** When set, overrides caller's apiFormat for coding plan URL resolution. */
  readonly preferredCodingPlanFormat?: 'openai' | 'anthropic';
  /** Default baseUrl per apiFormat for UI switching */
  readonly switchableBaseUrls?: {
    readonly anthropic: string;
    readonly openai: string;
  };
  /** Region grouping for UI visibility */
  readonly region: 'china' | 'global';
  /** Priority ordering for English locale display (lower = higher priority, 0 = no special priority) */
  readonly enPriority: number;
  /** Default model list */
  readonly defaultModels: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
    readonly supportsVideo?: boolean;
    readonly supportsThinking?: boolean;
    readonly contextWindow?: number;
    readonly maxTokens?: number;
  }[];
  readonly codingPlanModels?: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
    readonly supportsVideo?: boolean;
    readonly supportsThinking?: boolean;
    readonly contextWindow?: number;
    readonly maxTokens?: number;
  }[];
  readonly openClawProviderId: OpenClawProviderId;
}
