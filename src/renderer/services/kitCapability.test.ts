import { describe, expect, test } from 'vitest';

import {
  KitReferenceKind,
  KitReferenceSource,
} from '../../shared/kit/constants';
import type { InstalledKit, MarketplaceKit } from '../types/kit';
import {
  buildKitReferences,
  getInstalledKitSkillIds,
  resolveSelectedKitCapabilities,
} from './kitCapability';

describe('kit capability helpers', () => {
  test('reads installed kit skill ids from the nested skills record', () => {
    const kit: InstalledKit = {
      id: 'design',
      version: '1.0.0',
      installedAt: 1,
      skills: { skillIds: ['design-critique', 'ux-copy'] },
      mcpServers: [],
      connectors: [],
    };

    expect(getInstalledKitSkillIds(kit)).toEqual(['design-critique', 'ux-copy']);
  });

  test('resolves selected kit capabilities without duplicating shared skills', () => {
    const installedKits: Record<string, InstalledKit> = {
      design: {
        id: 'design',
        version: '1.0.0',
        installedAt: 1,
        skills: { skillIds: ['design-critique', 'shared'] },
        mcpServers: [{ id: 'figma' }],
        connectors: [{ id: 'figma-connector' }],
      },
      research: {
        id: 'research',
        version: '1.0.0',
        installedAt: 2,
        skills: { skillIds: ['shared', 'research-synthesis'] },
        mcpServers: [],
        connectors: [],
      },
    };

    expect(resolveSelectedKitCapabilities(['design', 'research'], installedKits)).toEqual({
      skillIds: ['design-critique', 'shared', 'research-synthesis'],
      mcpServers: [{ id: 'figma' }],
      connectors: [{ id: 'figma-connector' }],
    });
  });

  test('builds display references from marketplace kit metadata', () => {
    const marketplaceKits: MarketplaceKit[] = [
      {
        id: 'design',
        name: 'Design',
        description: 'Design kit',
      },
    ];

    expect(buildKitReferences(['design'], marketplaceKits)).toEqual([
      {
        kind: KitReferenceKind.Kit,
        id: 'design',
        name: 'Design',
        uri: 'kit://design@genwork-kits',
        source: KitReferenceSource.GenworkKits,
      },
    ]);
  });
});
