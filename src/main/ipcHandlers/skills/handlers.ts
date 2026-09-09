import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

import { SkillIpcChannel,type SkillSubmitRequest } from '../../../shared/skills/constants';
import { enterpriseClient } from '../../auth/enterpriseClient';
import { loginGate } from '../../auth/loginGate';
import { getEnterpriseServerUrl } from '../../libs/endpoints';
import { updatePluginSkillIdsFromReport } from '../../skills';
import type { SkillManager } from '../../skills/skillManager';

export interface SkillHandlerDeps {
  getSkillManager: () => SkillManager;
  getSkillStoreUrl: () => string;
  getOpenClawRuntimeAdapter: () => {
    connectGatewayIfNeeded: () => Promise<void>;
    getGatewayClient: () => {
      request: <T = Record<string, unknown>>(
        method: string,
        params?: unknown,
        opts?: { timeoutMs?: number },
      ) => Promise<T>;
    } | null;
  } | null;
}

export function registerSkillHandlers(deps: SkillHandlerDeps): void {
  const { getSkillManager, getOpenClawRuntimeAdapter } = deps;

  ipcMain.handle('skills:list', () => {
    try {
      const skills = getSkillManager().listSkills();
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load skills' };
    }
  });

  ipcMain.handle('skills:setEnabled', async (_event, options: { id: string; enabled: boolean }) => {
    try {
      const skills = getSkillManager().setSkillEnabled(options.id, options.enabled);
      // Best-effort sync to OpenClaw
      try {
        const adapter = getOpenClawRuntimeAdapter();
        if (adapter) {
          await adapter.connectGatewayIfNeeded();
          const client = adapter.getGatewayClient();
          if (client) {
            await client.request('skills.update', { skillKey: options.id, enabled: options.enabled }, { timeoutMs: 10_000 });
          }
        }
      } catch (ocError) {
        console.warn('[skills] Failed to sync enabled state to OpenClaw:', ocError);
      }
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' };
    }
  });

  ipcMain.handle('skills:delete', async (_event, id: string) => {
    try {
      // Read _meta.json before deletion to get OpenClaw source path
      let openclawSourceDir: string | null = null;
      try {
        const skillRoot = getSkillManager().getSkillsRoot();
        const metaPath = path.join(skillRoot, id, '_meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (meta.openclawSourceDir) {
            openclawSourceDir = meta.openclawSourceDir;
          }
        }
      } catch { /* best-effort */ }

      const skills = await getSkillManager().deleteSkill(id);

      // Also remove from OpenClaw workspace so the skill won't reappear on next sync
      if (openclawSourceDir && fs.existsSync(openclawSourceDir)) {
        try {
          await fs.promises.rm(openclawSourceDir, { recursive: true, force: true });
          console.log('[skills] Also removed OpenClaw workspace skill:', openclawSourceDir);
        } catch (ocError) {
          console.warn('[skills] Failed to remove skill from OpenClaw workspace:', ocError);
        }
      }

      return { success: true, skills };
    } catch (error) {
      console.error('[skills] Failed to delete skill:', id, error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' };
    }
  });

  ipcMain.handle('skills:download', async (_event, source: string) => {
    return getSkillManager().downloadSkill(source);
  });

  ipcMain.handle('skills:upgrade', async (_event, skillId: string, downloadUrl: string) => {
    return getSkillManager().upgradeSkill(skillId, downloadUrl);
  });

  ipcMain.handle('skills:confirmInstall', async (_event, pendingId: string, action: string) => {
    const validActions = ['install', 'installDisabled', 'cancel'];
    if (!validActions.includes(action)) {
      return { success: false, error: 'Invalid action' };
    }
    return getSkillManager().confirmPendingInstall(
      pendingId,
      action as 'install' | 'installDisabled' | 'cancel'
    );
  });

  ipcMain.handle('skills:getRoot', () => {
    try {
      const root = getSkillManager().getSkillsRoot();
      return { success: true, path: root };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve skills root' };
    }
  });

  ipcMain.handle('skills:autoRoutingPrompt', () => {
    try {
      const prompt = getSkillManager().buildAutoRoutingPrompt();
      return { success: true, prompt };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build auto-routing prompt' };
    }
  });

  ipcMain.handle('skills:getConfig', (_event, skillId: string) => {
    return getSkillManager().getSkillConfig(skillId);
  });

  ipcMain.handle('skills:setConfig', (_event, skillId: string, config: Record<string, string>) => {
    return getSkillManager().setSkillConfig(skillId, config);
  });

  ipcMain.handle('skills:getEmailAccountsConfig', (_event, skillId: string) => {
    return getSkillManager().getEmailAccountsConfig(skillId);
  });

  ipcMain.handle('skills:setEmailAccountsConfig', (_event, skillId: string, config: Parameters<SkillManager['setEmailAccountsConfig']>[1]) => {
    return getSkillManager().setEmailAccountsConfig(skillId, config);
  });

  ipcMain.handle('skills:testEmailAccountConnectivity', async (
    _event,
    skillId: string,
    account: Parameters<SkillManager['testEmailAccountConnectivity']>[1]
  ) => {
    return getSkillManager().testEmailAccountConnectivity(skillId, account);
  });

  ipcMain.handle('skills:testEmailConnectivity', async (
    _event,
    skillId: string,
    config: Record<string, string>
  ) => {
    return getSkillManager().testEmailConnectivity(skillId, config);
  });

  ipcMain.handle('skills:fetchMarketplace', async () => {
    try {
      const { categories, skills } = await enterpriseClient.listEnterpriseSkills();
      const base = getEnterpriseServerUrl();
      const mgr = getSkillManager();
      return {
        success: true,
        skills: skills.map((s) => ({
          ...s,
          url: `${base}/api/skill-marketplace/download/${s.id}`,
          localId: mgr.getCatalogLocalId(s.id) ?? null,
        })),
        categories: categories.map((c) => ({ id: c.id, en: c.name_en, zh: c.name_zh })),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch skill marketplace' };
    }
  });

  ipcMain.handle('skills:detectFromOpenClaw', async () => {
    try {
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { skills: [], error: 'OpenClaw runtime not available' };
      }
      await adapter.connectGatewayIfNeeded();
      const client = adapter.getGatewayClient();
      if (!client) {
        return { skills: [], error: 'Gateway client not connected' };
      }
      const report = await client.request<{ skills: Array<Record<string, unknown>> }>('skills.status', {}, { timeoutMs: 10_000 });
      const sm = getSkillManager();
      updatePluginSkillIdsFromReport(sm, report as any);
      return sm.detectSkillsFromOpenClaw(report as any);
    } catch (error) {
      return { skills: [], error: error instanceof Error ? error.message : 'Detection failed' };
    }
  });

  ipcMain.handle('skills:syncFromOpenClaw', async () => {
    try {
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { synced: [], error: 'OpenClaw runtime not available' };
      }
      await adapter.connectGatewayIfNeeded();
      const client = adapter.getGatewayClient();
      if (!client) {
        return { synced: [], error: 'Gateway client not connected' };
      }
      const report = await client.request<{ skills: Array<Record<string, unknown>> }>('skills.status', {}, { timeoutMs: 10_000 });
      const sm = getSkillManager();
      updatePluginSkillIdsFromReport(sm, report as any);
      return sm.syncSkillsFromOpenClaw(report as any);
    } catch (error) {
      return { synced: [], error: error instanceof Error ? error.message : 'Sync failed' };
    }
  });

  ipcMain.handle('skills:refreshPluginSkillIds', async () => {
    try {
      const adapter = getOpenClawRuntimeAdapter();
      if (!adapter) {
        return { success: false, error: 'OpenClaw runtime not available' };
      }
      await adapter.connectGatewayIfNeeded();
      const client = adapter.getGatewayClient();
      if (!client) {
        return { success: false, error: 'Gateway client not connected' };
      }
      const report = await client.request<{ skills: Array<Record<string, unknown>> }>('skills.status', {}, { timeoutMs: 10_000 });
      const sm = getSkillManager();
      updatePluginSkillIdsFromReport(sm, report as any);
      return { success: true, pluginSkillIds: [...sm.getPluginSkillIds()] };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Refresh failed' };
    }
  });

  // A member's skill submission to the org review queue. The server enforces
  // the org's `members_can_submit_skills` toggle (403 `submission_disabled`)
  // and validates the zip like the admin publish route. The payload carries
  // the skill package as a base64 zip — keep it out of the logs; the error
  // message only.
  ipcMain.handle(SkillIpcChannel.Submit, async (_event, req: SkillSubmitRequest) => {
    try {
      loginGate.requireEnterprise();
      const data = await enterpriseClient.submitSkillRequest(req);
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to submit skill request',
      };
    }
  });
}
