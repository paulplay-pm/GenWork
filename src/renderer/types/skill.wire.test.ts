import { describe, expect, test } from 'vitest';

import { normalizeMarketplaceRow } from './skill';

/**
 * T16 wire normalizer: the enterprise catalog's public list no longer carries
 * `allowed_roles`/`enabled` (visibility is org/scope-filtered server-side) and
 * instead carries `zipSize`/`sha256`/`updatedAt`. The main-process handler
 * injects `url` + `localId`, so the normalizer must preserve those while
 * dropping the role fields.
 */
describe('normalizeMarketplaceRow', () => {
  test('drops allowed_roles/enabled and maps zipSize/sha256/updatedAt through', () => {
    const raw: Record<string, unknown> = {
      id: 'sk1',
      name: 'Canvas',
      name_zh: '画布',
      description: 'd',
      category: 'uncategorized',
      version: '1.0.0',
      icon: null,
      source: null,
      allowed_roles: ['org_admin'],
      enabled: true,
      zipSize: 1234,
      sha256: 'abc123def456',
      updatedAt: '2026-09-01T00:00:00.000Z',
      url: 'https://ent.example/api/skill-marketplace/download/sk1',
      localId: 'remote-skill',
    };
    const skill = normalizeMarketplaceRow(raw);
    expect(skill).not.toHaveProperty('allowed_roles');
    expect(skill).not.toHaveProperty('enabled');
    expect(skill.id).toBe('sk1');
    expect(skill.name).toBe('Canvas');
    expect(skill.name_zh).toBe('画布');
    expect(skill.description).toBe('d');
    expect(skill.category).toBe('uncategorized');
    expect(skill.version).toBe('1.0.0');
    // Handler-injected fields must survive normalization.
    expect(skill.url).toBe('https://ent.example/api/skill-marketplace/download/sk1');
    expect(skill.localId).toBe('remote-skill');
    expect(skill.zipSize).toBe(1234);
    expect(skill.sha256).toBe('abc123def456');
    expect(skill.updatedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  test('coerces nullable/absent wire fields to safe defaults', () => {
    const raw: Record<string, unknown> = {
      id: 'sk2',
      name: 'Writer',
      name_zh: null,
      description: null,
      category: 'ops',
      version: null,
      icon: 'https://i/x.png',
      source: { from: 'Github', url: 'https://github.com/x', author: 'A' },
      updatedAt: '2026-09-02T00:00:00.000Z',
      url: 'https://ent.example/api/skill-marketplace/download/sk2',
      localId: null,
    };
    const skill = normalizeMarketplaceRow(raw);
    expect(skill.description).toBe('');
    expect(skill.version).toBe('');
    expect(skill.name_zh).toBeNull();
    // Absent on this row → null, not undefined/NaN.
    expect(skill.zipSize).toBeNull();
    expect(skill.sha256).toBeNull();
    expect(skill.localId).toBeNull();
    expect(skill.icon).toBe('https://i/x.png');
    expect(skill.source).toEqual({ from: 'Github', url: 'https://github.com/x', author: 'A' });
    expect(skill.updatedAt).toBe('2026-09-02T00:00:00.000Z');
  });

  test('omits updatedAt when absent and keeps url for not-installed rows', () => {
    const raw: Record<string, unknown> = {
      id: 'sk3',
      name: 'Mail',
      name_zh: null,
      description: 'm',
      category: 'comm',
      version: '2.0.0',
      icon: null,
      source: null,
      url: 'https://ent.example/api/skill-marketplace/download/sk3',
      localId: null,
    };
    const skill = normalizeMarketplaceRow(raw);
    expect(skill).not.toHaveProperty('updatedAt');
    expect(skill.url).toBe('https://ent.example/api/skill-marketplace/download/sk3');
    expect(skill.localId).toBeNull();
  });
});
