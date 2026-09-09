import { afterEach, describe, expect, test, vi } from 'vitest';

import { type AppConfig, CODE_FONT_SIZE_MIGRATION_VERSION, CONFIG_KEYS, defaultConfig, FontPreferences, resolveArtifactAutoPreviewEnabled, ShortcutAction, UI_FONT_SIZE_MIGRATION_VERSION } from '../config';

async function loadConfigServiceWithStoredConfig(storedConfig: AppConfig) {
  vi.resetModules();
  const storeData: Record<string, unknown> = {
    [CONFIG_KEYS.APP_CONFIG]: storedConfig,
  };
  const getItem = vi.fn(async (key: string) => storeData[key] ?? null);
  const setItem = vi.fn(async (key: string, value: unknown) => {
    storeData[key] = value;
  });

  vi.doMock('./store', () => ({
    localStore: {
      getItem,
      getItemStrict: getItem,
      setItem,
      removeItem: vi.fn(),
    },
  }));

  (globalThis as unknown as { window?: unknown }).window = {
    dispatchEvent: vi.fn(),
    electron: {
      store: {
        get: getItem,
        set: setItem,
        remove: vi.fn(),
      },
    },
  };

  const { configService } = await import('./config');
  return { configService, storeData, setItem };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./store');
  delete (globalThis as { window?: unknown }).window;
});

