import { expect, test } from 'vitest';

import {
  defaultConfig,
  getProviderDisplayName,
  ShortcutAction,
} from './config';

test('getProviderDisplayName is a passthrough in single-provider mode', () => {
  expect(getProviderDisplayName('genwork-server')).toBe('genwork-server');
  expect(getProviderDisplayName('openai')).toBe('openai');
});

test('defaultConfig uses the DeepSeek base URL', () => {
  expect(defaultConfig.api.baseUrl).toBe('https://api.deepseek.com');
});

test('defaultConfig enables usage analytics by default', () => {
  expect(defaultConfig.usageAnalyticsEnabled).toBe(true);
});

test('defaultConfig no longer carries the legacy providers map', () => {
  // Phase C: the enterprise catalog is the only source of truth for model
  // config. The Desktop no longer persists or exposes a per-provider map
  // through AppConfig.
  expect(defaultConfig.providers).toBeUndefined();
});

test('defaultConfig leaves agent shortcuts unset', () => {
  expect(defaultConfig.shortcuts?.[ShortcutAction.PreviousAgent]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.NextAgent]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.ShowCurrentAgentTasks]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask1]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask2]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask3]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask4]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask5]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask6]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask7]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask8]).toBe('');
  expect(defaultConfig.shortcuts?.[ShortcutAction.OpenAgentTask9]).toBe('');
});
