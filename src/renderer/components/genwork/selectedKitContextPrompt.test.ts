import { describe, expect, test } from 'vitest';

import type { InstalledKit, MarketplaceKit } from '../../types/kit';
import { buildSelectedKitContextPrompt } from './selectedKitContextPrompt';

describe('buildSelectedKitContextPrompt', () => {
  test('returns undefined when no kit is selected', () => {
    expect(buildSelectedKitContextPrompt([], [], {})).toBeUndefined();
  });

  test('builds a concise kit capability index without tryAsking', () => {
    const marketplaceKits: MarketplaceKit[] = [
      {
        id: 'design',
        name: 'Design',
        description: 'Design critique, UX writing, accessibility, research synthesis, and handoff.',
        tryAsking: ['Audit my design system'],
        skills: {
          bundle: 'https://example.com/design.zip',
          list: [
            { id: 'design-critique', name: '/design-critique' },
            { id: 'ux-copy', name: '/ux-copy' },
          ],
        },
        mcpServers: [{ id: 'figma', name: 'Figma', description: 'Inspect design files.' }],
        connectors: [{ id: 'github', name: 'GitHub' }],
      },
    ];
    const installedKits: Record<string, InstalledKit> = {
      design: {
        id: 'design',
        version: '1.0.0',
        installedAt: 1,
        skills: { skillIds: ['design-critique', 'ux-copy'] },
        mcpServers: [{ id: 'figma', name: 'Figma', description: 'Inspect design files.' }],
        connectors: [{ id: 'github', name: 'GitHub' }],
      },
    };

    const prompt = buildSelectedKitContextPrompt(['design'], marketplaceKits, installedKits);

    expect(prompt).toContain('<id>design</id>');
    expect(prompt).toContain('<name>Design</name>');
    expect(prompt).toContain('<skill id="design-critique" name="/design-critique" />');
    expect(prompt).toContain('<mcpServer id="figma" name="Figma" description="Inspect design files." />');
    expect(prompt).toContain('<connector id="github" name="GitHub" />');
    expect(prompt).not.toContain('Audit my design system');
    expect(prompt).not.toContain('SKILL.md');
  });

  test('falls back to installed skill ids when marketplace skill list is missing', () => {
    const installedKits: Record<string, InstalledKit> = {
      local: {
        id: 'local',
        version: '1.0.0',
        installedAt: 1,
        skills: { skillIds: ['local-skill'] },
        mcpServers: [],
        connectors: [],
      },
    };

    const prompt = buildSelectedKitContextPrompt(['local'], [], installedKits);

    expect(prompt).toContain('<skill id="local-skill" name="local-skill" />');
  });
});