describe('configService initialization failures', () => {
  test('rejects when the strict store read fails so startup can schedule repair', async () => {
    vi.resetModules();
    const storeError = new Error('store IPC unavailable');
    vi.doMock('./store', () => ({
      localStore: {
        getItem: vi.fn(),
        getItemStrict: vi.fn(async () => { throw storeError; }),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    }));
    (globalThis as unknown as { window?: unknown }).window = { dispatchEvent: vi.fn() };

    const { configService } = await import('./config');

    await expect(configService.init()).rejects.toBe(storeError);
  });

  test('ignores an older init response that resolves after a newer response', async () => {
    vi.resetModules();
    let resolveFirst: ((value: AppConfig) => void) | undefined;
    const firstRead = new Promise<AppConfig>((resolve) => { resolveFirst = resolve; });
    const newerConfig: AppConfig = { ...defaultConfig, language: 'en' };
    const olderConfig: AppConfig = { ...defaultConfig, language: 'zh' };
    const getItemStrict = vi.fn()
      .mockImplementationOnce(() => firstRead)
      .mockResolvedValueOnce(newerConfig);
    vi.doMock('./store', () => ({
      localStore: {
        getItem: getItemStrict,
        getItemStrict,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    }));
    (globalThis as unknown as { window?: unknown }).window = { dispatchEvent: vi.fn() };
    const { configService } = await import('./config');

    const firstInit = configService.init();
    await configService.init();
    resolveFirst?.(olderConfig);
    await firstInit;

    expect(configService.getConfig().language).toBe('en');
  });

  test('keeps an explicit update when an older init response arrives late', async () => {
    vi.resetModules();
    let resolveInit: ((value: AppConfig) => void) | undefined;
    const initRead = new Promise<AppConfig>((resolve) => { resolveInit = resolve; });
    const storedConfig: AppConfig = { ...defaultConfig, language: 'zh' };
    const getItemStrict = vi.fn()
      .mockImplementationOnce(() => initRead)
      .mockResolvedValueOnce(storedConfig);
    const getItem = vi.fn(async () => storedConfig);
    vi.doMock('./store', () => ({
      localStore: {
        getItem,
        getItemStrict,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    }));
    (globalThis as unknown as { window?: unknown }).window = { dispatchEvent: vi.fn() };
    const { configService } = await import('./config');

    const pendingInit = configService.init();
    await configService.updateConfig({ language: 'en' });
    resolveInit?.(storedConfig);
    await pendingInit;

    expect(configService.getConfig().language).toBe('en');
  });

  test('does not overwrite persisted config when the update pre-read fails', async () => {
    vi.resetModules();
    const readError = new Error('store IPC unavailable');
    const setItem = vi.fn();
    vi.doMock('./store', () => ({
      localStore: {
        getItem: vi.fn(),
        getItemStrict: vi.fn(async () => { throw readError; }),
        setItem,
        removeItem: vi.fn(),
      },
    }));
    (globalThis as unknown as { window?: unknown }).window = { dispatchEvent: vi.fn() };
    const { configService } = await import('./config');

    await expect(configService.updateConfig({ language: 'en' })).rejects.toBe(readError);

    expect(configService.getConfig()).toEqual(defaultConfig);
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('configService legacy providers drop', () => {
  test('drops a legacy providers map from stored config without re-emitting it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storedConfig = {
        ...defaultConfig,
        providers: {
          moonshot: {
            enabled: true,
            apiKey: 'sk-moonshot',
            models: [{ id: 'kimi-k2.6', name: 'Kimi K2.6' }],
          },
        },
      } as AppConfig;
      const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

      await configService.init();

      // The legacy field must be gone from both the in-memory config and the
      // value that gets re-persisted on the next write.
      const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as Record<string, unknown>;
      expect('providers' in savedConfig).toBe(false);
      expect('providers' in configService.getConfig()).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('configService theme persistence', () => {
  test('preserves an exact default theme id across partial updates', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      theme: 'dark',
      themeId: 'ocean',
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();
    await configService.updateConfig({ useSystemProxy: true });

    expect(configService.getConfig()).toMatchObject({
      theme: 'dark',
      themeId: 'ocean',
    });
    expect(storeData[CONFIG_KEYS.APP_CONFIG]).toMatchObject({
      theme: 'dark',
      themeId: 'ocean',
    });
  });
});

describe('configService artifact auto-preview persistence', () => {
  test('disables auto-preview only for an explicit false value', () => {
    expect(resolveArtifactAutoPreviewEnabled(false)).toBe(false);
    expect(resolveArtifactAutoPreviewEnabled(true)).toBe(true);
    expect(resolveArtifactAutoPreviewEnabled(undefined)).toBe(true);
    expect(resolveArtifactAutoPreviewEnabled(null)).toBe(true);
  });

  test('defaults legacy configs to auto-preview enabled', async () => {
    const legacyConfig: Partial<AppConfig> = { ...defaultConfig };
    delete legacyConfig.artifactAutoPreviewEnabled;
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(
      legacyConfig as AppConfig,
    );

    await configService.init();

    expect(configService.getConfig().artifactAutoPreviewEnabled).toBe(true);
    expect((storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig).artifactAutoPreviewEnabled).toBe(true);
  });

  test('preserves a disabled auto-preview preference across partial updates', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      artifactAutoPreviewEnabled: false,
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();
    await configService.updateConfig({ useSystemProxy: true });

    expect(configService.getConfig().artifactAutoPreviewEnabled).toBe(false);
    expect((storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig).artifactAutoPreviewEnabled).toBe(false);
  });
});

describe('configService shortcut migrations', () => {
  test('normalizes prior agent default shortcuts to unset', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      shortcuts: {
        ...defaultConfig.shortcuts!,
        [ShortcutAction.PreviousAgent]: 'CommandOrControl+Shift+[',
        [ShortcutAction.NextAgent]: 'CommandOrControl+Shift+]',
        [ShortcutAction.ShowCurrentAgentTasks]: 'CommandOrControl+Shift+H',
        [ShortcutAction.OpenAgentTask1]: 'CommandOrControl+Shift+1',
        [ShortcutAction.OpenAgentTask2]: 'CommandOrControl+Shift+2',
        [ShortcutAction.OpenAgentTask3]: 'CommandOrControl+Shift+3',
        [ShortcutAction.OpenAgentTask4]: 'CommandOrControl+Shift+4',
        [ShortcutAction.OpenAgentTask5]: 'CommandOrControl+Shift+5',
        [ShortcutAction.OpenAgentTask6]: 'CommandOrControl+Shift+6',
        [ShortcutAction.OpenAgentTask7]: 'CommandOrControl+Shift+7',
        [ShortcutAction.OpenAgentTask8]: 'CommandOrControl+Shift+8',
        [ShortcutAction.OpenAgentTask9]: 'CommandOrControl+Shift+9',
      },
    };
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(configService.getConfig().shortcuts?.[ShortcutAction.PreviousAgent]).toBe('');
    expect(configService.getConfig().shortcuts?.[ShortcutAction.NextAgent]).toBe('');
    expect(configService.getConfig().shortcuts?.[ShortcutAction.ShowCurrentAgentTasks]).toBe('');
    expect(configService.getConfig().shortcuts?.[ShortcutAction.OpenAgentTask1]).toBe('');
    expect(configService.getConfig().shortcuts?.[ShortcutAction.OpenAgentTask9]).toBe('');
    expect(savedConfig.shortcuts?.[ShortcutAction.PreviousAgent]).toBe('');
  });

  test('preserves customized agent shortcuts during normalization', async () => {
    const storedConfig: AppConfig = {
      ...defaultConfig,
      shortcuts: {
        ...defaultConfig.shortcuts!,
        [ShortcutAction.PreviousAgent]: 'CommandOrControl+Alt+Left',
      },
    };
    const { configService } = await loadConfigServiceWithStoredConfig(storedConfig);

    await configService.init();

    expect(configService.getConfig().shortcuts?.[ShortcutAction.PreviousAgent]).toBe('CommandOrControl+Alt+Left');
  });
});

describe('configService font size persistence', () => {
  test('hydrates font preferences with defaults for legacy configs', async () => {
    const legacyConfig: AppConfig = {
      ...defaultConfig,
      uiFontSize: undefined,
      codeFontSize: undefined,
    };
    const { configService } = await loadConfigServiceWithStoredConfig(legacyConfig);

    await configService.init();

    expect(configService.getConfig().uiFontSize).toBe(FontPreferences.UiFontSizeDefault);
    expect(configService.getConfig().codeFontSize).toBe(FontPreferences.CodeFontSizeDefault);
  });

  test('force-resets stored font sizes to the defaults exactly once', async () => {
    const preMigrationConfig = {
      ...defaultConfig,
      uiFontSize: 12,
      codeFontSize: 10,
    } as AppConfig;
    delete (preMigrationConfig as Partial<AppConfig>).uiFontSizeMigrationVersion;
    delete (preMigrationConfig as Partial<AppConfig>).codeFontSizeMigrationVersion;
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(preMigrationConfig);

    await configService.init();

    expect(configService.getConfig().uiFontSize).toBe(FontPreferences.UiFontSizeDefault);
    expect(configService.getConfig().codeFontSize).toBe(FontPreferences.CodeFontSizeDefault);
    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.uiFontSize).toBe(FontPreferences.UiFontSizeDefault);
    expect(savedConfig.uiFontSizeMigrationVersion).toBe(UI_FONT_SIZE_MIGRATION_VERSION);
    expect(savedConfig.codeFontSize).toBe(FontPreferences.CodeFontSizeDefault);
    expect(savedConfig.codeFontSizeMigrationVersion).toBe(CODE_FONT_SIZE_MIGRATION_VERSION);
  });

  test('keeps the stored font sizes once the forced reset has been applied', async () => {
    const migratedConfig: AppConfig = {
      ...defaultConfig,
      uiFontSize: 12,
      uiFontSizeMigrationVersion: UI_FONT_SIZE_MIGRATION_VERSION,
      codeFontSize: 10,
      codeFontSizeMigrationVersion: CODE_FONT_SIZE_MIGRATION_VERSION,
    };
    const { configService } = await loadConfigServiceWithStoredConfig(migratedConfig);

    await configService.init();

    expect(configService.getConfig().uiFontSize).toBe(12);
    expect(configService.getConfig().codeFontSize).toBe(10);
  });

  test('preserves user font size changes made after the forced reset', async () => {
    const preMigrationConfig = {
      ...defaultConfig,
      uiFontSize: 12,
      codeFontSize: 10,
    } as AppConfig;
    delete (preMigrationConfig as Partial<AppConfig>).uiFontSizeMigrationVersion;
    delete (preMigrationConfig as Partial<AppConfig>).codeFontSizeMigrationVersion;
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(preMigrationConfig);

    await configService.init();
    await configService.updateConfig({ uiFontSize: 13, codeFontSize: 16 });

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.uiFontSize).toBe(13);
    expect(savedConfig.uiFontSizeMigrationVersion).toBe(UI_FONT_SIZE_MIGRATION_VERSION);
    expect(savedConfig.codeFontSize).toBe(16);
    expect(savedConfig.codeFontSizeMigrationVersion).toBe(CODE_FONT_SIZE_MIGRATION_VERSION);

    const { configService: restartedService } = await loadConfigServiceWithStoredConfig(savedConfig);
    await restartedService.init();
    expect(restartedService.getConfig().uiFontSize).toBe(13);
    expect(restartedService.getConfig().codeFontSize).toBe(16);
  });

  test('clamps font preferences when saving config updates', async () => {
    const { configService, storeData } = await loadConfigServiceWithStoredConfig(defaultConfig);

    await configService.updateConfig({
      uiFontSize: 100,
      codeFontSize: 1,
    });

    const savedConfig = storeData[CONFIG_KEYS.APP_CONFIG] as AppConfig;
    expect(savedConfig.uiFontSize).toBe(FontPreferences.UiFontSizeMax);
    expect(savedConfig.codeFontSize).toBe(FontPreferences.CodeFontSizeMin);
  });
});

