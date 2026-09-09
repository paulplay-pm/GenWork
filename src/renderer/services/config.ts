import { normalizeBrowserWebAccessConfig } from '../../shared/browserWebAccess/constants';
import { normalizeNotificationSettings } from '../../shared/notifications/constants';
import {
  AppConfig,
  CODE_FONT_SIZE_MIGRATION_VERSION,
  CONFIG_KEYS,
  defaultConfig,
  FontPreferences,
  normalizeFontPreference,
  resolveArtifactAutoPreviewEnabled,
  ShortcutAction,
  type ShortcutConfig,
  UI_FONT_SIZE_MIGRATION_VERSION,
} from '../config';
import { localStore } from './store';

export const ConfigServiceEvent = {
  Updated: 'config-updated',
} as const;

export type ConfigServiceEvent = typeof ConfigServiceEvent[keyof typeof ConfigServiceEvent];

const legacyShortcutDefaults: Partial<Record<ShortcutAction, string[]>> = {
  [ShortcutAction.NewChat]: ['Ctrl+N'],
  [ShortcutAction.Search]: ['Ctrl+F'],
  [ShortcutAction.Settings]: ['Ctrl+,'],
  [ShortcutAction.ShowShortcuts]: ['Ctrl+/'],
  [ShortcutAction.FocusPrompt]: ['Ctrl+K'],
  [ShortcutAction.StopCurrentTask]: ['Ctrl+.'],
  [ShortcutAction.ToggleSidebar]: ['Ctrl+B'],
  [ShortcutAction.ToggleArtifacts]: ['Ctrl+Shift+B'],
  [ShortcutAction.PreviousAgent]: ['Ctrl+Alt+Left', 'CommandOrControl+Shift+['],
  [ShortcutAction.NextAgent]: ['Ctrl+Alt+Right', 'CommandOrControl+Shift+]'],
  [ShortcutAction.ShowCurrentAgentTasks]: ['Ctrl+Alt+H', 'CommandOrControl+Shift+H'],
  [ShortcutAction.OpenAgentTask1]: ['Ctrl+Alt+1', 'CommandOrControl+Shift+1'],
  [ShortcutAction.OpenAgentTask2]: ['Ctrl+Alt+2', 'CommandOrControl+Shift+2'],
  [ShortcutAction.OpenAgentTask3]: ['Ctrl+Alt+3', 'CommandOrControl+Shift+3'],
  [ShortcutAction.OpenAgentTask4]: ['Ctrl+Alt+4', 'CommandOrControl+Shift+4'],
  [ShortcutAction.OpenAgentTask5]: ['Ctrl+Alt+5', 'CommandOrControl+Shift+5'],
  [ShortcutAction.OpenAgentTask6]: ['Ctrl+Alt+6', 'CommandOrControl+Shift+6'],
  [ShortcutAction.OpenAgentTask7]: ['Ctrl+Alt+7', 'CommandOrControl+Shift+7'],
  [ShortcutAction.OpenAgentTask8]: ['Ctrl+Alt+8', 'CommandOrControl+Shift+8'],
  [ShortcutAction.OpenAgentTask9]: ['Ctrl+Alt+9', 'CommandOrControl+Shift+9'],
  [ShortcutAction.OpenCowork]: ['Ctrl+1'],
  [ShortcutAction.OpenScheduledTasks]: ['Ctrl+2'],
  [ShortcutAction.OpenKits]: ['Ctrl+3'],
  [ShortcutAction.OpenSkills]: ['Ctrl+4'],
  [ShortcutAction.OpenMcp]: ['Ctrl+5'],
};

const normalizeShortcutsConfig = (storedShortcuts?: AppConfig['shortcuts']): ShortcutConfig => {
  const shortcuts = {
    ...defaultConfig.shortcuts!,
    ...(storedShortcuts ?? {}),
  } as ShortcutConfig;

  if (!storedShortcuts) {
    return shortcuts;
  }

  Object.values(ShortcutAction).forEach((action) => {
    if (legacyShortcutDefaults[action]?.includes(storedShortcuts[action] ?? '')) {
      shortcuts[action] = defaultConfig.shortcuts![action];
    }
  });

  return shortcuts;
};

const omitLegacyConfigFields = (config: AppConfig): AppConfig => {
  const {
    voiceInput: _legacyVoiceInput,
    providers: _legacyProviders,
    ...nextConfig
  } = config as AppConfig & {
    voiceInput?: unknown;
    providers?: unknown;
  };
  return nextConfig;
};

