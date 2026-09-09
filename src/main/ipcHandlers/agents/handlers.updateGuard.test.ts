/**
 * Unit tests for the enterprise-agent merge guard (re-add dropped baseline
 * skills/subagents) and the resolved local baseline enrichment on the CRUD
 * `agents:update` / `agents:list` handlers.
 *
 * Uses a real `GenWorkStore` (in-memory SQLite) plus a real `AgentManager`,
 * with a fake `SkillManager.getCatalogLocalId` that resolves server catalog
 * ids to `local_<id>`. The handler's real `deriveProvenance` path is
 * exercised — only the skill manager is faked.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Capture the ipcMain.handle registrations so tests can invoke the CRUD
// handlers directly.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock' },
  ipcMain: { handle: vi.fn((channel: string, fn: unknown) => { handlers.set(channel, fn); }) },
}));

import BetterSqlite3 from 'better-sqlite3';

import { AgentIpcChannel } from '../../../shared/agent/constants';
import { AgentManager } from '../../agentManager';
import { GenWorkStore } from '../../genworkStore';
import { registerAgentHandlers } from './handlers';

let db: BetterSqlite3.Database;
let store: GenWorkStore;

/** Initialise a fresh in-memory database with the minimum schema. */
function setupDb(): void {
  db = new BetterSqlite3(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS genwork_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      openclaw_session_id TEXT,
      scheduled_task_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      pinned INTEGER NOT NULL DEFAULT 0,
      pin_order INTEGER,
      cwd TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      model_override TEXT NOT NULL DEFAULT '',
      thinking_level TEXT NOT NULL DEFAULT '',
      execution_mode TEXT NOT NULL DEFAULT 'local',
      active_skill_ids TEXT,
      agent_id TEXT DEFAULT 'main',
      parent_session_id TEXT,
      forked_from_message_id TEXT,
      forked_at INTEGER,
      fork_mode TEXT NOT NULL DEFAULT 'none',
      fork_workspace_path TEXT,
      fork_git_branch TEXT,
      fork_git_base_ref TEXT,
      goal_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS genwork_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      sequence INTEGER,
      FOREIGN KEY (session_id) REFERENCES genwork_sessions(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS library_artifact_sessions (
      artifact_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (artifact_id, session_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      identity TEXT NOT NULL DEFAULT '',
      about_you TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      thinking_level TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      skill_ids TEXT NOT NULL DEFAULT '[]',
      subagent_allow_agent_ids TEXT NOT NULL DEFAULT '[]',
      server_skill_ids TEXT NOT NULL DEFAULT '[]',
      server_subagent_allow_agent_ids TEXT NOT NULL DEFAULT '[]',
      server_im_channels TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      pin_order INTEGER,
      sort_order INTEGER,
      is_default INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'custom',
      preset_id TEXT NOT NULL DEFAULT '',
      enterprise_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.75,
      is_explicit INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'created',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_memory_sources (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      session_id TEXT,
      message_id TEXT,
      role TEXT NOT NULL DEFAULT 'system',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `);

  store = new GenWorkStore(db);
}

const fakeSkillManager = {
  // Server catalog id -> installed local id, following the brief's fixture.
  getCatalogLocalId: (catalogId: string): string | undefined => `local_${catalogId}`,
  // Installed local skills: `local_s1` is enabled, `local_s2` is installed
  // but DISABLED. The toggleable skills grid lists only enabled skills, so
  // the enrichment's `serverSkillInstalledIds` (raw server ids already shown
  // in the grid) must include `s1` and exclude `s2`.
  listSkills: () => [
    { id: 'local_s1', enabled: true },
    { id: 'local_s2', enabled: false },
  ],
};

let entId: string;

function register(): void {
  handlers.clear();
  registerAgentHandlers({
    getAgentManager: () => new AgentManager(store),
    getGenWorkStore: () => store,
    getGenWorkEngineRouter: () => ({}) as never,
    getIMGatewayManager: () => null,
    refreshImSessionWorkingDirectoriesForAgent: () => 0,
    resolveAgentWorkspacePath: (agentId: string) => `/ws/${agentId}`,
    resolveDefaultAgentModelRef: () => '',
    syncOpenClawConfig: () => Promise.resolve({ success: true, changed: false }),
    getSkillManager: () => fakeSkillManager as never,
  });
}

type ListedAgent = {
  id: string;
  name: string;
  skillIds: string[];
  serverSkillLocalIds?: string[];
  serverSkillInstalledIds?: string[];
  serverSubagentLocalIds?: string[];
};

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler;
}

beforeEach(() => {
  setupDb();
  // Local mirror of server agent `x` — the subagent baseline target.
  store.createAgent({ id: 'ent-x', name: 'Sub Ent', source: 'enterprise', enterpriseAgentId: 'x' });
  // Enterprise agent: baseline skill `s1` -> `local_s1`, baseline subagent
  // `x` -> local agent `ent-x`, plus user-local items.
  const ent = store.createAgent({
    id: 'ent',
    name: 'Ent',
    source: 'enterprise',
    enterpriseAgentId: 'srv-1',
    skillIds: ['local_s1', 'local_mine'],
    subagentAllowAgentIds: ['ent-x', 'other_local'],
  });
  entId = ent.id;
  // Baseline skill `s2` resolves to an installed-but-DISABLED local skill
  // (`local_s2`) — the case that must still render as a locked baseline row.
  store.updateAgent(entId, { serverSkillIds: ['s1', 's2'], serverSubagentAllowAgentIds: ['x'] });
  // Plain custom agent — control case for "behavior unchanged".
  store.createAgent({ id: 'custom-1', name: 'Custom', source: 'custom', skillIds: ['local_only'] });
  register();
});

describe('agents:update — enterprise merge guard', () => {
  test('dropping baseline skills/subagents on update re-adds them', async () => {
    const handler = getHandler(AgentIpcChannel.Update);
    const res = (await handler({} as never, entId, {
      skillIds: ['local_mine'],
      subagentAllowAgentIds: ['other_local'],
    })) as { success: boolean; error?: string };
    expect(res.success).toBe(true);
    const after = store.getAgent(entId)!;
    // `local_s1` + `local_s2` (baselines, re-added) alongside the user's
    // `local_mine`.
    expect(after.skillIds).toEqual(expect.arrayContaining(['local_s1', 'local_s2', 'local_mine']));
    // `ent-x` (baseline subagent, re-added) alongside the user's `other_local`.
    expect(after.subagentAllowAgentIds).toEqual(expect.arrayContaining(['ent-x', 'other_local']));
  });

  test('server-owned scalar fields are stripped before the store update', async () => {
    const spy = vi.spyOn(store, 'updateAgent');
    const handler = getHandler(AgentIpcChannel.Update);
    const res = (await handler({} as never, entId, {
      name: 'Hacked',
      model: 'evil-model',
      workingDirectory: '/tmp/ws',
    })) as { success: boolean };
    expect(res.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const passed = spy.mock.calls[0][1]!;
    expect(passed.name).toBeUndefined();
    expect(passed.model).toBeUndefined();
    // Local-only overlay fields still reach the store.
    expect(passed.workingDirectory).toBe('/tmp/ws');
  });

  test('custom agents keep current behavior (no merge, no strip)', async () => {
    const spy = vi.spyOn(store, 'updateAgent');
    const handler = getHandler(AgentIpcChannel.Update);
    const res = (await handler({} as never, 'custom-1', { skillIds: [], name: 'Renamed' })) as {
      success: boolean;
    };
    expect(res.success).toBe(true);
    const passed = spy.mock.calls[0][1]!;
    expect(passed.skillIds).toEqual([]);
    expect(passed.name).toBe('Renamed');
    const after = store.getAgent('custom-1')!;
    expect(after.skillIds).toEqual([]);
    expect(after.name).toBe('Renamed');
  });
});

describe('agents:list — enterprise baseline enrichment', () => {
  test('enterprise agents carry resolved local baseline sets', async () => {
    const handler = getHandler(AgentIpcChannel.List);
    const res = (await handler({} as never)) as { success: boolean; agents: ListedAgent[] };
    expect(res.success).toBe(true);
    const ent = res.agents.find(a => a.id === entId)!;
    // Resolved local ids, not raw server ids.
    expect(ent.serverSkillLocalIds).toEqual(['local_s1', 'local_s2']);
    expect(ent.serverSubagentLocalIds).toEqual(['ent-x']);
  });

  test('serverSkillInstalledIds means installed AND enabled, not merely installed', async () => {
    // The Skills tab's toggleable grid lists only enabled skills, so an
    // installed-but-disabled baseline skill (`s2` -> `local_s2`) is not shown
    // there; it must stay out of `serverSkillInstalledIds` so the renderer
    // renders it in the server-baseline section (locked) instead of
    // dropping it from both sections.
    const handler = getHandler(AgentIpcChannel.List);
    const res = (await handler({} as never)) as { success: boolean; agents: ListedAgent[] };
    expect(res.success).toBe(true);
    const ent = res.agents.find(a => a.id === entId)!;
    // `s1` -> `local_s1` is installed AND enabled: already in the grid.
    // `s2` -> `local_s2` is installed but disabled: NOT in the grid.
    expect(ent.serverSkillInstalledIds).toEqual(['s1']);
  });

  test('non-enterprise agents pass through unchanged', async () => {
    const handler = getHandler(AgentIpcChannel.List);
    const res = (await handler({} as never)) as { success: boolean; agents: ListedAgent[] };
    const custom = res.agents.find(a => a.id === 'custom-1')!;
    expect(custom.name).toBe('Custom');
    expect(custom).not.toHaveProperty('serverSkillLocalIds');
    expect(custom).not.toHaveProperty('serverSubagentLocalIds');
  });
});

describe('agents:update — enterprise baseline enrichment', () => {
  test('enterprise update response carries resolved local baseline sets', async () => {
    const handler = getHandler(AgentIpcChannel.Update);
    const res = (await handler({} as never, entId, {
      skillIds: ['local_mine'],
      subagentAllowAgentIds: ['other_local'],
    })) as { success: boolean; agent?: ListedAgent };
    expect(res.success).toBe(true);
    expect(res.agent?.id).toBe(entId);
    // Resolved local ids, not raw server ids — the renderer dispatches the
    // update response into the slice unconditionally, so these fields must
    // survive the save round-trip to keep the enterprise locks.
    expect(res.agent?.serverSkillLocalIds).toEqual(['local_s1', 'local_s2']);
    expect(res.agent?.serverSubagentLocalIds).toEqual(['ent-x']);
  });

  test('non-enterprise update response passes through unchanged', async () => {
    const handler = getHandler(AgentIpcChannel.Update);
    const res = (await handler({} as never, 'custom-1', { name: 'Renamed' })) as {
      success: boolean;
      agent?: ListedAgent;
    };
    expect(res.success).toBe(true);
    expect(res.agent?.name).toBe('Renamed');
    expect(res.agent).not.toHaveProperty('serverSkillLocalIds');
    expect(res.agent).not.toHaveProperty('serverSubagentLocalIds');
  });
});
