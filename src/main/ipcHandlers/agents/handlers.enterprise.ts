import { ipcMain } from 'electron';

import { AgentIpcChannel } from '../../../shared/agent/constants';
import { enterpriseClient } from '../../auth/enterpriseClient';
import type { EnterpriseModelEntry } from '../../auth/enterpriseModelCache';
import { loginGate } from '../../auth/loginGate';
import type { GenWorkStore } from '../../genworkStore';
import { agentEnterpriseSync } from '../../libs/agentEnterpriseSync';
import { agentEnterpriseSyncThrottle } from '../../libs/agentEnterpriseSyncThrottle';
import type { EnterpriseAgentPrefsStore } from '../../libs/enterpriseAgentPrefsStore';
import type { SkillManager } from '../../skills/skillManager';

export interface AgentEnterpriseHandlerDeps {
  getGenWorkStore: () => GenWorkStore;
  getEnterpriseAgentPrefsStore: () => EnterpriseAgentPrefsStore;
  getSkillManager: () => SkillManager;
  /** Returns the desktop default model ref (providerId/modelId), used when the
   *  server-supplied model isn't present in the local catalog. */
  getAvailableModelsRef: () => string;
  /** Loaded desktop server-model list, used to translate an enterprise agent's
   *  org-format model ref into the desktop ref it must be stored as. Includes
   *  each entry's catalog `id` so the ref can be the catalog UUID. */
  getServerModels: () => Array<Pick<EnterpriseModelEntry, 'id' | 'provider' | 'model' | 'displayName'>>;
}

export function registerAgentEnterpriseHandlers(deps: AgentEnterpriseHandlerDeps): void {
  ipcMain.handle(AgentIpcChannel.FetchEnterpriseAgents, async () => {
    // Fail-fast on auth: an expired JWT triggers loginGate.lock() inside
    // requireEnterprise() and the renderer returns to LoginPage. The session
    // doubles as the per-account throttle key (same `${userId}@${orgId}`
    // format as triggers b/d).
    //
    // Wrap the gate so an unauthenticated startup probe (MyAgentSidebarTree
    // calls this on mount) doesn't generate "Error occurred in handler"
    // lines through Electron's IPC plumbing. The renderer treats
    // `{ success: false, error: 'not logged in' }` the same as a thrown
    // rejection: silent no-op in the void-mounted useEffect.
    let session: ReturnType<typeof loginGate.requireEnterprise>;
    try {
      session = loginGate.requireEnterprise();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'not logged in') return { success: false, error: msg };
      throw e;
    }
    const accountKey = `${session.userId}@${session.orgId}`;
    try {
      const { result } = await agentEnterpriseSyncThrottle.throttledSync(accountKey, async () => {
        const serverView = await enterpriseClient.listEnterpriseAgents();
        const { report } = await agentEnterpriseSync.syncFromServer({
          serverView,
          genworkStore: deps.getGenWorkStore(),
          prefsStore: deps.getEnterpriseAgentPrefsStore(),
          skillManager: deps.getSkillManager(),
          defaultModelRef: deps.getAvailableModelsRef(),
          serverModels: deps.getServerModels(),
        });
        return report;
      });
      return { success: true, report: result };
    } catch (error) {
      // Failure preservation: an unreachable server rejects before
      // syncFromServer runs, so local state is untouched. The renderer toast
      // surfaces the error; next attempt retries.
      return { success: false, error: error instanceof Error ? error.message : 'Failed to sync enterprise agents' };
    }
  });

  // Prefs (per-enterprise-agent working directory) round-trip for the
  // read-only settings panel. Keyed by the enterprise agent id: the local
  // agent id is a mirror id and the sync engine always writes the row's
  // workingDirectory to ''.
  ipcMain.handle(AgentIpcChannel.GetEnterpriseAgentWorkingDirectory, async (_e, agentId: string) => {
    loginGate.requireEnterprise();
    const local = deps.getGenWorkStore().listAgents().find(a => a.source === 'enterprise' && a.enterpriseAgentId === agentId);
    if (!local) return { success: false, error: 'unknown_agent' };
    return { success: true, workingDirectory: deps.getEnterpriseAgentPrefsStore().get(agentId) };
  });

  ipcMain.handle(AgentIpcChannel.SetEnterpriseAgentWorkingDirectory, async (_e, args: { agentId: string; workingDirectory: string }) => {
    loginGate.requireEnterprise();
    deps.getEnterpriseAgentPrefsStore().upsert(args.agentId, args.workingDirectory.trim());
    return { success: true };
  });

  // Local per-enterprise-agent model override (separate from the agents.model
  // column): Task 5 consults this at model-resolution time.
  ipcMain.handle(AgentIpcChannel.GetEnterpriseAgentModel, async (_e, agentId: string) => {
    loginGate.requireEnterprise();
    const local = deps.getGenWorkStore().listAgents().find(a => a.source === 'enterprise' && a.enterpriseAgentId === agentId);
    if (!local) return { success: false, error: 'unknown_agent' };
    return { success: true, modelRef: deps.getEnterpriseAgentPrefsStore().getModel(agentId) };
  });

  ipcMain.handle(AgentIpcChannel.SetEnterpriseAgentModel, async (_e, args: { agentId: string; modelRef: string }) => {
    loginGate.requireEnterprise();
    deps.getEnterpriseAgentPrefsStore().setModel(args.agentId, args.modelRef);
    return { success: true };
  });
}
