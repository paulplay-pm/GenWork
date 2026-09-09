import { describe, expect, test } from 'vitest';

import { i18nService } from '../services/i18n';
import { mcpCategories, mcpRegistry } from './mcpRegistry';

/** The 11 connectors migrated from the LobsterAI built-in market list. */
const MIGRATED_IDS = [
  'tavily',
  'mcp-gitlab',
  'context7',
  'google-drive',
  'gmail',
  'google-calendar',
  'slack',
  'todoist',
  'playwright',
  'canva',
  'firecrawl',
] as const;

/** The 3 connectors GenWork already ships, which must NOT be duplicated. */
const ALREADY_PRESENT_IDS = ['qichacha', 'github', 'notion'] as const;

const registryIds = (): string[] => mcpRegistry.map((entry) => entry.id);

describe('mcpRegistry built-in catalog', () => {
  test('contains exactly one entry for every registry id', () => {
    const ids = registryIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.each(MIGRATED_IDS)('migrated connector "%s" is present', (id) => {
    expect(registryIds()).toContain(id);
  });

  test.each(ALREADY_PRESENT_IDS)('existing connector "%s" is present and not duplicated', (id) => {
    expect(mcpRegistry.filter((entry) => entry.id === id).length).toBe(1);
  });

  test('every entry uses a declared category', () => {
    const categoryIds = new Set(mcpCategories.map((category) => category.id));
    for (const entry of mcpRegistry) {
      expect(categoryIds.has(entry.category)).toBe(true);
    }
  });

  test('every entry has a non-empty localized description in both languages', () => {
    for (const entry of mcpRegistry) {
      i18nService.setLanguage('zh', { persist: false });
      expect(i18nService.t(entry.descriptionKey).trim()).not.toBe('');
      i18nService.setLanguage('en', { persist: false });
      expect(i18nService.t(entry.descriptionKey).trim()).not.toBe('');
    }
  });
});
