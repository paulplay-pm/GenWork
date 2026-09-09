import { describe, expect, test, vi } from 'vitest';

import { agentEnterpriseSync } from './agentEnterpriseSync';

function row(over: Partial<{
  id: string; name: string; source: 'custom' | 'preset' | 'enterprise';
  enterpriseAgentId?: string; model: string; skillIds: string[];
  subagentAllowAgentIds: string[];
  serverSkillIds: string[]; serverSubagentAllowAgentIds: string[]; serverImChannels: string[];
  aboutYou: string;
}> = {}): {
  id: string; name: string; description: string; systemPrompt: string; identity: string;
  model: string; thinkingLevel: ''; workingDirectory: string; icon: string;
  skillIds: string[]; subagentAllowAgentIds: string[]; enabled: boolean;
  pinned: boolean; pinOrder: null; sortOrder: null; isDefault: boolean;
  source: 'custom' | 'preset' | 'enterprise'; presetId: string;
  createdAt: number; updatedAt: number; enterpriseAgentId?: string;
  serverSkillIds: string[]; serverSubagentAllowAgentIds: string[]; serverImChannels: string[];
  aboutYou: string;
} {
  const id = over.id ?? 'local_' + Math.random().toString(36).slice(2, 8);
  return {
    id, name: over.name ?? id, description: '', systemPrompt: '', identity: '',
    model: over.model ?? '', thinkingLevel: '', workingDirectory: '', icon: '',
    skillIds: over.skillIds ?? [], subagentAllowAgentIds: over.subagentAllowAgentIds ?? [],
    enabled: true, pinned: false, pinOrder: null, sortOrder: null, isDefault: false,
    source: over.source ?? 'custom', presetId: '', createdAt: 0, updatedAt: 0,
    enterpriseAgentId: over.enterpriseAgentId,
    serverSkillIds: over.serverSkillIds ?? [],
    serverSubagentAllowAgentIds: over.serverSubagentAllowAgentIds ?? [],
    serverImChannels: over.serverImChannels ?? [],
    aboutYou: over.aboutYou ?? '',
  };
}

interface FakeStore {
  listAgents: () => ReturnType<typeof row>[];
  createAgent: ReturnType<typeof vi.fn>;
  updateAgent: ReturnType<typeof vi.fn>;
  deleteAgent: ReturnType<typeof vi.fn>;
}
function fakeStore(initial: ReturnType<typeof row>[]): FakeStore {
  let agents = [...initial];
  return {
    listAgents: () => agents,
    createAgent: vi.fn((req: { id?: string; name: string; source: 'enterprise'; enterpriseAgentId: string; model: string; skillIds: string[]; subagentAllowAgentIds: string[]; description?: string; identity?: string; systemPrompt?: string; thinkingLevel?: string; workingDirectory?: string; icon?: string; aboutYou?: string }) => {
      // Mirror GenWorkStore.createAgent id derivation: request.id || name-slug || random.
      const slug = req.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const id = req.id || slug || 'local_' + Math.random().toString(36).slice(2, 8);
      const r = row({ ...req, source: 'enterprise', enterpriseAgentId: req.enterpriseAgentId, id });
      agents = [...agents, r];
      return r;
    }),
    updateAgent: vi.fn((id: string, updates: Record<string, unknown>) => {
      const idx = agents.findIndex(a => a.id === id);
      agents[idx] = { ...agents[idx], ...updates } as ReturnType<typeof row>;
      return agents[idx];
    }),
    deleteAgent: vi.fn((id: string) => {
      const before = agents.length;
      agents = agents.filter(a => a.id !== id);
      return agents.length < before;
    }),
  };
}

