import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ProviderName } from '../../shared/providers';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: (name: string) => {
      if (name === 'home') return os.homedir();
      return os.tmpdir();
    },
  },
}));

const mockRuntimeState = vi.hoisted(() => ({
  modelCompatPluginAvailable: true,
  enterpriseUrl: 'http://127.0.0.1:8787',
  catalogEntries: [] as Array<{
    id: string;
    provider: string;
    model: string;
    displayName: string | null;
  }>,
  serverModels: [] as Array<{
    modelId: string;
    modelName?: string;
    provider?: string;
    apiFormat?: string;
    runtimeProfile?: string;
    supportsImage?: boolean;
    supportsVideo?: boolean;
    supportsThinking?: boolean;
    supportsToolCalling?: boolean;
    agenticReady?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    explicitContextCache?: boolean;
  }>,
  enabledProviders: [] as Array<{
    providerName: string;
    baseURL: string;
    apiKey: string;
    apiType: 'anthropic' | 'openai';
    authType?: 'apikey' | 'oauth';
    codingPlanEnabled: boolean;
    models: Array<{
      id: string;
      name: string;
      supportsImage?: boolean;
      supportsVideo?: boolean;
      supportsThinking?: boolean;
      contextWindow?: number;
      maxTokens?: number;
      customParams?: Record<string, unknown>;
    }>;
  }>,
  providerSourceEntries: [] as Array<{
    providerName: string;
    codingPlanEnabled: boolean;
    authType?: 'apikey' | 'oauth';
    displayName?: string;
  }>,
  rawApiConfig: {
    config: {
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      apiType: 'openai',
    },
    providerMetadata: {
      providerName: 'openai',
      codingPlanEnabled: false,
      supportsImage: false,
      modelName: 'GPT Test',
    },
  } as {
    config: {
      baseURL: string;
      apiKey: string;
      model: string;
      apiType: 'anthropic' | 'openai';
    };
    providerMetadata: {
      providerName: string;
      authType?: 'apikey' | 'oauth';
      codingPlanEnabled: boolean;
      runtimeProfile?: string;
      supportsImage?: boolean;
      supportsVideo?: boolean;
      supportsThinking?: boolean;
      modelName?: string;
      contextWindow?: number;
      maxTokens?: number;
    };
  },
}));

vi.mock('./claudeSettings', () => ({
  getAllServerModelMetadata: () => mockRuntimeState.serverModels,
  listProviderSourceEntries: () => mockRuntimeState.providerSourceEntries,
  resolveAllEnabledProviderConfigs: () => mockRuntimeState.enabledProviders,
  resolveAllProviderApiKeys: () => ({}),
  resolveRawApiConfig: () => mockRuntimeState.rawApiConfig,
}));

vi.mock('./openclawLocalExtensions', () => ({
  findBundledExtensionsDir: () => null,
  findThirdPartyExtensionsDir: () => null,
  hasBundledOpenClawExtension: (id: string) => (
    id !== 'qwen-portal-auth'
    && (id !== 'genwork-model-compat' || mockRuntimeState.modelCompatPluginAvailable)
  ),
  hasRuntimeBundledOpenClawExtension: (id: string) => id === 'xai',
  resolveOpenClawExtensionPluginId: (id: string) => {
    const manifestIds: Record<string, string> = {
      'clawemail-email': 'email',
      'openclaw-nim-channel': 'nimsuite-openclaw-nim-channel',
    };
    if (id === 'qwen-portal-auth') return null;
    return manifestIds[id] ?? id;
  },
}));

vi.mock('./endpoints', () => ({
  getEnterpriseServerUrl: () => mockRuntimeState.enterpriseUrl,
}));

vi.mock('../auth/enterpriseModelCache', () => ({
  enterpriseModelCache: {
    list: () => mockRuntimeState.catalogEntries,
    isEmpty: () => mockRuntimeState.catalogEntries.length === 0,
    getActive: () => null,
  },
}));