const hydrateStoredConfig = (storedConfig: AppConfig): AppConfig => {
  const storedWithoutLegacy = omitLegacyConfigFields(storedConfig);
  // Drop any legacy `providers` map left over from a pre-enterprise build.
  // The enterprise catalog is now the only source of truth for model config;
  // we log once if a stale entry is detected, then silently ignore it.
  if (storedConfig.providers !== undefined) {
    console.warn('[ConfigService] dropping legacy providers field from stored config');
  }
  const providerModelMigrationVersions = {
    ...(storedConfig.providerModelMigrationVersions ?? {}),
  };

  return {
    ...defaultConfig,
    ...storedWithoutLegacy,
    api: {
      ...defaultConfig.api,
      ...storedConfig.api,
    },
    model: {
      ...defaultConfig.model,
      ...storedConfig.model,
    },
    app: {
      ...defaultConfig.app,
      ...storedConfig.app,
    },
    shortcuts: normalizeShortcutsConfig(storedConfig.shortcuts),
    providerModelMigrationVersions,
    // One-time forced resets to the current defaults (see
    // *_FONT_SIZE_MIGRATION_VERSION); afterwards the stored choice wins.
    uiFontSize: (storedConfig.uiFontSizeMigrationVersion ?? 0) >= UI_FONT_SIZE_MIGRATION_VERSION
      ? normalizeFontPreference(
        storedConfig.uiFontSize,
        FontPreferences.UiFontSizeDefault,
        FontPreferences.UiFontSizeMin,
        FontPreferences.UiFontSizeMax,
      )
      : FontPreferences.UiFontSizeDefault,
    uiFontSizeMigrationVersion: Math.max(
      storedConfig.uiFontSizeMigrationVersion ?? 0,
      UI_FONT_SIZE_MIGRATION_VERSION,
    ),
    codeFontSize: (storedConfig.codeFontSizeMigrationVersion ?? 0) >= CODE_FONT_SIZE_MIGRATION_VERSION
      ? normalizeFontPreference(
        storedConfig.codeFontSize,
        FontPreferences.CodeFontSizeDefault,
        FontPreferences.CodeFontSizeMin,
        FontPreferences.CodeFontSizeMax,
      )
      : FontPreferences.CodeFontSizeDefault,
    codeFontSizeMigrationVersion: Math.max(
      storedConfig.codeFontSizeMigrationVersion ?? 0,
      CODE_FONT_SIZE_MIGRATION_VERSION,
    ),
    artifactAutoPreviewEnabled: resolveArtifactAutoPreviewEnabled(
      storedConfig.artifactAutoPreviewEnabled,
    ),
    browserWebAccess: normalizeBrowserWebAccessConfig(storedConfig.browserWebAccess),
    notificationSettings: normalizeNotificationSettings(storedConfig.notificationSettings),
  };
};

class ConfigService {
  private config: AppConfig = defaultConfig;
  private initGeneration = 0;

  async init() {
    const initGeneration = ++this.initGeneration;
    try {
      const storedConfig = await localStore.getItemStrict<AppConfig>(CONFIG_KEYS.APP_CONFIG);
      if (initGeneration !== this.initGeneration) return;
      if (!storedConfig) {
        console.warn('[ConfigService] init: no stored config found, using defaults');
      }
      if (storedConfig) {
        const hydratedConfig = hydrateStoredConfig(storedConfig);
        if (initGeneration !== this.initGeneration) return;
        this.config = hydratedConfig;
        if (JSON.stringify(hydratedConfig) !== JSON.stringify(storedConfig)) {
          try {
            await localStore.setItem(CONFIG_KEYS.APP_CONFIG, hydratedConfig);
            if (initGeneration !== this.initGeneration) return;
          } catch (persistError) {
            console.warn('[ConfigService] init: failed to persist migrated config:', persistError);
          }
        }
      }
    } catch (error) {
      console.error('[ConfigService] init failed:', error);
      throw error;
    }
  }

  getConfig(): AppConfig {
    return this.config;
  }

  async updateConfig(newConfig: Partial<AppConfig>) {
    // An explicit user/service write must win over any startup read that is
    // still in flight after App's timeout-based recovery moved on.
    this.initGeneration += 1;

    // Read-modify-write: use the latest stored value as the base to avoid
    // overwriting fields with stale in-memory defaults when only a subset of
    // config is being updated. Never turn a transient IPC/storage failure
    // into a full write based on in-memory defaults: that could overwrite
    // an existing user's config.
    const stored = await localStore.getItemStrict<AppConfig>(CONFIG_KEYS.APP_CONFIG);
    const base = stored ? hydrateStoredConfig(stored) : this.config;

    this.config = omitLegacyConfigFields({
      ...base,
      ...newConfig,
      uiFontSize: normalizeFontPreference(
        newConfig.uiFontSize ?? base.uiFontSize,
        FontPreferences.UiFontSizeDefault,
        FontPreferences.UiFontSizeMin,
        FontPreferences.UiFontSizeMax,
      ),
      codeFontSize: normalizeFontPreference(
        newConfig.codeFontSize ?? base.codeFontSize,
        FontPreferences.CodeFontSizeDefault,
        FontPreferences.CodeFontSizeMin,
        FontPreferences.CodeFontSizeMax,
      ),
      browserWebAccess: normalizeBrowserWebAccessConfig(
        newConfig.browserWebAccess ?? base.browserWebAccess,
      ),
      notificationSettings: normalizeNotificationSettings(
        newConfig.notificationSettings ?? base.notificationSettings,
      ),
    } as AppConfig);
    await localStore.setItem(CONFIG_KEYS.APP_CONFIG, this.config);
    window.dispatchEvent(new CustomEvent(ConfigServiceEvent.Updated));
  }

  getApiConfig() {
    return {
      apiKey: this.config.api.key,
      baseUrl: this.config.api.baseUrl,
    };
  }
}

export const configService = new ConfigService();