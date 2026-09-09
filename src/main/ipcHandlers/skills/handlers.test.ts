import { describe, expect, test, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

const skillManagerMocks = vi.hoisted(() => ({
  getCatalogLocalId: vi.fn<(catalogId: string) => string | undefined>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, fn: unknown) => { handlers.set(channel, fn); }) },
}));
vi.mock('../../auth/enterpriseClient', () => ({
  enterpriseClient: { listEnterpriseSkills: vi.fn() },
}));
vi.mock('../../libs/endpoints', () => ({ getEnterpriseServerUrl: () => 'https://ent.example' }));
vi.mock('../../skills', () => ({ updatePluginSkillIdsFromReport: vi.fn() }));

import { enterpriseClient } from '../../auth/enterpriseClient';
import { registerSkillHandlers } from './handlers';

function register(): void {
  registerSkillHandlers({
    getSkillManager: () => ({ getCatalogLocalId: skillManagerMocks.getCatalogLocalId } as never),
    getSkillStoreUrl: () => '',
    getOpenClawRuntimeAdapter: () => null,
  });
}

describe('skills:fetchMarketplace', () => {
  test('returns role-scoped skills with assembled download urls and mapped categories', async () => {
    vi.mocked(enterpriseClient.listEnterpriseSkills).mockResolvedValue({
      categories: [{ id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized' }],
      skills: [{ id: 'sk1', name: 'Canvas', name_zh: '画布', description: 'd', category: 'uncategorized', version: '1.0.0', icon: null, source: null, zipSize: 1234, sha256: 'abc123def456', updatedAt: '2026-09-01T00:00:00.000Z' }],
    });
    register();
    const out = await handlers.get('skills:fetchMarketplace')!(undefined, undefined) as {
      success: boolean; skills: Array<{ id: string; url: string }>; categories: Array<{ id: string; en: string; zh: string }>;
    };
    expect(out.success).toBe(true);
    expect(out.skills[0].url).toBe('https://ent.example/api/skill-marketplace/download/sk1');
    expect(out.categories[0]).toEqual({ id: 'uncategorized', en: 'Uncategorized', zh: '未分类' });
  });

  test('returns success=false on error', async () => {
    vi.mocked(enterpriseClient.listEnterpriseSkills).mockRejectedValue(new Error('boom'));
    register();
    const out = await handlers.get('skills:fetchMarketplace')!(undefined, undefined) as { success: boolean; error: string };
    expect(out.success).toBe(false);
    expect(out.error).toBeTruthy();
  });

  test('annotates each skill with the resolved installed local id (localId)', async () => {
    skillManagerMocks.getCatalogLocalId.mockReset();
    skillManagerMocks.getCatalogLocalId.mockImplementation((id: string) => (id === 'sk1' ? 'remote-skill' : undefined));
    vi.mocked(enterpriseClient.listEnterpriseSkills).mockResolvedValue({
      categories: [{ id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized' }],
      skills: [
        { id: 'sk1', name: 'Canvas', name_zh: '画布', description: 'd', category: 'uncategorized', version: '1.0.0', icon: null, source: null, zipSize: 1234, sha256: 'abc123def456', updatedAt: '2026-09-01T00:00:00.000Z' },
        { id: 'sk2', name: 'Writer', name_zh: '写作', description: 'd', category: 'uncategorized', version: '2.0.0', icon: null, source: null, zipSize: 2345, sha256: 'def456abc789', updatedAt: '2026-09-01T00:00:00.000Z' },
      ],
    });
    register();
    const out = await handlers.get('skills:fetchMarketplace')!(undefined, undefined) as {
      success: boolean; skills: Array<{ id: string; localId: string | null }>;
    };
    expect(out.success).toBe(true);
    // Mapped catalog id → installed local id rides along on the skill.
    expect(out.skills[0].localId).toBe('remote-skill');
    // Unmapped (not installed via the enterprise catalog) → null.
    expect(out.skills[1].localId).toBeNull();
    expect(skillManagerMocks.getCatalogLocalId).toHaveBeenCalledWith('sk1');
    expect(skillManagerMocks.getCatalogLocalId).toHaveBeenCalledWith('sk2');
  });
});