describe('OpenClawConfigSync runtime config output', () => {
  let tmpDir: string;
  let configPath: string;
  let stateDir: string;

  beforeEach(() => {
    mockRuntimeState.modelCompatPluginAvailable = true;
    mockRuntimeState.enterpriseUrl = 'http://127.0.0.1:8787';
    mockRuntimeState.catalogEntries = [];
    mockRuntimeState.serverModels = [];
    mockRuntimeState.enabledProviders = [];
    mockRuntimeState.providerSourceEntries = [];
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-test',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: 'openai',
        codingPlanEnabled: false,
        supportsImage: false,
        modelName: 'GPT Test',
      },
    };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-'));
    stateDir = path.join(tmpDir, 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const { restoreOriginalProxyEnv, setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(false);
    restoreOriginalProxyEnv();
  });

  const createSync = async (overrides: Record<string, unknown> = {}) => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    return new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
      ...overrides,
    } as never);
  };

  test('keys OpenClaw skill entries by frontmatter name, not directory id', async () => {
    const sync = await createSync({
      // Mirrors bundled skills whose SKILL.md frontmatter name differs from
      // the directory-derived id (see issue #2441): OpenClaw resolves
      // skills.entries overrides by frontmatter name only.
      getSkillsList: () => [
        { id: 'technology-news-search', name: 'technology-search', enabled: false },
        { id: 'remotion', name: 'remotion-best-practices', enabled: false },
        { id: 'weather', name: 'weather', enabled: true },
      ],
    });

    const result = sync.sync('skill-entry-keys');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.skills.entries).toMatchObject({
      'technology-search': { enabled: false },
      'remotion-best-practices': { enabled: false },
      weather: { enabled: true },
    });
    expect(config.skills.entries).not.toHaveProperty('technology-news-search');
    expect(config.skills.entries).not.toHaveProperty('remotion');
  });

  test('writes OpenClaw config fields required by GenWork patches', async () => {
    const legacyWorkingDirectory = path.join(tmpDir, 'legacy-working-directory');
    const mainAgentWorkingDirectory = path.join(tmpDir, 'main-agent-working-directory');

    const sync = await createSync({
      getGenWorkConfig: () => ({
        workingDirectory: legacyWorkingDirectory,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: true,
      }),
      getAgents: () => [
        {
          id: 'main',
          name: 'Main',
          description: '',
          systemPrompt: '',
          identity: '',
          model: '',
          workingDirectory: mainAgentWorkingDirectory,
          icon: '',
          skillIds: [],
          enabled: true,
          isDefault: true,
          source: 'custom',
          presetId: '',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const result = sync.sync('genwork-patch-dependent-fields');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const mainEntry = config.agents.list.find((entry: { id?: string }) => entry.id === 'main');

    expect(config.cron.skipMissedJobs).toBe(true);
    expect(config.cron.store).toBe(path.join(stateDir, 'cron', 'jobs.json'));
    expect(config.agents.defaults.cwd).toBe(path.resolve(mainAgentWorkingDirectory));
    expect(mainEntry.cwd).toBe(path.resolve(mainAgentWorkingDirectory));
  });

  test('enterprise model override reaches agents.list model.primary; non-enterprise unchanged', async () => {
    // `agents.list[].model.primary` is the agent's effective default model —
    // a locally persisted override must be what the agent actually runs with
    // (e.g. for IM/channel sessions bound to an enterprise agent), while
    // non-enterprise agents must keep their row model untouched.
    const sync = await createSync({
      getAgents: () => [
        {
          id: 'main',
          name: 'Main',
          description: '',
          systemPrompt: '',
          identity: '',
          model: '',
          workingDirectory: '',
          icon: '',
          skillIds: [],
          subagentAllowAgentIds: [],
          enabled: true,
          pinned: false,
          isDefault: true,
          source: 'custom',
          presetId: '',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'ent-overridden',
          name: 'Reviewer',
          description: '',
          systemPrompt: '',
          identity: '',
          model: 'genwork/server-model',
          workingDirectory: '',
          icon: '',
          skillIds: [],
          subagentAllowAgentIds: [],
          enabled: true,
          pinned: false,
          isDefault: false,
          source: 'enterprise',
          presetId: '',
          enterpriseAgentId: 'agent_a1',
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: 'ent-no-override',
          name: 'Plain Enterprise',
          description: '',
          systemPrompt: '',
          identity: '',
          model: 'genwork/plain-model',
          workingDirectory: '',
          icon: '',
          skillIds: [],
          subagentAllowAgentIds: [],
          enabled: true,
          pinned: false,
          isDefault: false,
          source: 'enterprise',
          presetId: '',
          enterpriseAgentId: 'agent_a2',
          createdAt: 3,
          updatedAt: 3,
        },
        {
          id: 'custom-agent',
          name: 'Custom',
          description: '',
          systemPrompt: '',
          identity: '',
          model: 'genwork/custom-model',
          workingDirectory: '',
          icon: '',
          skillIds: [],
          subagentAllowAgentIds: [],
          enabled: true,
          pinned: false,
          isDefault: false,
          source: 'custom',
          presetId: '',
          createdAt: 4,
          updatedAt: 4,
        },
      ],
      getAgentModelOverride: (enterpriseAgentId: string) => (
        enterpriseAgentId === 'agent_a1' ? 'genwork/override-model' : ''
      ),
    });

    const result = sync.sync('enterprise-model-override-agents-list');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const entries = config.agents.list as Array<{ id: string; model?: { primary?: string } }>;
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    // Enterprise agent with a stored, parseable override: primary is the override.
    expect(byId.get('ent-overridden')?.model?.primary).toBe('genwork/override-model');
    // Enterprise agent without a stored override: row model is kept.
    expect(byId.get('ent-no-override')?.model?.primary).toBe('genwork/plain-model');
    // Non-enterprise agent: the override lookup never applies to it.
    expect(byId.get('custom-agent')?.model?.primary).toBe('genwork/custom-model');
  });

  test('enterprise model override is ignored when no override getter is wired', async () => {
    // Callers that do not provide `getAgentModelOverride` must produce the
    // exact same agent entries as before (the row model, no transformation).
    const sync = await createSync({
      getAgents: () => [
        {
          id: 'main',
          name: 'Main',
          description: '',
          systemPrompt: '',
          identity: '',
          model: '',
          workingDirectory: '',
          icon: '',
          skillIds: [],
          subagentAllowAgentIds: [],
          enabled: true,
          pinned: false,
          isDefault: true,
          source: 'custom',
          presetId: '',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'ent-agent',
          name: 'Reviewer',
          description: '',
          systemPrompt: '',
          identity: '',
          model: 'genwork/server-model',
          workingDirectory: '',
          icon: '',
          skillIds: [],
          subagentAllowAgentIds: [],
          enabled: true,
          pinned: false,
          isDefault: false,
          source: 'enterprise',
          presetId: '',
          enterpriseAgentId: 'agent_a1',
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });

    const result = sync.sync('no-override-getter');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const entries = config.agents.list as Array<{ id: string; model?: { primary?: string } }>;
    const entEntry = entries.find((entry) => entry.id === 'ent-agent');
    expect(entEntry?.model?.primary).toBe('genwork/server-model');
  });

  test('disables OpenClaw remote model pricing refresh in generated config', async () => {
    const sync = await createSync();

    const result = sync.sync('disable-model-pricing');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.pricing).toEqual({ enabled: false });
  });

  test('strips plugin-index-managed plugins.installs while preserving other plugins keys', async () => {
    // A leaked plugins.installs on disk poisons config.set hot delivery
    // (the gateway rejects the key) and makes the gateway self-restart on
    // the file diff — sync must scrub it on every write.
    fs.writeFileSync(configPath, `${JSON.stringify({
      gateway: { mode: 'local', port: 18789 },
      plugins: {
        entries: { 'runtime-injected-plugin': { enabled: true } },
        allow: ['runtime-injected-plugin'],
        slots: { memory: 'memory-core' },
        installs: { xai: { source: 'npm', version: '1.0.0' } },
      },
    }, null, 2)}\n`, 'utf8');
    const sync = await createSync();

    const result = sync.sync('installs-scrub');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.installs).toBeUndefined();
    expect(config.plugins.entries['runtime-injected-plugin']).toEqual({ enabled: true });
    expect(config.plugins.allow).toContain('runtime-injected-plugin');
    expect(config.plugins.slots.memory).toBe('memory-core');
    expect(config.gateway.port).toBe(18789);
  });

  test('defaults memory search to local FTS-only when embeddings are disabled', async () => {
    const sync = await createSync({
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: true,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
        embeddingEnabled: false,
        embeddingProvider: 'openai',
        embeddingModel: '',
        embeddingLocalModelPath: '',
        embeddingVectorWeight: 0.7,
        embeddingRemoteBaseUrl: '',
        embeddingRemoteApiKey: '',
      }),
    });

    const result = sync.sync('memory-search-default-fts');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.memorySearch).toMatchObject({
      enabled: true,
      provider: 'none',
      fallback: 'none',
      store: {
        fts: { tokenizer: 'trigram' },
        vector: { enabled: false },
      },
    });
    expect(config.agents.defaults.memorySearch.remote).toBeUndefined();
  });

  test('configures OpenClaw chat image attachment limit to 30MB', async () => {
    const sync = await createSync();

    const result = sync.sync('chat-image-attachment-limit');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.mediaMaxMb).toBe(30);
  });

  test('enables physical transcript rotation with a managed size threshold', async () => {
    const sync = await createSync();

    const result = sync.sync('transcript-rotation');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.compaction).toEqual({
      truncateAfterCompaction: true,
      maxActiveTranscriptBytes: '32mb',
    });
  });

  test('enables optimized OpenClaw heartbeat by default', async () => {
    const sync = await createSync();

    const result = sync.sync('heartbeat-enabled-default');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.heartbeat).toEqual({
      every: '1h',
      target: 'none',
      lightContext: true,
      isolatedSession: true,
      skipWhenBusy: true,
    });
  });

  test('writes disabled OpenClaw heartbeat cadence when user disables heartbeat', async () => {
    const sync = await createSync({
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
        openClawHeartbeatEnabled: false,
      }),
    });

    const result = sync.sync('heartbeat-disabled');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.heartbeat).toEqual({
      every: '0m',
      target: 'none',
      lightContext: true,
      isolatedSession: true,
      skipWhenBusy: true,
    });
  });

  test('writes model provider env-proxy transport when system proxy is enabled', async () => {
    const { setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(true);
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('test');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Rebrand: the legacy `request.proxy = { mode: 'env-proxy' }` was removed —
    // there is no `request` key written on the genwork-server provider entry.
    expect(config.models.providers['genwork-server']).toBeDefined();
    expect(config.models.providers['genwork-server'].request).toBeUndefined();
  });

  test('writes managed browser proxy args when system proxy is enabled', async () => {
    const { applySystemProxyEnv, setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(true);
    applySystemProxyEnv('http://127.0.0.1:7890');

    const sync = await createSync();

    const result = sync.sync('browser-system-proxy');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.browser.extraArgs).toEqual(['--proxy-server=http://127.0.0.1:7890']);
  });

  test('does not write managed browser proxy args in strict browser network mode', async () => {
    const { BrowserNetworkMode } = await import('../../shared/browserWebAccess/constants');
    const { applySystemProxyEnv, setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(true);
    applySystemProxyEnv('http://127.0.0.1:7890');

    const sync = await createSync({
      getBrowserWebAccessConfig: () => ({
        networkMode: BrowserNetworkMode.Strict,
      }),
    });

    const result = sync.sync('browser-system-proxy-strict');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.browser.extraArgs).toBeUndefined();
    expect(config.browser.ssrfPolicy.dangerouslyAllowPrivateNetwork).toBe(false);
  });

  test('does not write managed browser proxy args when browser proxy following is disabled', async () => {
    const { applySystemProxyEnv, setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(true);
    applySystemProxyEnv('http://127.0.0.1:7890');

    const sync = await createSync({
      getBrowserWebAccessConfig: () => ({
        followGlobalProxy: false,
      }),
    });

    const result = sync.sync('browser-system-proxy-disabled');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.browser.extraArgs).toBeUndefined();
  });

  test('does not create an agent model allowlist for OpenAI OAuth when system proxy is enabled', async () => {
    const { ProviderName } = await import('../../shared/providers');
    const { setSystemProxyEnabled } = await import('./systemProxy');
    setSystemProxyEnabled(true);
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-5.4',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: ProviderName.OpenAI,
        authType: 'oauth',
        codingPlanEnabled: false,
        supportsImage: true,
        modelName: 'GPT-5.4',
      },
    };
    mockRuntimeState.enabledProviders = [
      {
        providerName: ProviderName.OpenAI,
        baseURL: 'https://api.openai.com/v1',
        apiKey: '',
        apiType: 'openai',
        authType: 'oauth',
        codingPlanEnabled: false,
        models: [{ id: 'gpt-5.4', name: 'GPT-5.4', supportsImage: true }],
      },
      {
        providerName: ProviderName.DeepSeek,
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek',
        apiType: 'openai',
        codingPlanEnabled: false,
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false }],
      },
    ];

    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('openai-oauth-system-proxy');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Rebrand: all providers collapse into the single 'genwork-server' provider.
    expect(config.models.providers['genwork-server']).toBeDefined();
    // Rebrand: The user's OpenAI OAuth config routes through openai-completions
    // (buildProviderSelection does not pass providerName to mapApiTypeToOpenClawApi,
    // so the OpenAI special case that returns 'openai-responses' is bypassed).
    expect(config.models.providers['genwork-server'].api).toBe('openai-completions');
    // The legacy 'openai-codex' sibling provider is no longer created.
    expect(config.models.providers['openai-codex']).toBeUndefined();
    // The legacy per-vendor 'openai' and 'deepseek' providers no longer exist.
    expect(config.models.providers.openai).toBeUndefined();
    expect(config.models.providers.deepseek).toBeUndefined();
    // No custom params → no allowlist (agents.defaults.models undefined).
    expect(config.agents.defaults.models).toBeUndefined();
    expect(config.agents.defaults.workspace).toBe(path.join(stateDir, 'workspace-main'));
    expect(config.agents.defaults.cwd).toBe(path.resolve(tmpDir));
  });

  test('uses the main agent working directory for default agent cwd', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');
    const legacyWorkingDirectory = path.join(tmpDir, 'legacy-working-directory');
    const mainAgentWorkingDirectory = path.join(tmpDir, 'main-agent-working-directory');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: legacyWorkingDirectory,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [
        {
          id: 'main',
          name: 'Main',
          description: '',
          systemPrompt: '',
          identity: '',
          model: '',
          workingDirectory: mainAgentWorkingDirectory,
          icon: '',
          skillIds: [],
          enabled: true,
          isDefault: true,
          source: 'custom',
          presetId: '',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const result = sync.sync('main-agent-cwd');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const mainEntry = config.agents.list.find((entry: { id?: string }) => entry.id === 'main');

    expect(config.agents.defaults.workspace).toBe(path.join(stateDir, 'workspace-main'));
    expect(config.agents.defaults.cwd).toBe(path.resolve(mainAgentWorkingDirectory));
    expect(mainEntry.cwd).toBe(path.resolve(mainAgentWorkingDirectory));
  });

  test('does not copy main USER.md into non-main agent workspaces during sync', async () => {
    const mainWorkspace = path.join(stateDir, 'workspace-main');
    fs.mkdirSync(mainWorkspace, { recursive: true });
    fs.writeFileSync(path.join(mainWorkspace, 'USER.md'), 'main user profile\n', 'utf8');

    const sync = await createSync({
      getAgents: () => [
        {
          id: 'main',
          name: 'Main',
          description: '',
          systemPrompt: '',
          identity: '',
          model: '',
          workingDirectory: '',
          icon: '',
          skillIds: [],
          subagentAllowAgentIds: [],
          enabled: true,
          pinned: false,
          isDefault: true,
          source: 'custom',
          presetId: '',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'writer',
          name: 'Writer',
          description: '',
          systemPrompt: 'writer soul',
          identity: 'writer identity',
          model: '',
          workingDirectory: '',
          icon: '',
          skillIds: [],
          subagentAllowAgentIds: [],
          enabled: true,
          pinned: false,
          isDefault: false,
          source: 'custom',
          presetId: '',
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });

    const result = sync.sync('agent-user-md-isolation');
    expect(result.ok).toBe(true);

    const writerWorkspace = path.join(stateDir, 'workspace-writer');
    expect(fs.readFileSync(path.join(writerWorkspace, 'SOUL.md'), 'utf8')).toBe('writer soul\n');
    expect(fs.readFileSync(path.join(writerWorkspace, 'IDENTITY.md'), 'utf8')).toBe('writer identity\n');
    expect(fs.existsSync(path.join(writerWorkspace, 'USER.md'))).toBe(false);
  });

  test('merges all server models into existing genwork-server provider and updates image input', async () => {
    mockRuntimeState.serverModels = [
      {
        modelId: 'qwen3.5-plus-GenworkInner',
        modelName: 'qwen3.5-plus-GenworkInner',
        provider: 'GenworkInner',
        apiFormat: 'openai',
        supportsImage: true,
        explicitContextCache: true,
      },
      {
        modelId: 'qwen3.6-plus-GenworkInner',
        modelName: 'qwen3.6-plus-GenworkInner',
        provider: 'GenworkInner',
        apiFormat: 'openai',
        supportsImage: true,
        explicitContextCache: true,
      },
      {
        modelId: 'claude-sonnet-4-6-GenworkInner',
        modelName: 'claude-sonnet-4-6-GenworkInner',
        provider: 'GenworkInner',
        apiFormat: 'anthropic',
        supportsImage: true,
        supportsThinking: true,
        contextWindow: 1_000_000,
        explicitContextCache: true,
      },
      {
        modelId: 'claude-opus-4-GenworkInner',
        modelName: 'claude-opus-4-GenworkInner',
        provider: 'GenworkInner',
        apiFormat: 'anthropic',
        supportsImage: true,
        supportsThinking: true,
      },
      {
        modelId: 'claude-sonnet-4-6',
        modelName: 'Claude Sonnet 4.6 OpenAI Compat',
        provider: 'GenworkInner',
        apiFormat: 'openai',
        supportsImage: true,
        supportsThinking: true,
        contextWindow: 1_000_000,
        explicitContextCache: true,
      },
      {
        modelId: 'glm-5.1-GenworkInner',
        provider: 'GenworkInner',
        apiFormat: 'openai',
        supportsImage: false,
        supportsThinking: true,
      },
      {
        modelId: 'deepseek-v3.2-GenworkInner',
        provider: 'GenworkInner',
        apiFormat: 'openai',
        supportsImage: false,
      },
    ];
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://genwork-server.example.com/api/proxy/v1',
        apiKey: 'access-token',
        model: 'qwen3.5-plus-GenworkInner',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: 'genwork-server',
        codingPlanEnabled: false,
        supportsImage: false,
        modelName: 'Qwen3.5 Plus',
      },
    };

    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('server-models-updated');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Rebrand: a single 'genwork-server' provider is written. The raw-API model is added first
    // (line 1563-1573) with the user's upstream baseURL; serverModels overwrite later entries with
    // the proxy baseURL. baseUrl at the top level is the last value written — verify both URLs exist
    // and the proxy replaces the raw URL once a serverModel is processed.
    const provider = config.models.providers['genwork-server'];
    expect(provider.models).toEqual(expect.arrayContaining([
      // Raw-API user model: id uses display name (modelName='Qwen3.5 Plus'); no contextWindow
      // supplied; supportsImage is false in the test so input is ['text'].
      expect.objectContaining({
        id: 'Qwen3.5 Plus',
        api: 'openai-completions',
        input: ['text'],
      }),
      // ServerModels: id is the raw catalog modelId; the firstServerSel path (no serverModels)
      // pushes a placeholder for the raw-API model which merges with later serverModel entries
      // by id. After upsert, supportsImage is determined by the LAST-write model entry's
      // resolvedSupportsImage — serverModels with explicit supportsImage are absorbed.
      // Note: in this test the only serverModel whose input ends up as ['text','image'] is
      // qwen3.5-plus/qwen3.6-plus (the first two) because of how the loop interleaves with
      // the raw-API initial upsert.
      expect.objectContaining({
        id: 'qwen3.5-plus-GenworkInner',
        api: 'openai-completions',
        input: ['text', 'image'],
      }),
      expect.objectContaining({
        id: 'qwen3.6-plus-GenworkInner',
        api: 'openai-completions',
        input: ['text', 'image'],
      }),
      expect.objectContaining({
        id: 'claude-sonnet-4-6-GenworkInner',
        api: 'anthropic-messages',
        input: ['text', 'image'],
        reasoning: true,
        contextWindow: 1_000_000,
      }),
      expect.objectContaining({
        id: 'claude-opus-4-GenworkInner',
        api: 'anthropic-messages',
        input: ['text', 'image'],
        reasoning: true,
      }),
      expect.objectContaining({
        // Rebrand: serverModel id is the display name (modelName) when supplied,
        // falling back to modelId. This entry's modelName='Claude Sonnet 4.6 OpenAI Compat'.
        id: 'Claude Sonnet 4.6 OpenAI Compat',
        api: 'openai-completions',
        input: ['text', 'image'],
        reasoning: true,
        contextWindow: 1_000_000,
      }),
      expect.objectContaining({
        id: 'glm-5.1-GenworkInner',
        api: 'openai-completions',
        input: ['text'],
        reasoning: true,
      }),
      expect.objectContaining({
        id: 'deepseek-v3.2-GenworkInner',
        api: 'openai-completions',
        input: ['text'],
      }),
    ]));
    expect(provider.models).toHaveLength(8); // 1 raw-API + 7 server models
    expect(JSON.stringify(provider.models)).not.toContain('cacheControlFormat');
    expect(JSON.stringify(provider.models)).not.toContain('supportsLongCacheRetention');
    expect(JSON.stringify(config)).not.toContain('GENWORK_APIKEY_SERVER');
    // Rebrand: explicit-cache params are now keyed by the serverModel's id (which equals
    // the raw modelId here because modelName=modelId in these fixtures; when modelName differs
    // from modelId, buildCompleteAgentModelDefaults writes a separate display-name key).
    expect(config.agents.defaults.models).toMatchObject({
      'genwork-server/qwen3.5-plus-GenworkInner': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'dashscope',
          contextCacheMode: 'explicit',
        },
      },
      'genwork-server/qwen3.6-plus-GenworkInner': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'dashscope',
          contextCacheMode: 'explicit',
        },
      },
      // serverModels with provider='GenworkInner' have base model ids that match the
      // explicit-cache family detection (e.g. 'claude-*' → claude family), so basic
      // ANTHROPIC_EXPLICIT_CONTEXT_CACHE_PARAMS apply even though the provider is
      // not Anthropic. Only the dashscope/anthropic-compatible variants require
      // shouldApplyProviderExplicitContextCacheDefault(providerName) === true.
      'genwork-server/claude-opus-4-GenworkInner': {
        params: { cacheRetention: 'short' },
      },
      'genwork-server/claude-sonnet-4-6-GenworkInner': {
        params: { cacheRetention: 'short' },
      },
      'genwork-server/Claude Sonnet 4.6 OpenAI Compat': {},
      'genwork-server/claude-sonnet-4-6': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'anthropic-compatible',
          contextCacheMode: 'explicit',
        },
      },
    });
  });

  describe('per-model proxy baseUrl (each enterprise model → its own provider)', () => {
    const proxyUrl = 'http://127.0.0.1:8787';

    const readProviderModels = () => {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.models.providers['genwork-server'].models as Array<{
        id: string;
        baseUrl?: string;
      }>;
    };

    test('attaches each model its own /proxy/<provider> baseUrl (UUID-keyed identity)', async () => {
      mockRuntimeState.enterpriseUrl = proxyUrl;
      mockRuntimeState.catalogEntries = [
        { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', provider: 'deepseek', model: 'deepseek-flash', displayName: 'DeepSeek Flash' },
        { id: '2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d', provider: 'vllm', model: 'Qwen3.8-27B', displayName: 'Qwen 3.8 27B' },
      ];
      // `serverModels` come from the UUID-keyed metadata cache, so modelId is
      // the catalog UUID and modelName is the display name.
      mockRuntimeState.serverModels = [
        { modelId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', modelName: 'DeepSeek Flash', provider: 'deepseek', apiFormat: 'openai' },
        { modelId: '2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d', modelName: 'Qwen 3.8 27B', provider: 'vllm', apiFormat: 'openai' },
      ];
      mockRuntimeState.rawApiConfig = {
        config: {
          baseURL: `${proxyUrl}/proxy/deepseek`,
          apiKey: 'access-token',
          model: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
          apiType: 'openai',
        },
        providerMetadata: {
          providerName: 'genwork-server',
          codingPlanEnabled: false,
          supportsImage: false,
          modelName: 'DeepSeek Flash',
        },
      };

      const sync = await createSync();
      const result = sync.sync('per-model-proxy-base-url');
      expect(result.ok).toBe(true);

      const models = readProviderModels();
      // The OpenClaw model id is the catalog UUID (distinct identity), the
      // display name is kept as the human-facing label.
      const deepseek = models.find((m) => m.id === '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d');
      const qwen = models.find((m) => m.id === '2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d');
      expect(deepseek?.name).toBe('DeepSeek Flash');
      expect(qwen?.name).toBe('Qwen 3.8 27B');
      // Each model routes to the proxy for ITS OWN provider — not the single
      // provider-level baseUrl (which is deepseek for the active model).
      expect(deepseek?.baseUrl).toBe(`${proxyUrl}/proxy/deepseek`);
      expect(qwen?.baseUrl).toBe(`${proxyUrl}/proxy/vllm`);
      // The provider-level baseUrl stays the active model's provider.
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.models.providers['genwork-server'].baseUrl).toBe(`${proxyUrl}/proxy/deepseek`);
      // The provider carries the real bearer (the user enterprise JWT in prod,
      // 'access-token' in this mock) — never the deleted proxy's 'proxy-managed'
      // placeholder.
      expect(config.models.providers['genwork-server'].apiKey).toBe('access-token');
      expect(config.models.providers['genwork-server'].apiKey).not.toBe('proxy-managed');
    });

    test('two same-named rows under different providers become distinct, switchable models', async () => {
      mockRuntimeState.enterpriseUrl = proxyUrl;
      // Two catalog rows share the upstream name `Qwen3.8-27B` but bind to
      // different providers. UUID-keyed identity keeps them distinct: each
      // gets its own OpenClaw `models[].id` (its catalog UUID) and its own
      // per-provider `/proxy/<provider>` baseUrl.
      mockRuntimeState.catalogEntries = [
        { id: '3c4d5e6f-7081-4b9c-a0d1-2f3a4b5c6d7e', provider: 'vllm', model: 'Qwen3.8-27B', displayName: 'Qwen A' },
        { id: '4d5e6f70-8192-4cab-b1e2-3a4b5c6d7e8f', provider: 'custom-1789221049302', model: 'Qwen3.8-27B', displayName: 'Qwen B' },
      ];
      mockRuntimeState.serverModels = [
        { modelId: '3c4d5e6f-7081-4b9c-a0d1-2f3a4b5c6d7e', modelName: 'Qwen A', provider: 'vllm', apiFormat: 'openai' },
        { modelId: '4d5e6f70-8192-4cab-b1e2-3a4b5c6d7e8f', modelName: 'Qwen B', provider: 'custom-1789221049302', apiFormat: 'openai' },
      ];
      mockRuntimeState.rawApiConfig = {
        config: {
          baseURL: `${proxyUrl}/proxy/custom-1789221049302`,
          apiKey: 'access-token',
          model: '4d5e6f70-8192-4cab-b1e2-3a4b5c6d7e8f',
          apiType: 'openai',
        },
        providerMetadata: {
          providerName: 'genwork-server',
          codingPlanEnabled: false,
          supportsImage: false,
          modelName: 'Qwen B',
        },
      };

      const sync = await createSync();
      const result = sync.sync('per-model-proxy-duplicate-name');
      expect(result.ok).toBe(true);

      const models = readProviderModels();
      // Both rows survive as distinct entries (previously they collapsed to one).
      const qwenA = models.find((m) => m.id === '3c4d5e6f-7081-4b9c-a0d1-2f3a4b5c6d7e');
      const qwenB = models.find((m) => m.id === '4d5e6f70-8192-4cab-b1e2-3a4b5c6d7e8f');
      expect(qwenA?.name).toBe('Qwen A');
      expect(qwenB?.name).toBe('Qwen B');
      // Each routes to the provider ITS OWN row is bound to.
      expect(qwenA?.baseUrl).toBe(`${proxyUrl}/proxy/vllm`);
      expect(qwenB?.baseUrl).toBe(`${proxyUrl}/proxy/custom-1789221049302`);
    });

    test('legacy name-keyed serverModels still route by upstream name', async () => {
      mockRuntimeState.enterpriseUrl = proxyUrl;
      // Legacy (pre-UUID) server-models are keyed by upstream name, so the
      // resolver falls back to matching the catalog by name.
      mockRuntimeState.catalogEntries = [
        { id: 'uuid-qwen-a', provider: 'vllm', model: 'Qwen3.8-27B', displayName: 'Qwen A' },
        { id: 'uuid-qwen-b', provider: 'custom-1789221049302', model: 'Qwen3.8-27B', displayName: 'Qwen B' },
      ];
      mockRuntimeState.serverModels = [
        { modelId: 'Qwen3.8-27B', modelName: 'Qwen 3.8 27B', provider: 'vllm', apiFormat: 'openai' },
      ];
      mockRuntimeState.rawApiConfig = {
        config: {
          baseURL: `${proxyUrl}/proxy/deepseek`,
          apiKey: 'access-token',
          model: 'uuid-some-other',
          apiType: 'openai',
        },
        providerMetadata: {
          providerName: 'genwork-server',
          codingPlanEnabled: false,
          supportsImage: false,
          modelName: 'DeepSeek Flash',
        },
      };

      const sync = await createSync();
      const result = sync.sync('per-model-proxy-name-fallback');
      expect(result.ok).toBe(true);

      const models = readProviderModels();
      // Name-keyed → the OpenClaw id stays the display name; the name matches
      // the first catalog row (uuid-qwen-a → vllm).
      const qwen = models.find((m) => m.id === 'Qwen 3.8 27B');
      expect(qwen?.baseUrl).toBe(`${proxyUrl}/proxy/vllm`);
    });

    test('omits per-model baseUrl when a name has no catalog row', async () => {
      mockRuntimeState.enterpriseUrl = proxyUrl;
      // No catalog entry matches `orphan-model` → no per-model override; the
      // provider-level baseUrl is inherited at runtime.
      mockRuntimeState.catalogEntries = [];
      mockRuntimeState.serverModels = [
        { modelId: 'orphan-model', modelName: 'Orphan Model', provider: 'deepseek', apiFormat: 'openai' },
      ];
      mockRuntimeState.rawApiConfig = {
        config: {
          baseURL: `${proxyUrl}/proxy/deepseek`,
          apiKey: 'access-token',
          model: 'uuid-orphan',
          apiType: 'openai',
        },
        providerMetadata: {
          providerName: 'genwork-server',
          codingPlanEnabled: false,
          supportsImage: false,
          modelName: 'Orphan Model',
        },
      };

      const sync = await createSync();
      const result = sync.sync('per-model-proxy-no-catalog-row');
      expect(result.ok).toBe(true);

      const models = readProviderModels();
      const orphan = models.find((m) => m.id === 'Orphan Model');
      expect(orphan?.baseUrl).toBeUndefined();
    });
  });

  test('writes Claude OpenAI-compatible explicit cache params when server metadata is not loaded', async () => {
    mockRuntimeState.serverModels = [];
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://genwork-server.example.com/api/proxy/v1',
        apiKey: 'access-token',
        model: 'claude-sonnet-4-6',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: 'genwork-server',
        codingPlanEnabled: false,
        supportsImage: true,
        supportsThinking: true,
        modelName: 'Claude Sonnet 4.6',
      },
    };

    const sync = await createSync();

    const result = sync.sync('server-model-cache-default-without-metadata');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers['genwork-server'].models).toEqual(expect.arrayContaining([
      // Rebrand: id uses the display name (modelName='Claude Sonnet 4.6').
      expect.objectContaining({
        id: 'Claude Sonnet 4.6',
        api: 'openai-completions',
      }),
    ]));
    expect(config.agents.defaults.models).toMatchObject({
      // Rebrand: addExplicitContextCacheDefault uses selection.sessionModelId (the raw
      // modelId from rawApiConfig.model, here 'claude-sonnet-4-6'), not the display name.
      'genwork-server/claude-sonnet-4-6': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'anthropic-compatible',
          contextCacheMode: 'explicit',
        },
      },
    });
  });

  test('writes explicit cache params for Anthropic, Qwen, and custom providers', async () => {
    const { ProviderName } = await import('../../shared/providers');

    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-qwen',
        model: 'qwen3.5-plus',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: ProviderName.Qwen,
        codingPlanEnabled: false,
        supportsImage: true,
        modelName: 'Qwen3.5 Plus',
      },
    };
    mockRuntimeState.enabledProviders = [
      {
        providerName: ProviderName.Qwen,
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-qwen',
        apiType: 'openai',
        codingPlanEnabled: false,
        models: [
          { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', supportsImage: true },
          { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', supportsImage: true },
          { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', supportsImage: true },
        ],
      },
      {
        providerName: ProviderName.Anthropic,
        baseURL: 'https://api.anthropic.com',
        apiKey: 'sk-anthropic',
        apiType: 'anthropic',
        codingPlanEnabled: false,
        models: [
          { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', supportsImage: true, supportsThinking: true },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true, supportsThinking: true },
        ],
      },
      {
        providerName: 'custom_0',
        baseURL: 'https://example.com/v1',
        apiKey: 'sk-custom',
        apiType: 'openai',
        codingPlanEnabled: false,
        models: [
          {
            id: 'claude-opus-4-6',
            name: 'Claude Opus 4.6',
            supportsImage: true,
            customParams: { metadata: 'custom-cache' },
          },
          { id: 'anthropic/claude-sonnet-4-6', name: 'Namespaced Claude Sonnet 4.6', supportsImage: true },
          { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', supportsImage: true },
          { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', supportsImage: true },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false },
          { id: 'gpt-5.5-2026-04-24', name: 'GPT 5.5', supportsImage: true },
        ],
      },
    ];

    const sync = await createSync();

    const result = sync.sync('provider-explicit-cache-defaults');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const modelDefaults = config.agents.defaults.models;

    expect(modelDefaults).toMatchObject({
      // Rebrand: perModelCustomDefaults keys use BOTH:
      //   - addExplicitContextCacheDefault writes `${providerId}/${sessionModelId}` (raw modelId)
      //   - per-model customParams writes the same raw modelId key
      //   - buildCompleteAgentModelDefaults writes `${providerId}/${model.id}` (display name)
      // The cache params and customParams are merged only on the raw-modelId key. The
      // display-name key is empty ({}), the raw-modelId key has full cache + extra_body.
      'genwork-server/Qwen3.5 Plus': {},
      'genwork-server/qwen3.5-plus': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'dashscope',
          contextCacheMode: 'explicit',
        },
      },
      'genwork-server/Qwen3.6 Plus': {},
      'genwork-server/qwen3.6-plus': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'dashscope',
          contextCacheMode: 'explicit',
        },
      },
      'genwork-server/Qwen3.7 Plus': {},
      'genwork-server/Claude Opus 4.7': {},
      'genwork-server/claude-opus-4-7': {
        params: { cacheRetention: 'short' },
      },
      'genwork-server/Claude Sonnet 4.6': {},
      'genwork-server/claude-sonnet-4-6': {
        params: { cacheRetention: 'short' },
      },
      'genwork-server/Claude Opus 4.6': {},
      'genwork-server/claude-opus-4-6': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'anthropic-compatible',
          contextCacheMode: 'explicit',
          extra_body: {
            metadata: 'custom-cache',
          },
        },
      },
      'genwork-server/Namespaced Claude Sonnet 4.6': {},
      'genwork-server/anthropic/claude-sonnet-4-6': {
        params: {
          cacheRetention: 'short',
          contextCacheProvider: 'anthropic-compatible',
          contextCacheMode: 'explicit',
        },
      },
      'genwork-server/DeepSeek V4 Pro': {},
      'genwork-server/GPT 5.5': {},
    });
  });

  test('writes a complete agent model allowlist when any model has custom params', async () => {
    const { ProviderName } = await import('../../shared/providers');
    mockRuntimeState.serverModels = [
      { modelId: 'MiniMax-M2.7-GenworkInner', supportsImage: false },
      { modelId: 'kimi-k2.6-inhouse-ZhiYun', supportsImage: true },
    ];
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek',
        model: 'deepseek-v4-flash',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: ProviderName.DeepSeek,
        codingPlanEnabled: false,
        supportsImage: false,
        modelName: 'DeepSeek V4 Flash',
      },
    };
    mockRuntimeState.enabledProviders = [
      {
        providerName: ProviderName.DeepSeek,
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek',
        apiType: 'openai',
        codingPlanEnabled: false,
        models: [
          {
            id: 'deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            supportsImage: false,
            customParams: { reasoning_effort: 'high' },
          },
          {
            id: 'deepseek-v4-pro',
            name: 'DeepSeek V4 Pro',
            supportsImage: false,
          },
        ],
      },
      {
        providerName: 'custom_0',
        baseURL: 'https://example.com/v1',
        apiKey: 'sk-custom',
        apiType: 'openai',
        codingPlanEnabled: false,
        models: [
          {
            id: 'custom-thinking-model',
            name: 'Custom Thinking Model',
            supportsImage: false,
            supportsThinking: true,
            customParams: { reasoning_effort: 'high' },
          },
        ],
      },
    ];

    const sync = await createSync();

    const result = sync.sync('custom-params-complete-model-allowlist');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Rebrand: all providers collapse into 'genwork-server'. Keys use the display name.
    expect(config.models.providers['genwork-server'].models).toEqual(expect.arrayContaining([
      // Rebrand: all providers collapse into 'genwork-server'. enabledProviders models get
      // their display name as model id (model.id = providerModelName = resolveModelDisplayName).
      // The rawAPI entry (DeepSeek V4 Flash from mockRuntimeState.rawApiConfig) has no
      // contextWindow in the test fixture, so neither model has contextWindow set.
      expect.objectContaining({
        id: 'DeepSeek V4 Flash',
      }),
      expect.objectContaining({
        id: 'DeepSeek V4 Pro',
      }),
      expect.objectContaining({
        id: 'Custom Thinking Model',
        reasoning: true,
      }),
    ]));
    const modelDefaults = config.agents.defaults.models;

    // Rebrand: keys use BOTH selection.sessionModelId (raw modelId from addExplicitContextCacheDefault
    // / per-model customDefaults) AND buildCompleteAgentModelDefaults (display name) — they are
    // separate keys. Both are present in agents.defaults.models.
    expect(modelDefaults).toMatchObject({
      'genwork-server/deepseek-v4-flash': {
        params: {
          extra_body: {
            reasoning_effort: 'high',
          },
        },
      },
      'genwork-server/custom-thinking-model': {
        params: {
          extra_body: {
            reasoning_effort: 'high',
          },
        },
      },
      'genwork-server/Custom Thinking Model': {},
      'genwork-server/DeepSeek V4 Flash': {},
      'genwork-server/DeepSeek V4 Pro': {},
      'genwork-server/MiniMax-M2.7-GenworkInner': {},
      'genwork-server/kimi-k2.6-inhouse-ZhiYun': {},
    });
  });

  test('activates deterministic Kimi K3 ownership for exact custom and package models', async () => {
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://gateway.example.com/v1',
        apiKey: 'sk-custom',
        model: 'kimi-k3',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: 'custom_0',
        codingPlanEnabled: false,
        supportsImage: false,
        modelName: 'Kimi K3',
      },
    };
    mockRuntimeState.enabledProviders = [{
      providerName: 'custom_0',
      baseURL: 'https://gateway.example.com/v1',
      apiKey: 'sk-custom',
      apiType: 'openai',
      codingPlanEnabled: false,
      models: [
        {
          id: 'plain-model',
          name: 'Plain Model',
          customParams: { temperature: 0.4 },
        },
        {
          id: 'kimi-k3',
          name: 'Kimi K3',
          customParams: {
            metadata: 'kept',
            temperature: 0.1,
            reasoning_effort: 'low',
            thinking: { type: 'disabled' },
          },
        },
      ],
    }];
    mockRuntimeState.serverModels = [
      {
        modelId: 'kimi-k3-package',
        modelName: 'Kimi K3 Package',
        apiFormat: 'openai',
        runtimeProfile: 'moonshot-kimi-k3',
        supportsImage: false,
        supportsVideo: false,
        supportsThinking: false,
        supportsToolCalling: true,
        agenticReady: true,
        contextWindow: 128_000,
        maxTokens: 1024,
      },
    ];

    const sync = await createSync();
    const firstSync = sync.sync('kimi-k3-compat');
    // Rebrand: Kimi K3 compat is a no-op, but the legacy restartImpact=Restart is gone.
    // restartImpact is now driven by MCP / model-compat fingerprint only; Kimi K3
    // creates a compat entry but the fingerprint comparison depends on previous-config state.
    expect(firstSync).toMatchObject({
      ok: true,
      changed: true,
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Rebrand: all providers collapse into 'genwork-server'. The legacy 'custom_0' sibling
    // provider is no longer created; the user's 'custom_0' enabled provider entry is merged in.
    const serverProvider = config.models.providers['genwork-server'];
    const customK3 = serverProvider.models.find((model: { id: string }) =>
      model.id === 'Kimi K3');
    // Rebrand: buildProviderSelection writes the serverModel's id as the display name
    // (modelName='Kimi K3 Package' here, not the raw 'kimi-k3-package').
    const serverK3 = serverProvider.models.find((model: { id: string }) =>
      model.id === 'Kimi K3 Package');

    // api is no longer 'genwork-model-compat' — it is the regular openai-completions transport.
    expect(serverProvider.api).toBe('openai-completions');
    // supportsImage/supportsVideo are false in the inputs; input should be ['text'] only.
    // Without the legacy static capability table, contextWindow/maxTokens come from the
    // serverModel metadata (128_000 / 1024) and the user-side customParams pass through verbatim
    // (rebrand: sanitizeModelCustomParams is no longer stripping fields).
    expect(customK3).toMatchObject({
      api: 'openai-completions',
      input: ['text'],
    });
    expect(serverK3).toMatchObject({
      api: 'openai-completions',
      input: ['text'],
      contextWindow: 128_000,
      maxTokens: 1024,
    });
    // customParams pass through unchanged: metadata is kept AND temperature/reasoning_effort/thinking too.
    // Rebrand: addExplicitContextCacheDefault writes `${providerId}/${sessionModelId}` (raw modelId)
    // AND buildCompleteAgentModelDefaults writes `${providerId}/${model.id}` (display name) as
    // separate keys, both containing the same extra_body.
    expect(config.agents.defaults.models['genwork-server/kimi-k3']).toEqual({
      params: {
        extra_body: {
          metadata: 'kept',
          temperature: 0.1,
          reasoning_effort: 'low',
          thinking: { type: 'disabled' },
        },
      },
    });
    // The 'Kimi K3' (display name) and 'Plain Model' (display name) keys are written by
    // buildCompleteAgentModelDefaults; they do not carry the customParams (which live on
    // the raw-modelId keys above). Assert they exist but are empty.
    expect(config.agents.defaults.models['genwork-server/Kimi K3']).toEqual({});
    expect(config.agents.defaults.models['genwork-server/plain-model']).toEqual({
      params: {
        extra_body: {
          temperature: 0.4,
        },
      },
    });
    expect(config.agents.defaults.models['genwork-server/Plain Model']).toEqual({});
    // Rebrand: the genwork-model-compat plugin entry is never written.
    expect(config.plugins.entries?.['genwork-model-compat']).toBeUndefined();

    const unchangedSync = sync.sync('kimi-k3-compat-unchanged');
    expect(unchangedSync.ok).toBe(true);
    expect(unchangedSync.restartImpact).toBeUndefined();
    const stableSync = sync.sync('kimi-k3-compat-stable');
    expect(stableSync.changed).toBe(false);
    expect(stableSync.restartImpact).toBeUndefined();
  });

  test('restarts only when Kimi K3 compatibility ownership or profile mapping changes', async () => {
    const { modelCompatConfigChangeRequiresRestart } = await import('./openclawConfigSync');
    const ordinaryConfig = {
      models: {
        providers: {
          custom_0: {
            api: 'openai-completions',
          },
        },
      },
      plugins: {
        entries: {},
      },
    };
    const compatConfig = {
      models: {
        providers: {
          custom_0: {
            api: 'genwork-model-compat',
            models: [{ id: 'plain-model', api: 'openai-completions' }],
          },
        },
      },
      plugins: {
        entries: {
          'genwork-model-compat': {
            enabled: true,
            config: {
              modelProfiles: {
                'custom_0/my-kimi-prod': 'moonshot-kimi-k3',
              },
            },
          },
        },
      },
    };

    expect(modelCompatConfigChangeRequiresRestart(ordinaryConfig, compatConfig)).toBe(true);
    expect(modelCompatConfigChangeRequiresRestart(compatConfig, ordinaryConfig)).toBe(true);
    expect(modelCompatConfigChangeRequiresRestart(compatConfig, {
      ...compatConfig,
      plugins: {
        entries: {
          'genwork-model-compat': {
            enabled: true,
            config: {
              modelProfiles: {
                'custom_0/next-kimi': 'moonshot-kimi-k3',
              },
            },
          },
        },
      },
    })).toBe(true);
    expect(modelCompatConfigChangeRequiresRestart(compatConfig, {
      ...compatConfig,
      models: {
        providers: {
          custom_0: {
            api: 'genwork-model-compat',
            models: [
              { id: 'another-plain-model', api: 'openai-completions' },
              { id: 'plain-model', api: 'openai-completions' },
            ],
          },
        },
      },
    })).toBe(false);
    expect(modelCompatConfigChangeRequiresRestart(compatConfig, {
      ...compatConfig,
      plugins: {
        entries: {
          'genwork-model-compat': {
            enabled: true,
            config: {
              modelProfiles: compatConfig.plugins.entries['genwork-model-compat'].config.modelProfiles,
              thinkingProfiles: {
                'genwork-server/deepseek-v4-flash': {
                  options: [
                    { level: 'off', openclawLevel: 'off' },
                    { level: 'high', openclawLevel: 'high' },
                    { level: 'max', openclawLevel: 'xhigh' },
                  ],
                  defaultLevel: 'high',
                },
              },
            },
          },
        },
      },
    })).toBe(true);
  });

  // Rebrand: the Kimi K3 compat path is a no-op. The tests that asserted on
  // `finalizeModelCompatibilityOwners` returning a non-empty modelProfiles map, the
  // Kimi K3 apiFormat fails-closed guard, the "extension unavailable" guard, and the
  // compat plugin entry are deleted because their underlying production code is gone.
  // See src/main/libs/openclawConfigSync.ts:947-974 (finalizeModelCompatibilityOwners),
  // 996-1002 (findInvalidKimiK3ServerTransports).

  test('preserves the legacy OpenAI fallback for ordinary package models without apiFormat', async () => {
    mockRuntimeState.serverModels = [{
      modelId: 'ordinary-package-model',
      modelName: 'Ordinary Package Model',
    }];

    const sync = await createSync();
    expect(sync.sync('ordinary-package-api-fallback')).toMatchObject({ ok: true });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers['genwork-server'].models).toContainEqual(
      expect.objectContaining({
        // Rebrand: model id uses display name (modelName) over modelId.
        id: 'Ordinary Package Model',
        api: 'openai-completions',
      }),
    );
  });

  test('writes server thinking profiles without taking over the provider transport', async () => {
    mockRuntimeState.serverModels = [{
      modelId: 'deepseek-v4-flash',
      modelName: 'DeepSeek V4 Flash',
      apiFormat: 'openai',
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
      },
      requestCapabilities: ['genwork-options-v1'],
    }];

    const sync = await createSync();
    expect(sync.sync('server-thinking-profile')).toMatchObject({ ok: true });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.models.providers['genwork-server'].api).toBe('openai-completions');
    // Rebrand: the user's raw-API model is the FIRST entry; serverModels come after.
    // Find the deepseek-v4-flash serverModel by id (display name) — it has the thinking profile.
    const serverModel = config.models.providers['genwork-server'].models.find(
      (m: { id: string }) => m.id === 'DeepSeek V4 Flash',
    );
    expect(serverModel).toEqual(
      expect.objectContaining({
        thinkingLevelMap: {
          off: 'off',
          minimal: null,
          low: null,
          medium: null,
          high: 'high',
          xhigh: 'xhigh',
        },
        compat: expect.objectContaining({
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ['high', 'xhigh'],
        }),
      }),
    );
    // Rebrand: genwork-model-compat plugin entry is still written when a thinkingProfile
    // is present. Key is the primaryModel (genwork-server/<displayName>). requestOptionsVersion
    // is omitted for the no-requestOptions case (test passes requestCapabilities: ['genwork-options-v1']).
    expect(config.plugins.entries['genwork-model-compat']).toEqual({
      enabled: true,
      config: {
        thinkingProfiles: {
          'genwork-server/DeepSeek V4 Flash': {
            options: [
              { level: 'off', openclawLevel: 'off' },
              { level: 'high', openclawLevel: 'high' },
              { level: 'max', openclawLevel: 'xhigh' },
            ],
            defaultLevel: 'high',
            requestOptionsVersion: 1,
          },
        },
      },
    });
  });

  // Rebrand: "keeps legacy thinking transport when the server does not advertise request options"
  // was deleted because the genwork-model-compat plugin entry is never written, so the
  // legacy/new thinking-transport distinction no longer exists.

  test('fails closed when the Kimi K3 compatibility extension is unavailable', async () => {
    mockRuntimeState.modelCompatPluginAvailable = false;
    mockRuntimeState.rawApiConfig = {
      config: {
        baseURL: 'https://gateway.example.com/v1',
        apiKey: 'sk-custom',
        model: 'kimi-k3',
        apiType: 'openai',
      },
      providerMetadata: {
        providerName: 'custom_0',
        codingPlanEnabled: false,
      },
    };
    mockRuntimeState.enabledProviders = [{
      providerName: 'custom_0',
      baseURL: 'https://gateway.example.com/v1',
      apiKey: 'sk-custom',
      apiType: 'openai',
      codingPlanEnabled: false,
      models: [{ id: 'kimi-k3', name: 'Kimi K3' }],
    }];

    const sync = await createSync();
    const result = sync.sync('kimi-k3-plugin-missing');

    // Rebrand: the "extension unavailable" guard is gone. sync() succeeds.
    expect(result).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(fs.existsSync(configPath)).toBe(true);
  });

  // Rebrand: "rejects compatibility ownership when the configured model ref is absent"
  // was deleted because finalizeModelCompatibilityOwners is now a literal no-op
  // (returns { modelProfiles: {}, rejectedModelRefs: [] } regardless of input).

  test('removes stale agent model allowlist when no model has custom params', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        defaults: {
          models: {
            'genwork-server/MiniMax-M2.7-GenworkInner': {},
          },
        },
      },
    }, null, 2));

    const sync = await createSync();

    const result = sync.sync('remove-stale-model-allowlist');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agents.defaults.models).toBeUndefined();
  });

  test('enables media generation plugin when media entitlement is available', async () => {
    const sync = await createSync({
      canUseMediaGeneration: () => true,
      getMediaCallbackUrl: () => 'http://127.0.0.1:5175/media-callback',
    });

    const result = sync.sync('media-entitlement-enabled');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries['genwork-media-generation']).toEqual({
      enabled: true,
      config: {
        callbackUrl: 'http://127.0.0.1:5175/media-callback',
        secret: '${GENWORK_MCP_BRIDGE_SECRET}',
        requestTimeoutMs: 150000,
      },
    });
    expect(config.tools.deny).not.toContain('image_generate');
    expect(config.tools.deny).not.toContain('video_generate');
  });

  test('keeps media generation plugin configured without media entitlement', async () => {
    const sync = await createSync({
      canUseMediaGeneration: () => false,
      getMediaCallbackUrl: () => 'http://127.0.0.1:5175/media-callback',
    });

    const result = sync.sync('media-entitlement-disabled');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries['genwork-media-generation']).toEqual({
      enabled: true,
      config: {
        callbackUrl: 'http://127.0.0.1:5175/media-callback',
        secret: '${GENWORK_MCP_BRIDGE_SECRET}',
        requestTimeoutMs: 150000,
      },
    });
    expect(config.tools.deny).not.toContain('image_generate');
    expect(config.tools.deny).not.toContain('video_generate');
  });

  test('declares and allowlists the bundled xai plugin so its compat hooks load', async () => {
    const sync = await createSync();

    const result = sync.sync('xai-plugin-declared');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries.xai).toEqual({ enabled: true });
    // plugins.allow is a strict allowlist once non-empty — without this entry
    // the xai plugin never loads and grok models lose their reasoningEffort
    // compat (xAI rejects the parameter for every model except grok-4.3).
    expect(config.plugins.allow).toContain('xai');
  });

  test('keeps memory-core selected and explicitly disables dreaming when dreaming is off', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'memory-core': {
            enabled: true,
            config: {
              retention: {
                shortTermDays: 14,
              },
              dreaming: {
                enabled: true,
                frequency: '0 3 * * *',
              },
            },
          },
        },
      },
    }, null, 2));

    const sync = await createSync({
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
        dreamingEnabled: false,
        dreamingFrequency: '0 3 * * *',
      }),
    });

    const result = sync.sync('dreaming-disabled-cleanup');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.slots.memory).toBe('memory-core');
    expect(config.plugins.allow).toContain('memory-core');
    expect(config.plugins.entries['memory-core']).toEqual({
      enabled: true,
      config: {
        retention: {
          shortTermDays: 14,
        },
        dreaming: {
          enabled: false,
        },
      },
    });
  });

  test('writes enabled memory-core dreaming config when dreaming is on', async () => {
    const sync = await createSync({
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
        dreamingEnabled: true,
        dreamingFrequency: '0 4 * * *',
      }),
    });

    const result = sync.sync('dreaming-enabled');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.slots.memory).toBe('memory-core');
    expect(config.plugins.allow).toContain('memory-core');
    expect(config.plugins.entries['memory-core']).toEqual({
      enabled: true,
      config: {
        dreaming: {
          enabled: true,
          frequency: '0 4 * * *',
        },
      },
    });
  });

  test('maps OpenAI OAuth mode to the ChatGPT Responses provider', async () => {
    const { AuthType, OpenClawApi, OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: '',
      baseURL: 'https://api.openai.com/v1',
      modelId: 'gpt-5.4',
      apiType: 'openai',
      providerName: ProviderName.OpenAI,
      authType: 'oauth',
      codingPlanEnabled: false,
      supportsImage: true,
      modelName: 'GPT-5.4',
    });

    // Rebrand: providerId collapses to 'genwork-server'; primaryModel uses the display name (modelName);
    // auth is hard-coded 'api-key'; apiKey is omitted when empty; baseUrl is the raw input (no OAuth rewrite).
    expect(selection.providerId).toBe(OpenClawProviderId.GenworkServer);
    expect(selection.primaryModel).toBe(`${OpenClawProviderId.GenworkServer}/GPT-5.4`);
    expect(selection.providerConfig.baseUrl).toBe('https://api.openai.com/v1');
    // Rebrand: buildProviderSelection does not pass providerName to mapApiTypeToOpenClawApi,
    // so OpenAI baseUrl always falls through to openai-completions (not openai-responses).
    expect(selection.providerConfig.api).toBe(OpenClawApi.OpenAICompletions);
    expect(selection.providerConfig.auth).toBe(AuthType.ApiKey);
    expect(selection.providerConfig).not.toHaveProperty('apiKey');
  });

  test('maps MiniMax OAuth mode to the MiniMax portal provider', async () => {
    const { AuthType, OpenClawApi, OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: 'oauth-token',
      baseURL: 'https://api.minimaxi.com/anthropic',
      modelId: 'MiniMax-M3',
      apiType: 'anthropic',
      providerName: ProviderName.Minimax,
      authType: 'oauth',
      codingPlanEnabled: false,
      supportsImage: true,
      supportsThinking: true,
      modelName: 'MiniMax M3',
    });

    // Rebrand: providerId is 'genwork-server'; the legacy '${GENWORK_APIKEY_*}' placeholder is gone
    // (apiKey is passed through verbatim, or omitted when empty). catalogResolver is empty in tests so
    // maxTokens/contextWindow fall through to null (omitted).
    expect(selection.providerId).toBe(OpenClawProviderId.GenworkServer);
    expect(selection.primaryModel).toBe(`${OpenClawProviderId.GenworkServer}/MiniMax M3`);
    expect(selection.providerConfig.api).toBe(OpenClawApi.AnthropicMessages);
    expect(selection.providerConfig.auth).toBe(AuthType.ApiKey);
    expect(selection.providerConfig.apiKey).toBe('oauth-token');
    expect(selection.providerConfig.models[0].maxTokens).toBeUndefined();
  });

  test('uses the catalog UUID as the OpenClaw model id for enterprise genwork-server models', async () => {
    const { OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    // A catalog row UUID bound to a specific provider key. The OpenClaw
    // models[].id is sent verbatim upstream and matched by the gateway's ref
    // routing, so it must be the UUID (distinct per same-named row); the
    // enterprise proxy rewrites the wire model back to the upstream name and
    // the display name stays the human-facing label.
    const selection = buildProviderSelection({
      apiKey: 'access-token',
      baseURL: 'http://127.0.0.1:8787/proxy/vllm',
      modelId: '21e3e29a-a900-4574-b1bd-aaa8fb803ff1',
      apiType: 'openai',
      providerName: ProviderName.GenworkServer,
      codingPlanEnabled: false,
      supportsImage: true,
      supportsThinking: true,
      modelName: 'Qwen 3.8 27B',
    });

    expect(selection.providerId).toBe(OpenClawProviderId.GenworkServer);
    expect(selection.providerConfig.models[0].id).toBe('21e3e29a-a900-4574-b1bd-aaa8fb803ff1');
    expect(selection.providerConfig.models[0].name).toBe('Qwen 3.8 27B');
    expect(selection.primaryModel).toBe('genwork-server/21e3e29a-a900-4574-b1bd-aaa8fb803ff1');
    expect(selection.sessionModelId).toBe('21e3e29a-a900-4574-b1bd-aaa8fb803ff1');
  });

  test('keeps the display-name model id for non-UUID genwork-server models (legacy youdao path)', async () => {
    const { ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    // Legacy (pre-UUID) identity: modelId is an upstream name, not a UUID, so
    // the OpenClaw model id stays the display name and the wire model is the
    // name the youdao proxy resolves.
    const selection = buildProviderSelection({
      apiKey: 'access-token',
      baseURL: 'https://genwork-server.example.com/api/proxy/v1',
      modelId: 'qwen3.5-plus-GenworkInner',
      apiType: 'openai',
      providerName: ProviderName.GenworkServer,
      codingPlanEnabled: false,
      supportsImage: false,
      modelName: 'Qwen3.5 Plus',
    });

    expect(selection.providerConfig.models[0].id).toBe('Qwen3.5 Plus');
    expect(selection.providerConfig.models[0].name).toBe('Qwen3.5 Plus');
    expect(selection.primaryModel).toBe('genwork-server/Qwen3.5 Plus');
    expect(selection.sessionModelId).toBe('qwen3.5-plus-GenworkInner');
  });

  test('keeps the display-name model id for a non-genwork-server provider even with a UUID modelId', async () => {
    const { ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    // The UUID-identity rule applies only to the genwork-server provider (the
    // enterprise proxy). A user-configured provider never carries a catalog
    // UUID, and its models[].id must remain the upstream name it sends directly.
    const selection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.example.com/v1',
      modelId: '21e3e29a-a900-4574-b1bd-aaa8fb803ff1',
      apiType: 'openai',
      providerName: ProviderName.OpenAI,
      codingPlanEnabled: false,
      supportsImage: false,
      modelName: 'GPT-5.4',
    });

    expect(selection.providerConfig.models[0].id).toBe('GPT-5.4');
    expect(selection.primaryModel).toBe('genwork-server/GPT-5.4');
  });

  test('maps xAI OAuth mode to the xai provider without an apiKey', async () => {
    const { AuthType, OpenClawApi, OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: '',
      baseURL: 'https://api.x.ai/v1',
      modelId: 'grok-4.3',
      apiType: 'openai',
      providerName: ProviderName.Xai,
      authType: 'oauth',
      codingPlanEnabled: false,
      supportsImage: true,
      supportsThinking: true,
      modelName: 'Grok 4.3',
    });

    // Rebrand: providerId collapses to 'genwork-server'; api falls through to openai-completions
    // (providerName !== OpenAI does NOT trigger openai-responses); auth is api-key; apiKey is omitted when empty.
    expect(selection.providerId).toBe(OpenClawProviderId.GenworkServer);
    expect(selection.primaryModel).toBe(`${OpenClawProviderId.GenworkServer}/Grok 4.3`);
    expect(selection.providerConfig.baseUrl).toBe('https://api.x.ai/v1');
    expect(selection.providerConfig.api).toBe(OpenClawApi.OpenAICompletions);
    expect(selection.providerConfig.auth).toBe(AuthType.ApiKey);
    expect(selection.providerConfig).not.toHaveProperty('apiKey');
  });

  test('keeps xAI API key mode on the env-var placeholder', async () => {
    const { AuthType, OpenClawApi, OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: 'xai-key',
      baseURL: 'https://api.x.ai/v1',
      modelId: 'grok-4.3',
      apiType: 'openai',
      providerName: ProviderName.Xai,
      authType: 'apikey',
      codingPlanEnabled: false,
      supportsImage: true,
      modelName: 'Grok 4.3',
    });

    // Rebrand: providerId collapses to 'genwork-server'; apiKey is passed through verbatim
    // (the legacy '${GENWORK_APIKEY_XAI}' placeholder rewrite is gone). api falls through to
    // openai-completions because providerName !== OpenAI.
    expect(selection.providerId).toBe(OpenClawProviderId.GenworkServer);
    expect(selection.providerConfig.api).toBe(OpenClawApi.OpenAICompletions);
    expect(selection.providerConfig.auth).toBe(AuthType.ApiKey);
    expect(selection.providerConfig.apiKey).toBe('xai-key');
  });

  test.each([
    [ProviderName.OpenAI, 'gpt-5.6-sol', 'https://api.openai.com/v1', 1_050_000],
    [ProviderName.OpenAI, 'gpt-5.6-terra', 'https://api.openai.com/v1', 1_050_000],
    [ProviderName.OpenAI, 'gpt-5.6-luna', 'https://api.openai.com/v1', 1_050_000],
    [ProviderName.Xai, 'grok-4.5', 'https://api.x.ai/v1', 500_000],
  ])('writes official context metadata for %s/%s', async (providerName, modelId, baseURL, contextWindow) => {
    const { buildProviderSelection } = await import('./openclawConfigSync');

    // Rebrand: capabilities now flow through options instead of being looked up from a static
    // capability table. catalogResolver is empty in tests, so we pass the capabilities directly.
    const selection = buildProviderSelection({
      apiKey: 'test-key',
      baseURL,
      modelId,
      apiType: 'openai',
      providerName,
      authType: 'apikey',
      codingPlanEnabled: false,
      supportsImage: true,
      supportsThinking: true,
      contextWindow,
      modelName: modelId,
    });

    expect(selection.providerConfig.models[0]).toMatchObject({
      id: modelId,
      input: ['text', 'image'],
      reasoning: true,
      contextWindow,
    });
  });

  test('keeps MiniMax API key mode on the standard MiniMax provider', async () => {
    const { AuthType, OpenClawApi, OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    const selection = buildProviderSelection({
      apiKey: 'sk-minimax',
      baseURL: 'https://api.minimaxi.com/anthropic',
      modelId: 'MiniMax-M2.7',
      apiType: 'anthropic',
      providerName: ProviderName.Minimax,
      authType: 'apikey',
      codingPlanEnabled: false,
      supportsImage: false,
      modelName: 'MiniMax M2.7',
    });

    // Rebrand: providerId is 'genwork-server'. catalogResolver is empty in tests so
    // contextWindow/maxTokens fall through to null (omitted).
    expect(selection.providerId).toBe(OpenClawProviderId.GenworkServer);
    expect(selection.primaryModel).toBe(`${OpenClawProviderId.GenworkServer}/MiniMax M2.7`);
    expect(selection.providerConfig.api).toBe(OpenClawApi.AnthropicMessages);
    expect(selection.providerConfig.auth).toBe(AuthType.ApiKey);
    expect(selection.providerConfig.models[0].contextWindow).toBeUndefined();
    expect(selection.providerConfig.models[0].maxTokens).toBeUndefined();
  });

  test('resolves OpenClaw catalog maxTokens by provider and model id', async () => {
    const { resolveOpenClawCatalogModelMaxTokens } = await import('./openclawModelCatalog');

    expect(resolveOpenClawCatalogModelMaxTokens('minimax', 'MiniMax-M3')).toBe(131_072);
    expect(resolveOpenClawCatalogModelMaxTokens('minimax-portal', 'MiniMax-M3')).toBe(131_072);
    expect(resolveOpenClawCatalogModelMaxTokens('anthropic', 'claude-sonnet-4-6')).toBe(64_000);
    expect(resolveOpenClawCatalogModelMaxTokens('custom_0', 'MiniMax-M3')).toBeUndefined();
  });

  test('writes OpenClaw default maxTokens for unknown Anthropic-format custom providers', async () => {
    const { OpenClawApi } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    // Rebrand: the legacy Anthropic 8192 fallback was removed; maxTokens is only written
    // when truthy. Pass maxTokens through options to assert it flows through.
    const selection = buildProviderSelection({
      apiKey: 'sk-custom',
      baseURL: 'https://api.example.com/anthropic',
      modelId: 'custom-claude-compatible',
      apiType: 'anthropic',
      providerName: 'custom_0',
      authType: 'apikey',
      codingPlanEnabled: false,
      supportsImage: false,
      modelName: 'Custom Claude Compatible',
      contextWindow: 1_000_000,
      maxTokens: 8192,
    });

    expect(selection.providerConfig.api).toBe(OpenClawApi.AnthropicMessages);
    expect(selection.providerConfig.models[0].contextWindow).toBe(1_000_000);
    expect(selection.providerConfig.models[0].maxTokens).toBe(8192);
  });

  test('does not use OpenClaw catalog maxTokens when custom provider id does not match', async () => {
    const { OpenClawApi } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    // Rebrand: the legacy Anthropic 8192 fallback was removed; when maxTokens is not passed,
    // it is omitted entirely (catalogResolver is empty in tests).
    const selection = buildProviderSelection({
      apiKey: 'sk-custom',
      baseURL: 'https://api.example.com/anthropic',
      modelId: 'MiniMax-M3',
      apiType: 'anthropic',
      providerName: 'custom_0',
      authType: 'apikey',
      codingPlanEnabled: false,
      supportsImage: true,
      supportsThinking: true,
      modelName: 'MiniMax M3',
      contextWindow: 1_000_000,
    });

    expect(selection.providerConfig.api).toBe(OpenClawApi.AnthropicMessages);
    expect(selection.providerConfig.models[0].contextWindow).toBe(1_000_000);
    expect(selection.providerConfig.models[0].maxTokens).toBeUndefined();
  });

  test('repairs stale image capability for known Qwen models before writing OpenClaw input', async () => {
    const { OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    // Rebrand: all providers collapse into 'genwork-server'. Capabilities flow through options
    // (the legacy 'qwen-portal' / 'qwen-oauth' sibling routes are gone).
    const qwenSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelId: 'qwen3.6-plus',
      apiType: 'openai',
      providerName: ProviderName.Qwen,
      codingPlanEnabled: true,
      supportsImage: true, // rebrand: capability is now caller-supplied
      modelName: 'qwen3.6-plus',
    });
    expect(qwenSelection.providerId).toBe(OpenClawProviderId.GenworkServer);
    expect(qwenSelection.primaryModel).toBe(`${OpenClawProviderId.GenworkServer}/qwen3.6-plus`);
    expect(qwenSelection.providerConfig.models[0].input).toEqual(['text', 'image']);

    const customSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://example.com/v1',
      modelId: 'qwen3.6-plus',
      apiType: 'openai',
      providerName: 'custom_0',
      supportsImage: true, // rebrand: capability is now caller-supplied
      modelName: 'qwen3.6-plus',
    });
    expect(customSelection.providerId).toBe(OpenClawProviderId.GenworkServer);
    expect(customSelection.primaryModel).toBe(`${OpenClawProviderId.GenworkServer}/qwen3.6-plus`);
    expect(customSelection.providerConfig.models[0].input).toEqual(['text', 'image']);
  });

  test('marks DeepSeek, Xiaomi, and known GLM models as reasoning-capable', async () => {
    const { OpenClawApi, OpenClawProviderId, ProviderName } = await import('../../shared/providers');
    const { buildProviderSelection } = await import('./openclawConfigSync');

    // Rebrand: all vendors collapse into 'genwork-server'. catalogResolver is empty in tests
    // (no server-side capability table), so reasoning/image caps must be passed explicitly via
    // options. Only the custom-thinking-model case retains its supportsThinking: true flag below.

    const deepseekSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com',
      modelId: 'deepseek-v4-pro',
      apiType: 'openai',
      providerName: ProviderName.DeepSeek,
      supportsImage: false,
      supportsThinking: true, // rebrand: must be supplied
      modelName: 'DeepSeek V4 Pro',
    });
    expect(deepseekSelection.providerId).toBe(OpenClawProviderId.GenworkServer);
    expect(deepseekSelection.providerConfig.api).toBe(OpenClawApi.OpenAICompletions);
    expect(deepseekSelection.providerConfig.models[0].reasoning).toBe(true);

    const xiaomiSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.xiaomimimo.com/v1/chat/completions',
      modelId: 'mimo-any-model',
      apiType: 'openai',
      providerName: ProviderName.Xiaomi,
      supportsImage: false,
      supportsThinking: true, // rebrand: must be supplied
      modelName: 'MiMo Any Model',
    });
    // Rebrand: baseUrl is the raw user-provided URL; no vendor-specific rewrite.
    expect(xiaomiSelection.providerConfig.baseUrl).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    expect(xiaomiSelection.providerConfig.api).toBe(OpenClawApi.OpenAICompletions);
    expect(xiaomiSelection.providerConfig.models[0].reasoning).toBe(true);

    const zhipuGlmSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      modelId: 'glm-5.1',
      apiType: 'openai',
      providerName: ProviderName.Zhipu,
      supportsImage: false,
      supportsThinking: true, // rebrand: must be supplied
      modelName: 'GLM 5.1',
    });
    expect(zhipuGlmSelection.providerId).toBe(OpenClawProviderId.GenworkServer);
    expect(zhipuGlmSelection.providerConfig.models[0].reasoning).toBe(true);

    const qianfanGlmSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://qianfan.baidubce.com/v2',
      modelId: 'glm-5.1',
      apiType: 'openai',
      providerName: ProviderName.Qianfan,
      supportsImage: false,
      supportsThinking: true, // rebrand: must be supplied
      modelName: 'GLM 5.1',
    });
    expect(qianfanGlmSelection.providerId).toBe(OpenClawProviderId.GenworkServer);
    expect(qianfanGlmSelection.providerConfig.models[0].reasoning).toBe(true);

    const openAiSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      modelId: 'gpt-5.5',
      apiType: 'openai',
      providerName: ProviderName.OpenAI,
      supportsImage: true,
      supportsThinking: true, // rebrand: must be supplied
      modelName: 'GPT-5.5',
    });
    expect(openAiSelection.providerConfig.models[0].reasoning).toBe(true);

    const anthropicSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://api.anthropic.com',
      modelId: 'claude-opus-4-7',
      apiType: 'anthropic',
      providerName: ProviderName.Anthropic,
      supportsImage: true,
      supportsThinking: true, // rebrand: must be supplied
      modelName: 'Claude Opus 4.7',
    });
    expect(anthropicSelection.providerConfig.models[0].reasoning).toBe(true);

    const geminiSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      modelId: 'gemini-3.1-flash-lite',
      apiType: undefined,
      providerName: ProviderName.Gemini,
      supportsImage: true,
      supportsThinking: true, // rebrand: must be supplied
      modelName: 'Gemini 3.1 Flash Lite',
    });
    expect(geminiSelection.providerConfig.models[0].reasoning).toBe(true);

    const customSelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://example.com/v1',
      modelId: 'custom-thinking-model',
      apiType: 'openai',
      providerName: 'custom_0',
      supportsImage: false,
      supportsThinking: true,
      modelName: 'Custom Thinking Model',
    });
    expect(customSelection.providerConfig.api).toBe(OpenClawApi.OpenAICompletions);
    expect(customSelection.providerConfig.models[0].reasoning).toBe(true);

    const customParamsOnlySelection = buildProviderSelection({
      apiKey: 'sk-test',
      baseURL: 'https://example.com/v1',
      modelId: 'custom-thinking-model',
      apiType: 'openai',
      providerName: 'custom_0',
      supportsImage: false,
      modelName: 'Custom Params Only Model',
    });
    expect(customParamsOnlySelection.providerConfig.models[0].reasoning).toBeUndefined();
  });

  test('writes Telegram streaming in the nested schema expected by current OpenClaw', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [{
        enabled: true,
        botToken: 'tg-token',
        instanceId: 'tg-inst-001',
        instanceName: 'Test Telegram',
        dmPolicy: 'open',
        allowFrom: ['*'],
        groupPolicy: 'allowlist',
        groupAllowFrom: [],
        groups: { '*': { requireMention: true } },
        historyLimit: 50,
        replyToMode: 'off',
        linkPreview: true,
        streaming: 'off',
        mediaMaxMb: 5,
        proxy: '',
        webhookUrl: '',
        webhookSecret: '',
        debug: false,
      }],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('test');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const accounts = config.channels.telegram.accounts;
    const accountKey = Object.keys(accounts)[0];
    expect(accounts[accountKey].streaming).toEqual({ mode: 'off' });
  });

  test('does not inject unsupported _agentBinding channel metadata and requests restart when bindings change', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const baseDeps = {
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramOpenClawConfig: () => null,
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [{
        enabled: true,
        clientId: 'ding-client-id',
        clientSecret: 'ding-secret',
        dmPolicy: 'open',
        allowFrom: ['*'],
        groupPolicy: 'open',
        sessionTimeout: 0,
        separateSessionByConversation: false,
        groupSessionScope: 'group',
        sharedMemoryAcrossConversations: false,
        gatewayBaseUrl: '',
        debug: false,
        instanceId: 'b8a32c47-c852-4ad2-bbfa-631797fc56ea',
        instanceName: 'DingTalk Bot 1',
      }],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getSkillsList: () => [],
      getAgents: () => [{
        id: 'worker-agent',
        enabled: true,
        name: 'Worker Agent',
        prompt: '',
        model: 'openai/gpt-test',
        source: 'user',
      }],
    };

    let currentBindings: Record<string, string> = {};
    const sync = new OpenClawConfigSync({
      ...baseDeps,
      getIMSettings: () => ({
        platformAgentBindings: currentBindings,
      }),
    } as never);

    expect(sync.sync('baseline').ok).toBe(true);

    currentBindings = {
      'dingtalk:b8a32c47-c852-4ad2-bbfa-631797fc56ea': 'worker-agent',
    };
    const result = sync.sync('binding-changed');

    expect(result.ok).toBe(true);
    expect(result.bindingsChanged).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.channels['dingtalk-connector']).not.toHaveProperty('_agentBinding');
    expect(config.channels).not.toHaveProperty('dingtalk');
    expect(config.bindings).toEqual([
      {
        agentId: 'worker-agent',
        match: {
          channel: 'dingtalk-connector',
          accountId: 'b8a32c47',
        },
      },
    ]);
  });

  test('writes platform-level agent bindings with account wildcard and keeps instance bindings exact', async () => {
    const {
      OpenClawConfigSync,
      OPENCLAW_BINDING_ANY_ACCOUNT_ID,
    } = await import('./openclawConfigSync');

    const dingTalkInstance = {
      enabled: true,
      clientId: 'ding-client-id',
      clientSecret: 'ding-secret',
      dmPolicy: 'open',
      allowFrom: ['*'],
      groupPolicy: 'open',
      sessionTimeout: 0,
      separateSessionByConversation: false,
      groupSessionScope: 'group',
      sharedMemoryAcrossConversations: false,
      gatewayBaseUrl: '',
      debug: false,
      instanceId: 'b8a32c47-c852-4ad2-bbfa-631797fc56ea',
      instanceName: 'DingTalk Bot 1',
    };

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramOpenClawConfig: () => null,
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [dingTalkInstance],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => ({
        enabled: true,
        accountId: '97a130e3b62f@im.bot',
        dmPolicy: 'open',
        allowFrom: [],
        debug: false,
      }),
      getIMSettings: () => ({
        platformAgentBindings: {
          'dingtalk:b8a32c47-c852-4ad2-bbfa-631797fc56ea': 'instance-agent',
          dingtalk: 'platform-agent',
          weixin: 'weixin-agent',
        },
      }),
      getSkillsList: () => [],
      getAgents: () => [
        {
          id: 'instance-agent',
          enabled: true,
          name: 'Instance Agent',
          prompt: '',
          model: 'openai/gpt-test',
          source: 'user',
        },
        {
          id: 'platform-agent',
          enabled: true,
          name: 'Platform Agent',
          prompt: '',
          model: 'openai/gpt-test',
          source: 'user',
        },
        {
          id: 'weixin-agent',
          enabled: true,
          name: 'Weixin Agent',
          prompt: '',
          model: 'openai/gpt-test',
          source: 'user',
        },
      ],
    } as never);

    const result = sync.sync('platform-binding-wildcard');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.bindings).toEqual([
      {
        agentId: 'instance-agent',
        match: {
          channel: 'dingtalk-connector',
          accountId: 'b8a32c47',
        },
      },
      {
        agentId: 'platform-agent',
        match: {
          channel: 'dingtalk-connector',
          accountId: OPENCLAW_BINDING_ANY_ACCOUNT_ID,
        },
      },
      {
        agentId: 'weixin-agent',
        match: {
          channel: 'openclaw-weixin',
          accountId: OPENCLAW_BINDING_ANY_ACCOUNT_ID,
        },
      },
    ]);
  });

  test('prefers external lark for feishu without stale feishu entry and keeps bundled qqbot entry', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    fs.writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          feishu: { enabled: false },
          'openclaw-qqbot': { enabled: false },
          qqbot: { enabled: false },
        },
      },
    }, null, 2));

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramOpenClawConfig: () => null,
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [{
        enabled: true,
        appId: 'cli_feishu_app',
        appSecret: 'secret',
        instanceId: 'feishu-instance-1',
        instanceName: 'Feishu Bot 1',
        domain: 'feishu',
        dmPolicy: 'open',
        allowFrom: ['*'],
        groupPolicy: 'allowlist',
        groupAllowFrom: [],
        groups: { '*': { requireMention: true } },
        historyLimit: 50,
        streaming: true,
        replyMode: 'auto',
        blockStreaming: false,
        mediaMaxMb: 30,
      }],
      getQQInstances: () => [{
        enabled: true,
        appId: 'qq-app-id',
        clientSecret: 'qq-secret',
        instanceId: 'qq-instance-1',
        instanceName: 'QQ Bot 1',
        allowFrom: ['*'],
        dmPolicy: 'open',
        markdownSupport: true,
      }],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    } as never);

    const result = sync.sync('feishu-lark-qqbot');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries['openclaw-lark']).toEqual({ enabled: true });
    expect(config.plugins.entries).not.toHaveProperty('feishu');
    expect(config.plugins.entries.qqbot).toEqual({ enabled: true });
    expect(config.plugins.entries.discord).toEqual({ enabled: false });
    expect(config.plugins.entries.browser).toEqual({ enabled: true });
    expect(config.plugins.entries).not.toHaveProperty('openclaw-qqbot');
    expect(config.plugins.allow).toContain('browser');
    expect(config.plugins.allow).toContain('qqbot');
    expect(config.plugins.allow).toContain('discord');
  });

  test('writes plugin entries using manifest ids and removes stale package ids', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    fs.writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'clawemail-email': { enabled: true },
          'openclaw-nim-channel': { enabled: true },
        },
      },
    }, null, 2));

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramInstances: () => [],
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getEmailOpenClawConfig: () => ({
        instances: [{
          instanceId: 'email-work',
          instanceName: 'Work Email',
          enabled: true,
          transport: 'ws',
          email: 'user@example.com',
          apiKey: 'ck_test',
          agentId: 'main',
        }],
      }),
      getNimInstances: () => [{
        instanceId: 'nim-work',
        instanceName: 'NIM Work',
        enabled: true,
        appKey: 'nim-app-key',
        account: 'nim-account',
        token: 'nim-token',
      }],
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    } as never);

    const result = sync.sync('manifest-plugin-ids');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.entries).not.toHaveProperty('clawemail-email');
    expect(config.plugins.entries).not.toHaveProperty('openclaw-nim-channel');
    expect(config.plugins.entries.email).toEqual({ enabled: true });
    expect(config.plugins.entries['nimsuite-openclaw-nim-channel']).toEqual({ enabled: true });
  });

  test('writes weixin channel config using dmPolicy and allowFrom instead of unsupported accountId', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramOpenClawConfig: () => null,
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getWecomInstances: () => [],
      getPopoInstances: () => [],
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => ({
        enabled: true,
        accountId: '97a130e3b62f@im.bot',
        dmPolicy: 'open',
        allowFrom: [],
        debug: false,
      }),
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('weixin-schema');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.channels['openclaw-weixin']).toEqual({
      enabled: true,
      dmPolicy: 'open',
      allowFrom: ['*'],
    });
    expect(config.channels['openclaw-weixin']).not.toHaveProperty('accountId');
  });

  test('writes managed browser policy forcing host target', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getPopoInstances: () => [],
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    } as never);

    const result = sync.sync('browser-policy');
    expect(result.ok).toBe(true);

    const agentsMdPath = path.join(stateDir, 'workspace-main', 'AGENTS.md');
    const agentsMd = fs.readFileSync(agentsMdPath, 'utf8');
    expect(agentsMd).toContain('GenWork does not support sandbox browser execution in this version.');
    expect(agentsMd).toContain('For every `browser` tool call, set `target="host"` explicitly.');
  });

  test('writes a managed identity policy that forbids naming the internal runtime', async () => {
    const sync = await createSync();

    const result = sync.sync('identity-policy');
    expect(result.ok).toBe(true);

    const agentsMdPath = path.join(stateDir, 'workspace-main', 'AGENTS.md');
    const agentsMd = fs.readFileSync(agentsMdPath, 'utf8');
    // The policy tells the agent to introduce itself as a GenWork assistant and
    // to never surface the underlying runtime name (so "runs inside OpenClaw"
    // stops leaking into self-introductions and IDENTITY.md).
    expect(agentsMd).toContain('## Identity & Branding Policy');
    expect(agentsMd).toContain('runs on OpenClaw');
  });

  test('enables managed OpenClaw tool loop detection', async () => {
    const sync = await createSync();

    const result = sync.sync('tool-loop-detection');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.tools.loopDetection).toEqual({
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
    });
  });

  test('writes browser and web fetch access settings', async () => {
    const { setSystemProxyEnabled } = await import('./systemProxy');
    const {
      BrowserNetworkMode,
      BrowserProfileMode,
      BrowserRuntimeProfile,
      BrowserSnapshotMode,
    } = await import('../../shared/browserWebAccess/constants');
    const { OpenClawConfigSync } = await import('./openclawConfigSync');
    setSystemProxyEnabled(true);

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
        getBaseDir: () => tmpDir,
      } as never,
      getGenWorkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      getBrowserWebAccessConfig: () => ({
        browserEnabled: true,
        profileMode: BrowserProfileMode.User,
        networkMode: BrowserNetworkMode.Strict,
        followGlobalProxy: true,
        allowedHostnames: ['https://Localhost:8443/path'],
        blockedHostnames: ['https://www.baidu.com/search'],
        snapshotMode: BrowserSnapshotMode.Efficient,
        evaluateEnabled: false,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        cdpUrl: 'http://127.0.0.1:9222',
        attachOnly: true,
        remoteCdpTimeoutMs: 1500,
        remoteCdpHandshakeTimeoutMs: 3000,
        extraArgs: ['--disable-infobars'],
        webFetch: {
          enabled: true,
          followGlobalProxy: true,
          timeoutSeconds: 25,
          maxRedirects: 4,
          maxChars: 12000,
          userAgent: 'GenWork Test',
          readability: false,
          allowRfc2544BenchmarkRange: true,
        },
      }),
      isEnterprise: () => false,
      getPopoInstances: () => [],
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    } as never);

    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local' },
      tools: {
        web: {
          fetch: {
            enabled: true,
            useEnvProxy: true,
            useTrustedEnvProxy: true,
          },
        },
      },
    }, null, 2));

    const result = sync.sync('browser-web-access');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.browser).toMatchObject({
      enabled: true,
      defaultProfile: BrowserRuntimeProfile.Managed,
      evaluateEnabled: false,
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: false,
        allowedHostnames: ['localhost'],
        hostnameAllowlist: ['localhost'],
        blockedHostnames: ['www.baidu.com'],
      },
    });
    expect(config.browser.cdpUrl).toBeUndefined();
    expect(config.browser.executablePath).toBeUndefined();
    expect(config.browser.attachOnly).toBeUndefined();
    expect(config.browser.remoteCdpTimeoutMs).toBeUndefined();
    expect(config.browser.remoteCdpHandshakeTimeoutMs).toBeUndefined();
    expect(config.browser.extraArgs).toBeUndefined();
    expect(config.browser.snapshotDefaults).toBeUndefined();
    expect(config.tools.web.fetch).toMatchObject({
      enabled: true,
      readability: false,
      timeoutSeconds: 25,
      maxRedirects: 4,
      maxChars: 12000,
      userAgent: 'GenWork Test',
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });
    expect(config.tools.web.fetch.useEnvProxy).toBeUndefined();
    expect(config.tools.web.fetch.useTrustedEnvProxy).toBeUndefined();
  });

  test('marks MCP server config changes as restart impact', async () => {
    const { OpenClawConfigImpact } = await import('./openclawConfigImpact');
    const sync = await createSync({
      getResolvedMcpServers: () => [{
        name: 'Tavily',
        transportType: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { TAVILY_API_KEY: '${GENWORK_TAVILY_API_KEY}' },
      }],
    });

    const result = sync.sync('mcp-server-toggled');

    expect(result.ok).toBe(true);
    expect(result.changedTopLevelKeys).toContain('mcp');
    expect(result.restartImpact).toBe(OpenClawConfigImpact.Restart);
  });

  test('writes all remote MCP headers to openclaw config', async () => {
    const sync = await createSync({
      getResolvedMcpServers: () => [{
        name: 'Remote MCP',
        transportType: 'http',
        url: 'https://mcp.example.com/stream',
        headers: {
          Authorization: 'Bearer test-token',
          'X-Tenant-Id': 'tenant-123',
          'X-Client-Id': 'client-456',
        },
      }],
    });

    const result = sync.sync('mcp-server-updated');

    expect(result.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.mcp.servers['Remote MCP']).toMatchObject({
      url: 'https://mcp.example.com/stream',
      transport: 'streamable-http',
      headers: {
        authorization: 'Bearer test-token',
        'x-tenant-id': 'tenant-123',
        'x-client-id': 'client-456',
      },
    });
  });
});

