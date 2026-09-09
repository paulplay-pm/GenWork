import { ipcMain } from 'electron';

import {
  AgentId,
  AgentIpcChannel,
  type AgentLegacyIdentityCleanupResult,
  AgentLegacyIdentityCleanupStatus,
} from '../../../shared/agent/constants';
import type { AgentManager } from '../../agentManager';
import type { Agent, CreateAgentRequest, GenWorkStore, UpdateAgentRequest } from '../../genworkStore';
import type { IMGatewayManager } from '../../im';
import type { GenWorkEngineRouter } from '../../libs/agentEngine';
import { deriveProvenance } from '../../libs/agentProvenance';
import { cleanupLegacyAgentsMdIdentityBlockInWorkspace } from '../../libs/openclawAgentsMdIdentityMigration';
import type { SkillManager } from '../../skills/skillManager';

type SyncOpenClawConfig = (options: {
  reason: string;
  restartGatewayIfRunning?: boolean;
}) => Promise<{
  success: boolean;
  changed: boolean;
  error?: string;
}>;

export interface AgentHandlerDeps {
  getAgentManager: () => AgentManager;
  getGenWorkStore: () => GenWorkStore;
  getGenWorkEngineRouter: () => GenWorkEngineRouter;
  getIMGatewayManager: () => IMGatewayManager | null;
  getSkillManager: () => SkillManager;
  refreshImSessionWorkingDirectoriesForAgent: (agentId: string) => number;
  resolveAgentWorkspacePath: (agentId: string) => string;
  resolveDefaultAgentModelRef: () => string;
  syncOpenClawConfig: SyncOpenClawConfig;
}

const buildLegacyIdentityCleanupFailure = (
  error: unknown,
): Extract<AgentLegacyIdentityCleanupResult, { status: typeof AgentLegacyIdentityCleanupStatus.Failed }> => ({
  status: AgentLegacyIdentityCleanupStatus.Failed,
  error: error instanceof Error ? error.message : String(error),
});

async function cleanupLegacyIdentityBlockForAgent(
  agentId: string,
  deps: Pick<
    AgentHandlerDeps,
    'getAgentManager' | 'resolveAgentWorkspacePath' | 'syncOpenClawConfig'
  >,
): Promise<AgentLegacyIdentityCleanupResult> {
  if (agentId !== AgentId.Main && deps.getAgentManager().getAgent(agentId) === null) {
    return buildLegacyIdentityCleanupFailure(`Agent ${agentId} not found`);
  }

  const syncResult = await deps.syncOpenClawConfig({ reason: 'agent-identity-cleanup-prereq' });
  if (!syncResult.success) {
    return buildLegacyIdentityCleanupFailure(syncResult.error || 'OpenClaw config sync failed before cleanup.');
  }

  const workspacePath = deps.resolveAgentWorkspacePath(agentId);
  const result = cleanupLegacyAgentsMdIdentityBlockInWorkspace(workspacePath);
  if (result.status === AgentLegacyIdentityCleanupStatus.Cleaned) {
    console.log(
      `[OpenClaw] Cleaned legacy AGENTS.md identity block for agent ${agentId}; backup=${result.backupPath}`,
    );
  } else if (result.status === AgentLegacyIdentityCleanupStatus.Failed) {
    console.warn(
      `[OpenClaw] Failed to clean legacy AGENTS.md identity block for agent ${agentId}: ${result.error}`,
    );
  }
  return result;
}