describe('agentEnterpriseSync.syncFromServer', () => {
  test('3-agent happy path: all upserted, none removed', async () => {
    const store = fakeStore([]);
    const prefs = { remove: vi.fn() };
    const skills = { getCatalogLocalId: (id: string) => id };
    const out = await agentEnterpriseSync.syncFromServer({
      serverView: [
        { agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', aboutYou: '', model: '', thinkingLevel: '', icon: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [] },
        { agentId: 'b', name: 'B', description: '', identity: '', systemPrompt: '', aboutYou: '', model: '', thinkingLevel: '', icon: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [] },
        { agentId: 'c', name: 'C', description: '', identity: '', systemPrompt: '', aboutYou: '', model: '', thinkingLevel: '', icon: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [] },
      ],
      genworkStore: store as never,
      prefsStore: prefs as never,
      skillManager: skills as never,
      defaultModelRef: 'provider1/default-model',
    });
    expect(out.report).toEqual({ upserted: 3, removed: 0, skipped: 0 });
    expect(store.createAgent).toHaveBeenCalledTimes(3);
    expect(prefs.remove).not.toHaveBeenCalled();
  });

  test('second pass removes server-invisible enterprise rows and orphan prefs', async () => {
    const store = fakeStore([
      row({ id: 'local_a', enterpriseAgentId: 'a', source: 'enterprise' }),
      row({ id: 'local_x', enterpriseAgentId: 'gone', source: 'enterprise' }),
    ]);
    const prefs = { remove: vi.fn() };
    await agentEnterpriseSync.syncFromServer({
      serverView: [
        { agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', aboutYou: '', model: '', thinkingLevel: '', icon: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [] },
      ],
      genworkStore: store as never,
      prefsStore: prefs as never,
      skillManager: { getCatalogLocalId: (id: string) => id } as never,
      defaultModelRef: '',
    });
    expect(store.deleteAgent).toHaveBeenCalledWith('local_x', { bypassEnterpriseGuard: true });
    expect(prefs.remove).toHaveBeenCalledWith('gone');
  });

  test('model fallback: server model not in catalog → effectiveModel = defaultModelRef, skipped++', async () => {
    const store = fakeStore([]);
    const out = await agentEnterpriseSync.syncFromServer({
      serverView: [{
        agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', aboutYou: '',
        model: 'unknownProvider/missing', thinkingLevel: '', icon: '',
        skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [],
      }],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      skillManager: { getCatalogLocalId: (id: string) => id } as never,
      defaultModelRef: 'p1/default',
      isModelAvailable: (ref: string) => ref === 'p1/default',
    });
    expect(out.report.upserted).toBe(1);
    expect(out.report.skipped).toBe(1);
    expect(store.createAgent).toHaveBeenCalledWith(expect.objectContaining({ model: 'p1/default' }));
  });

  test('skill id not in local catalog → dropped from skill_ids (no crash)', async () => {
    const store = fakeStore([]);
    await agentEnterpriseSync.syncFromServer({
      serverView: [{
        agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', aboutYou: '',
        model: '', thinkingLevel: '', icon: '',
        skillIds: ['installed', 'unknown'], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [],
      }],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      skillManager: { getCatalogLocalId: (id: string) => (id === 'installed' ? 'installed-local' : undefined) } as never,
      defaultModelRef: '',
    });
    expect(store.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      // Unresolvable server ids stay out of skill_ids (local id space) and are
      // preserved only in server_skill_ids.
      skillIds: ['installed-local'],
      serverSkillIds: ['installed', 'unknown'],
    }));
  });

  test('non-enterprise local rows are not touched', async () => {
    const customRow = row({ id: 'custom_1', source: 'custom' });
    const store = fakeStore([customRow]);
    await agentEnterpriseSync.syncFromServer({
      serverView: [],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      skillManager: { getCatalogLocalId: (id: string) => id } as never,
      defaultModelRef: '',
    });
    expect(store.deleteAgent).not.toHaveBeenCalled();
    expect(store.listAgents().some(a => a.id === 'custom_1')).toBe(true);
  });

  test('a user-added skill survives a server resync', async () => {
    // Pre-existing local enterprise agent has a user-added skill 'local_mine'
    // on top of baseline local 'local_s1' (server id 's1').
    const store = fakeStore([
      row({
        id: 'local_a', name: 'A', source: 'enterprise', enterpriseAgentId: 'a',
        skillIds: ['local_s1', 'local_mine'],
        serverSkillIds: ['s1'],
      }),
    ]);
    const prefs = { remove: vi.fn() };
    const skillManager = { getCatalogLocalId: (id: string) => 'local_' + id };
    await agentEnterpriseSync.syncFromServer({
      serverView: [{ agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', aboutYou: '', model: '', thinkingLevel: 'medium', icon: '', skillIds: ['s1'], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: ['feishu'] }],
      genworkStore: store as never,
      prefsStore: prefs as never,
      skillManager: skillManager as never,
      defaultModelRef: '',
    });
    const updated = store.listAgents().find((a) => a.id === 'local_a')!;
    // baseline 'local_s1' preserved + user overlay 'local_mine' preserved.
    expect(updated.skillIds).toEqual(expect.arrayContaining(['local_s1', 'local_mine']));
    expect(updated.serverSkillIds).toEqual(['s1']);
    expect(updated.serverImChannels).toEqual(['feishu']);
  });

  test('a server-removed skill the user did not add disappears', async () => {
    const store = fakeStore([
      row({
        id: 'local_a', name: 'A', source: 'enterprise', enterpriseAgentId: 'a',
        skillIds: ['local_s1', 'local_s2'],
        serverSkillIds: ['s1', 's2'],
      }),
    ]);
    const skillManager = { getCatalogLocalId: (id: string) => 'local_' + id };
    await agentEnterpriseSync.syncFromServer({
      serverView: [{ agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', aboutYou: '', model: '', thinkingLevel: 'medium', icon: '', skillIds: ['s1'], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [] }],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      skillManager: skillManager as never,
      defaultModelRef: '',
    });
    const updated = store.listAgents().find((a) => a.id === 'local_a')!;
    expect(updated.skillIds).toEqual(['local_s1']); // local_s2 dropped
  });

  test('sync persists aboutYou from the server view', async () => {
    const store = fakeStore([]);
    await agentEnterpriseSync.syncFromServer({
      serverView: [{ agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: 'medium', icon: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [], aboutYou: 'hello there' }],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      skillManager: { getCatalogLocalId: () => null } as never,
      defaultModelRef: '',
    });
    const a = store.listAgents().find(x => x.id === 'a')!;
    expect(a.aboutYou).toBe('hello there');
  });

  test('unresolvable server skill ids are dropped from local skill_ids (kept in server_skill_ids)', async () => {
    const store = fakeStore([]);
    await agentEnterpriseSync.syncFromServer({
      serverView: [{ agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: 'medium', icon: '', skillIds: ['installed-1', 'not-installed-x'], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [], aboutYou: '' }],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      // Only 'installed-1' resolves to a local id. Note: getCatalogLocalId's REAL
      // return type is `string | undefined` (skillManager.getCatalogLocalId), so
      // the unresolvable case returns `undefined`, matching production.
      skillManager: { getCatalogLocalId: (id: string) => (id === 'installed-1' ? 'local_installed-1' : undefined) } as never,
      defaultModelRef: '',
    });
    const a = store.listAgents().find(x => x.id === 'a')!;
    expect(a.skillIds).toEqual(['local_installed-1']); // no raw 'not-installed-x', no undefined
    expect(a.serverSkillIds).toEqual(['installed-1', 'not-installed-x']);
  });

  test('legacy row with a leaked raw server id: resync drops the leaked id, keeps baseline + user overlay', async () => {
    // Row as written by the OLD `?? sid` code: the unresolvable baseline server
    // id 'raw-x' leaked into skill_ids. serverSkillIds stays authoritative, so
    // resync must drop the leaked id instead of reclassifying it as overlay.
    const store = fakeStore([
      row({
        id: 'local_a', name: 'A', source: 'enterprise', enterpriseAgentId: 'a',
        skillIds: ['local_s1', 'raw-x', 'local_mine'],
        serverSkillIds: ['s1', 'raw-x'],
      }),
    ]);
    await agentEnterpriseSync.syncFromServer({
      serverView: [{ agentId: 'a', name: 'A', description: '', identity: '', systemPrompt: '', aboutYou: '', model: '', thinkingLevel: 'medium', icon: '', skillIds: ['s1', 'raw-x'], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [] }],
      genworkStore: store as never,
      prefsStore: { remove: vi.fn() } as never,
      skillManager: { getCatalogLocalId: (id: string) => (id === 's1' ? 'local_s1' : undefined) } as never,
      defaultModelRef: '',
    });
    const updated = store.listAgents().find(a => a.id === 'local_a')!;
    expect(updated.skillIds).toEqual(['local_s1', 'local_mine']); // no 'raw-x'
    expect(updated.serverSkillIds).toEqual(['s1', 'raw-x']);
  });
});