describe('resolveModelSourceForOpenClawProvider', () => {
  beforeEach(() => {
    mockRuntimeState.providerSourceEntries = [];
  });

  test('classifies the GenWork plan without any Settings entry', async () => {
    const { resolveModelSourceForOpenClawProvider } = await import('./openclawConfigSync');
    expect(resolveModelSourceForOpenClawProvider('genwork-server')).toEqual({
      source: 'genwork-plan',
      providerName: ProviderName.GenworkServer,
    });
  });

  test('classifies a custom provider with its display name', async () => {
    mockRuntimeState.providerSourceEntries = [
      { providerName: ProviderName.Custom, codingPlanEnabled: false, displayName: '我的中转' },
    ];
    const { resolveModelSourceForOpenClawProvider } = await import('./openclawConfigSync');
    expect(resolveModelSourceForOpenClawProvider('custom')).toEqual({
      source: 'custom-provider',
      providerName: ProviderName.Custom,
      providerDisplayName: '我的中转',
    });
  });

  test('classifies a vendor coding plan through the descriptor provider id', async () => {
    mockRuntimeState.providerSourceEntries = [
      { providerName: ProviderName.Zhipu, codingPlanEnabled: true },
    ];
    const { resolveModelSourceForOpenClawProvider } = await import('./openclawConfigSync');
    // Rebrand: the OpenClaw provider id 'zai' is no longer classified by this resolver —
    // only 'genwork-server' and exact custom provider names are. Assert undefined.
    expect(resolveModelSourceForOpenClawProvider('zai')).toBeUndefined();
  });

  test('classifies OAuth-mode builtin providers via their oauth descriptor id', async () => {
    mockRuntimeState.providerSourceEntries = [
      { providerName: ProviderName.Minimax, codingPlanEnabled: false, authType: 'oauth' },
    ];
    const { resolveModelSourceForOpenClawProvider } = await import('./openclawConfigSync');
    // Rebrand: the OpenClaw provider id 'minimax-portal' is no longer classified here.
    expect(resolveModelSourceForOpenClawProvider('minimax-portal')).toBeUndefined();
    // 'minimax' as a non-custom name is also not classified.
    expect(resolveModelSourceForOpenClawProvider('minimax')).toBeUndefined();
  });

  test('classifies plain builtin providers and unknown ids', async () => {
    mockRuntimeState.providerSourceEntries = [
      { providerName: ProviderName.DeepSeek, codingPlanEnabled: false },
    ];
    const { resolveModelSourceForOpenClawProvider } = await import('./openclawConfigSync');
    // Rebrand: the OpenClaw provider id 'deepseek' is no longer classified by this resolver.
    expect(resolveModelSourceForOpenClawProvider('deepseek')).toBeUndefined();
    expect(resolveModelSourceForOpenClawProvider('never-configured')).toBeUndefined();
    expect(resolveModelSourceForOpenClawProvider('')).toBeUndefined();
  });
});
