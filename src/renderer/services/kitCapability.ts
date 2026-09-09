import {
  buildKitReferenceUri,
  type KitReference,
  KitReferenceKind,
  KitReferenceSource,
  type ResolvedKitCapabilities,
} from '../../shared/kit/constants';
import type { InstalledKit, MarketplaceKit } from '../types/kit';
import { resolveLocalizedText } from './skill';

const normalizeCapabilityList = (value: unknown): unknown[] => (
  Array.isArray(value) ? value : []
);

const pushUniqueStrings = (target: string[], seen: Set<string>, values: string[]): void => {
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    target.push(value);
  }
};

export const getInstalledKitSkillIds = (kit: InstalledKit | undefined): string[] =>
  kit?.skills?.skillIds ?? [];

export const resolveSelectedKitCapabilities = (
  kitIds: string[],
  installedKits: Record<string, InstalledKit>,
): ResolvedKitCapabilities => {
  const skillIds: string[] = [];
  const seenSkillIds = new Set<string>();
  const mcpServers: unknown[] = [];
  const connectors: unknown[] = [];

  for (const kitId of kitIds) {
    const kit = installedKits[kitId];
    if (!kit) continue;

    pushUniqueStrings(skillIds, seenSkillIds, getInstalledKitSkillIds(kit));
    mcpServers.push(...normalizeCapabilityList(kit.mcpServers));
    connectors.push(...normalizeCapabilityList(kit.connectors));
  }

  return {
    skillIds,
    mcpServers,
    connectors,
  };
};

export const buildKitReferences = (
  kitIds: string[],
  marketplaceKits: MarketplaceKit[],
): KitReference[] => {
  return kitIds.map((kitId) => {
    const kit = marketplaceKits.find(item => item.id === kitId);
    const name = kit?.name ? resolveLocalizedText(kit.name) : undefined;
    return {
      kind: KitReferenceKind.Kit,
      id: kitId,
      ...(name ? { name } : {}),
      uri: buildKitReferenceUri(kitId),
      source: KitReferenceSource.GenworkKits,
    };
  });
};
