// Skill type definition
export interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;       // Whether visible in popover
  isOfficial: boolean;    // "官方" badge
  isBuiltIn: boolean;     // Bundled with app, cannot be deleted
  updatedAt: number;      // Timestamp
  prompt: string;         // SKILL.md body for management; do not inline into Cowork prompts
  skillPath: string;      // Absolute path to SKILL.md
  version?: string;       // Skill version from SKILL.md frontmatter
}

export type LocalizedText = { en: string; zh: string };

export interface MarketCategory {
  id: string;
  en: string;
  zh: string;
}

export interface LocalSkillInfo {
  id: string;
  name: string;
  description: string | LocalizedText;
  version: string;
  displayName?: string | LocalizedText; // Optional: server-provided localized name
  icon?: string;                        // Optional: server-provided icon URL
}

export interface MarketplaceSkill {
  id: string;
  name: string;
  name_zh: string | null;      // the wire shape carries the zh name
  description: string | LocalizedText;
  category: string;            // was tags?: string[]
  url: string;                 // Download URL (.zip)
  version: string;
  source: {
    from?: string;             // e.g. "Github"
    url?: string;              // Source repo URL
    author?: string;           // Author name
  } | null;
  // Optional fields the catalog may start sending. Until then the UI
  // falls back to a prettified name and a generated icon tile.
  displayName?: string | LocalizedText;
  icon?: string;
  // Resolved installed-local id (the SKILL.md folder basename), set by main
  // for skills installed via the enterprise catalog. `null`/absent when the
  // catalog skill is not installed (or was not installed via the catalog),
  // in which case identity falls back to catalog id-equality as before.
  localId?: string | null;
  // Enterprise catalog wire metadata (T16). The public list no longer carries
  // `allowed_roles`/`enabled` — visibility is org/scope-filtered server-side.
  zipSize?: number | null;
  sha256?: string | null;
  updatedAt?: string;
}

/**
 * Normalize one raw `skills:fetchMarketplace` IPC row (the server's
 * `SkillPublicView` plus main-injected `url`/`localId`) into a
 * `MarketplaceSkill`. Drops the retired `allowed_roles`/`enabled` role fields
 * and coerces nullable wire fields to safe defaults. Pure — no IPC, no state.
 */
export function normalizeMarketplaceRow(raw: Record<string, unknown>): MarketplaceSkill {
  return {
    id: String(raw.id),
    name: String(raw.name),
    name_zh: typeof raw.name_zh === 'string' ? raw.name_zh : null,
    description: typeof raw.description === 'string' ? raw.description : '',
    category: String(raw.category),
    url: String(raw.url),
    version: typeof raw.version === 'string' ? raw.version : '',
    source: (raw.source ?? null) as { from?: string; url?: string; author?: string } | null,
    icon: typeof raw.icon === 'string' ? raw.icon : undefined,
    zipSize: typeof raw.zipSize === 'number' ? raw.zipSize : null,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : null,
    localId: typeof raw.localId === 'string' ? raw.localId : null,
    // Omitted entirely when absent so rows stay lean and JSON-round-trippable.
    ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
  };
}
