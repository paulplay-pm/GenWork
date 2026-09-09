import { beforeEach, describe, expect, test, vi } from 'vitest';

// NOTE: `agentEnterpriseSync` (Task 10) does not exist on disk yet, so this
// test cannot statically import it — the import would be fetched before the
// hoisted vi.mock registration runs and Vitest would fail to load the suite.
// The vi.mock factory below still fakes the module for the handler's own
// import; the hoisted `syncFromServerMock` gives the assertions a reference
// to the exact same mock function.
const { handlers, syncFromServerMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  syncFromServerMock: vi.fn().mockResolvedValue({ report: { upserted: 1, removed: 0, skipped: 0 } }),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, fn: unknown) => { handlers.set(channel, fn); }) },
}));
vi.mock('../../auth/enterpriseClient', () => ({
  enterpriseClient: { listEnterpriseAgents: vi.fn() },
}));
vi.mock('../../auth/loginGate', () => ({
  loginGate: {
    requireEnterprise: vi.fn().mockReturnValue({ userId: 'u1', orgId: 'o1', jwt: 'tok', roles: ['user'] }),
  },
}));
vi.mock('../../libs/agentEnterpriseSync', () => ({
  agentEnterpriseSync: { syncFromServer: syncFromServerMock },
}));

import { AgentIpcChannel } from '../../../shared/agent/constants';
import { enterpriseClient } from '../../auth/enterpriseClient';
import { loginGate } from '../../auth/loginGate';
import { agentEnterpriseSyncThrottle } from '../../libs/agentEnterpriseSyncThrottle';
import { registerAgentEnterpriseHandlers } from './handlers.enterprise';

function deps(): Parameters<typeof registerAgentEnterpriseHandlers>[0] {
  return {
    getGenWorkStore: () => ({}) as never,
    getEnterpriseAgentPrefsStore: () => ({ remove: vi.fn() }) as never,
    getSkillManager: () => ({ getCatalogLocalId: (id: string) => id }) as never,
    getAvailableModelsRef: () => '',
  };
}

// The handler now consults the module-level throttle cache, and all tests share
// the account key `u1@o1` — reset between tests so a prior success is never
// served from cache to a later test's assertion.
beforeEach(() => { agentEnterpriseSyncThrottle._reset(); });