export function registerAgentHandlers(deps: AgentHandlerDeps): void {
  const {
    getAgentManager,
    getGenWorkStore,
    getGenWorkEngineRouter,
    getIMGatewayManager,
    getSkillManager,
    refreshImSessionWorkingDirectoriesForAgent,
    resolveDefaultAgentModelRef,
    syncOpenClawConfig,
  } = deps;

  // Enterprise server agent id -> local agent id. Used to resolve an
  // enterprise agent's server-owned subagent baselines to local agent ids.
  const buildServerAgentIdToLocal = (): Map<string, string> => new Map(
    getGenWorkStore()
      .listAgents()
      .filter((a) => a.source === 'enterprise' && a.enterpriseAgentId)
      .map((a) => [a.enterpriseAgentId!, a.id] as const),
  );

  // Attaches the resolved local baseline ids to enterprise rows so the
  // renderer can show lock badges without extra IPC. Non-enterprise
  // rows pass through unchanged.
  const enrichAgentBaselines = (agent: Agent): Agent => {
    if (agent.source !== 'enterprise') return agent;
    const skillMgr = getSkillManager();
    const serverAgentIdToLocal = buildServerAgentIdToLocal();
    // Installed AND enabled local skills: the Skills tab's toggleable grid
    // lists only enabled skills, so an installed-but-disabled baseline skill
    // is not shown there and must still appear in the server-baseline
    // section (locked).
    const enabledLocalSkillIds = new Set(
      skillMgr.listSkills()
        .filter((skill) => skill.enabled)
        .map((skill) => skill.id),
    );
    return {
      ...agent,
      serverSkillLocalIds: agent.serverSkillIds
        .map((sid) => skillMgr.getCatalogLocalId(sid) ?? null)
        .filter((id): id is string => id !== null),
      serverSubagentLocalIds: agent.serverSubagentAllowAgentIds
        .map((aid) => serverAgentIdToLocal.get(aid) ?? null)
        .filter((id): id is string => id !== null),
      // Baseline skills installed AND enabled locally — already shown in the
      // toggleable grid, so excluded from the server-baseline section. Raw
      // server ids (same id-space as `serverSkillIds`); the renderer matches
      // them against the baseline section's ids directly.
      serverSkillInstalledIds: agent.serverSkillIds.filter(
        (sid) => {
          const localId = skillMgr.getCatalogLocalId(sid);
          return localId != null && enabledLocalSkillIds.has(localId);
        },
      ),
    };
  };

  ipcMain.handle(AgentIpcChannel.List, async () => {
    try {
      const rawAgents = getAgentManager().listAgents();
      // Pre-resolve the local baseline ids for enterprise agents so the
      // renderer can show lock badges without extra IPC.
      const agents = rawAgents.map((a) => enrichAgentBaselines(a));
      return { success: true, agents };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list agents',
      };
    }
  });

  ipcMain.handle(AgentIpcChannel.Get, async (_event, id: string) => {
    try {
      const agent = getAgentManager().getAgent(id);
      return { success: true, agent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get agent',
      };
    }
  });

  ipcMain.handle(
    AgentIpcChannel.Create,
    async (_event, request: CreateAgentRequest) => {
      try {
        const agent = getAgentManager().createAgent(request, resolveDefaultAgentModelRef());
        syncOpenClawConfig({ reason: 'agent-created' }).catch(err => {
          console.error('[OpenClaw] config sync after agent-created failed:', err);
        });
        return { success: true, agent };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create agent',
        };
      }
    },
  );

  ipcMain.handle(
    AgentIpcChannel.Update,
    async (_event, id: string, updates: UpdateAgentRequest) => {
      try {
        const previousAgent = getAgentManager().getAgent(id);
        const previousWorkingDirectory = previousAgent?.workingDirectory?.trim() || '';
        const nextWorkingDirectory = updates.workingDirectory?.trim() || '';
        const workingDirectoryChanged =
          updates.workingDirectory !== undefined
          && previousAgent !== null
          && previousWorkingDirectory !== nextWorkingDirectory;

        // Enterprise rows mirror a server-owned agent: merge the server
        // baseline back into submitted skill/subagent lists (a dropped
        // baseline item is re-added) and strip server-owned scalar fields so
        // they cannot drift locally. The store's enterprise guard stays as
        // belt-and-suspenders.
        let effectiveUpdates: UpdateAgentRequest = updates;
        const target = getGenWorkStore().getAgent(id);
        if (target && target.source === 'enterprise') {
          const skillMgr = getSkillManager();
          const localByServerAgent = buildServerAgentIdToLocal();
          const prov = deriveProvenance(
            {
              skillIds: updates.skillIds ?? target.skillIds,
              subagentAllowAgentIds: updates.subagentAllowAgentIds ?? target.subagentAllowAgentIds,
              serverSkillIds: target.serverSkillIds,
              serverSubagentAllowAgentIds: target.serverSubagentAllowAgentIds,
              serverImChannels: target.serverImChannels,
            },
            (sid) => skillMgr.getCatalogLocalId(sid) ?? null,
            (aid) => localByServerAgent.get(aid) ?? null,
          );
          const merged: UpdateAgentRequest = {
            ...updates,
            skillIds: updates.skillIds
              ? Array.from(new Set([...updates.skillIds, ...prov.baselineSkillIds]))
              : undefined,
            subagentAllowAgentIds: updates.subagentAllowAgentIds
              ? Array.from(new Set([...updates.subagentAllowAgentIds, ...prov.baselineSubagentIds]))
              : undefined,
          };
          const {
            name: _name,
            description: _description,
            systemPrompt: _systemPrompt,
            identity: _identity,
            model: _model,
            thinkingLevel: _thinkingLevel,
            icon: _icon,
            ...rest
          } = merged;
          effectiveUpdates = rest;
        }

        const agent = getAgentManager().updateAgent(id, effectiveUpdates);
        if (workingDirectoryChanged && agent) {
          refreshImSessionWorkingDirectoriesForAgent(agent.id);
        }
        const shouldSyncOpenClawConfig = Object.keys(updates).some(
          key => key !== 'pinned' && key !== 'sortOrder',
        );
        if (shouldSyncOpenClawConfig) {
          syncOpenClawConfig({
            reason: workingDirectoryChanged ? 'agent-working-directory-updated' : 'agent-updated',
            restartGatewayIfRunning: workingDirectoryChanged,
          }).catch(err => {
            console.error('[OpenClaw] config sync after agent update failed:', err);
          });
        }
        // Enrich the response the same way `agents:list` does so the
        // renderer's unconditional update dispatch keeps the enterprise
        // baseline locks intact.
        return { success: true, agent: agent ? enrichAgentBaselines(agent) : null };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update agent',
        };
      }
    },
  );

  ipcMain.handle(AgentIpcChannel.Reorder, async (_event, agentIds: string[]) => {
    try {
      const agents = getAgentManager().reorderAgents(agentIds);
      return { success: true, agents };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reorder agents',
      };
    }
  });

  ipcMain.handle(AgentIpcChannel.CleanupLegacyIdentityBlock, async (_event, id: string) => {
    try {
      const result = await cleanupLegacyIdentityBlockForAgent(id, deps);
      return { success: true, result };
    } catch (error) {
      const result = buildLegacyIdentityCleanupFailure(error);
      console.warn(`[OpenClaw] Failed to clean legacy AGENTS.md identity block for agent ${id}: ${result.error}`);
      return { success: false, result, error: result.error };
    }
  });

  ipcMain.handle(AgentIpcChannel.Delete, async (_event, id: string) => {
    try {
      const agentExists = id !== AgentId.Main && getAgentManager().getAgent(id) !== null;
      const deletedSessionIds = agentExists ? getGenWorkStore().listSessionIdsByAgent(id) : [];
      const router = getGenWorkEngineRouter();
      for (const sessionId of deletedSessionIds) {
        router.stopSession(sessionId);
      }

      const result = getAgentManager().deleteAgent(id);

      try {
        const imStore = getIMGatewayManager()?.getIMStore();
        if (imStore) {
          const imSettings = imStore.getIMSettings();
          const bindings = imSettings.platformAgentBindings;
          if (bindings) {
            let changed = false;
            for (const [platform, agentId] of Object.entries(bindings)) {
              if (agentId === id) {
                delete bindings[platform];
                changed = true;
              }
            }
            if (changed) {
              imStore.setIMSettings({ platformAgentBindings: bindings });
            }
          }
        }
      } catch {
        // IM store may not be initialised yet; safe to ignore.
      }

      if (result) {
        for (const sessionId of deletedSessionIds) {
          try {
            getIMGatewayManager()?.getIMStore()?.deleteSessionMappingByCoworkSessionId(sessionId);
          } catch {
            // IM store may not be initialised yet; safe to ignore.
          }
          try {
            router.onSessionDeleted(sessionId);
          } catch {
            // Router may not be initialised yet; safe to ignore.
          }
        }
      }

      syncOpenClawConfig({ reason: 'agent-deleted' }).catch(err => {
        console.error('[OpenClaw] config sync after agent-deleted failed:', err);
      });
      return { success: true, deleted: result, deletedSessionIds: result ? deletedSessionIds : [] };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete agent',
      };
    }
  });

  ipcMain.handle(AgentIpcChannel.Presets, async () => {
    try {
      const presets = getAgentManager().getPresetAgents();
      return { success: true, presets };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get presets',
      };
    }
  });

  ipcMain.handle(AgentIpcChannel.PresetTemplates, async () => {
    try {
      const presets = getAgentManager().getAllPresetAgents();
      return { success: true, presets };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get preset templates',
      };
    }
  });

  ipcMain.handle(AgentIpcChannel.AddPreset, async (_event, presetId: string) => {
    try {
      const agent = getAgentManager().addPresetAgent(presetId, resolveDefaultAgentModelRef());
      syncOpenClawConfig({ reason: 'agent-preset-added' }).catch(err => {
        console.error('[OpenClaw] config sync after agent-preset-added failed:', err);
      });
      return { success: true, agent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add preset agent',
      };
    }
  });
}
