import { afterEach, expect, test, vi } from 'vitest';

import { skillService } from './skill';

afterEach(() => vi.unstubAllGlobals());

test('fetchMarketplaceSkills maps structured IPC result and populates icon map', async () => {
  vi.stubGlobal('window', {
    electron: {
      skills: {
        fetchMarketplace: () => Promise.resolve({
          success: true,
          skills: [{ id: 'sk1', name: 'Canvas', name_zh: '画布设计', description: 'd', category: 'design', url: 'https://ent.example/api/skill-marketplace/download/sk1', version: '1.0.0', source: null, icon: 'https://i/x.png', localId: 'remote-skill' }],
          categories: [{ id: 'design', en: 'Design', zh: '设计' }],
        }),
      },
    },
  });
  const { skills, categories } = await skillService.fetchMarketplaceSkills();
  expect(skills).toHaveLength(1);
  expect(skills[0].id).toBe('sk1');
  expect(skills[0].category).toBe('design');
  // The catalog→installed-local-id annotation rides through the structured
  // result and is not stripped by the service mapping.
  expect(skills[0].localId).toBe('remote-skill');
  expect(categories).toEqual([{ id: 'design', en: 'Design', zh: '设计' }]);
  // icon map is populated (locale-independent); the localized name is fed into
  // the same name map the other tabs use, so getLocalizedSkillName resolves it
  // by the active language — asserted here only for the locale-free icon.
  expect(skillService.getSkillIcon('sk1')).toBe('https://i/x.png');
});

test('refreshMarketplaceSkills bypasses the cache and returns the fresh catalog', async () => {
  // The previous test populated the singleton cache with `sk1`. Stub a fresh
  // catalog; a plain fetch would still return the cached `sk1`, but the forced
  // refresh must re-fetch and see the new entry.
  vi.stubGlobal('window', {
    electron: {
      skills: {
        fetchMarketplace: () => Promise.resolve({
          success: true,
          skills: [{ id: 'sk2', name: 'Writer', name_zh: '写作', description: 'd', category: 'ops', url: 'https://ent.example/api/skill-marketplace/download/sk2', version: '1.0.0', source: null, icon: null, localId: null }],
          categories: [{ id: 'ops', en: 'Ops', zh: '运维' }],
        }),
      },
    },
  });
  const { skills, categories } = await skillService.refreshMarketplaceSkills();
  expect(skills.map(s => s.id)).toEqual(['sk2']);
  expect(skills[0].localId).toBeNull();
  expect(categories).toEqual([{ id: 'ops', en: 'Ops', zh: '运维' }]);
});