describe('agents:fetchEnterpriseAgents', () => {
  test('happy path invokes sync and returns report', async () => {
    syncFromServerMock.mockClear();
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockResolvedValue([{
      agentId: 'agent_a1', name: 'Reviewer', description: 'd',
      identity: '', systemPrompt: '', model: '', thinkingLevel: '', icon: '',
      skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true,
    }]);
    registerAgentEnterpriseHandlers(deps());
    const out = await handlers.get(AgentIpcChannel.FetchEnterpriseAgents)!(undefined, undefined) as {
      success: boolean; report: { upserted: number };
    };
    expect(out.success).toBe(true);
    expect(out.report.upserted).toBe(1);
    expect(syncFromServerMock).toHaveBeenCalledTimes(1);
  });

  test('HTTP failure returns success=false without invoking sync', async () => {
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockRejectedValue(new Error('boom'));
    syncFromServerMock.mockClear();
    registerAgentEnterpriseHandlers(deps());
    const out = await handlers.get(AgentIpcChannel.FetchEnterpriseAgents)!(undefined, undefined) as { success: boolean };
    expect(out.success).toBe(false);
    expect(syncFromServerMock).not.toHaveBeenCalled();
  });

  test('loginGate.requireEnterprise returns success=false when not logged in', async () => {
    // The handler wraps requireEnterprise so an unauthenticated startup
    // probe (MyAgentSidebarTree fires this on mount, before the user
    // logs in) does not generate "Error occurred in handler" lines
    // through Electron's IPC plumbing. The renderer's `void`-mounted
    // useEffect already drops the `{ success: false, error }` payload.
    vi.mocked(loginGate.requireEnterprise).mockImplementationOnce(() => { throw new Error('not logged in'); });
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockResolvedValue([]);
    registerAgentEnterpriseHandlers(deps());
    const out = await handlers.get(AgentIpcChannel.FetchEnterpriseAgents)!(undefined, undefined) as { success: boolean; error?: string };
    expect(out).toEqual({ success: false, error: 'not logged in' });
    expect(enterpriseClient.listEnterpriseAgents).not.toHaveBeenCalled();
  });

  test('rapid handler invocations for the same account are throttled to one HTTP call', async () => {
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockClear();
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockResolvedValue([{
      agentId: 'agent_a1', name: 'Reviewer', description: 'd',
      identity: '', systemPrompt: '', model: '', thinkingLevel: '', icon: '',
      skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true,
    }]);
    syncFromServerMock.mockClear();
    registerAgentEnterpriseHandlers(deps());
    const handler = handlers.get(AgentIpcChannel.FetchEnterpriseAgents)!;
    const [first, second] = await Promise.all([
      handler(undefined, undefined) as Promise<{ success: boolean; report: { upserted: number } }>,
      handler(undefined, undefined) as Promise<{ success: boolean; report: { upserted: number } }>,
    ]);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.report).toEqual(second.report);
    expect(first.report.upserted).toBe(1);
    // The second invocation is served from the throttle cache: one HTTP call,
    // one sync pass.
    expect(enterpriseClient.listEnterpriseAgents).toHaveBeenCalledTimes(1);
    expect(syncFromServerMock).toHaveBeenCalledTimes(1);
  });

  test('a rejected fetch preserves local state and does not poison the throttle cache', async () => {
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockRejectedValue(new Error('server down'));
    syncFromServerMock.mockClear();
    registerAgentEnterpriseHandlers(deps());
    const handler = handlers.get(AgentIpcChannel.FetchEnterpriseAgents)!;

    const failed = await handler(undefined, undefined) as { success: boolean; error: string };
    expect(failed.success).toBe(false);
    expect(failed.error).toBe('server down');
    expect(syncFromServerMock).not.toHaveBeenCalled();

    // A subsequent successful call (post-reset) still works — the rejection
    // left no cache entry behind.
    agentEnterpriseSyncThrottle._reset();
    vi.mocked(enterpriseClient.listEnterpriseAgents).mockResolvedValue([]);
    syncFromServerMock.mockClear();
    const retried = await handler(undefined, undefined) as { success: boolean };
    expect(retried.success).toBe(true);
    expect(syncFromServerMock).toHaveBeenCalledTimes(1);
  });
});

describe('agents:enterprise agent model override', () => {
  const prefs = { getModel: vi.fn(), setModel: vi.fn() };
  function modelDeps(): Parameters<typeof registerAgentEnterpriseHandlers>[0] {
    return {
      getGenWorkStore: () => ({
        listAgents: () => [{ source: 'enterprise' as const, enterpriseAgentId: 'agent_a1', id: 'agent_a1' }],
      }) as never,
      getEnterpriseAgentPrefsStore: () => prefs as never,
      getSkillManager: () => ({ getCatalogLocalId: (id: string) => id }) as never,
      getAvailableModelsRef: () => '',
    };
  }
  beforeEach(() => { prefs.getModel.mockClear(); prefs.setModel.mockClear(); });

  test('GetEnterpriseAgentModel returns the stored override for a known enterprise agent', async () => {
    prefs.getModel.mockReturnValue('genwork/opus-4');
    registerAgentEnterpriseHandlers(modelDeps());
    const out = await handlers.get(AgentIpcChannel.GetEnterpriseAgentModel)!(undefined, 'agent_a1') as { success: boolean; modelRef?: string };
    expect(out).toEqual({ success: true, modelRef: 'genwork/opus-4' });
    expect(prefs.getModel).toHaveBeenCalledWith('agent_a1');
  });

  test('GetEnterpriseAgentModel returns unknown_agent for an unknown id', async () => {
    registerAgentEnterpriseHandlers(modelDeps());
    const out = await handlers.get(AgentIpcChannel.GetEnterpriseAgentModel)!(undefined, 'nope') as { success: boolean; error?: string };
    expect(out).toEqual({ success: false, error: 'unknown_agent' });
  });

  test('SetEnterpriseAgentModel persists via the prefs store', async () => {
    registerAgentEnterpriseHandlers(modelDeps());
    const out = await handlers.get(AgentIpcChannel.SetEnterpriseAgentModel)!(undefined, { agentId: 'agent_a1', modelRef: 'genwork/sonnet-5' }) as { success: boolean };
    expect(out).toEqual({ success: true });
    expect(prefs.setModel).toHaveBeenCalledWith('agent_a1', 'genwork/sonnet-5');
  });
});
