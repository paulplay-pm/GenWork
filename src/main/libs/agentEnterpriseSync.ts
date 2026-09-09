import { OpenClawProviderId } from '../../shared/providers/constants';
import type { CreateAgentRequest, GenWorkStore } from '../genworkStore';
import type { SkillManager } from '../skills/skillManager';
import { catalogResolver } from './catalogResolver';
import type { EnterpriseAgentPrefsStore } from './enterpriseAgentPrefsStore';
import { parsePrimaryModelRef } from './openclawAgentModels';

export interface ServerAgentView {
  agentId: string;
  name: string;
  description: string;
  identity: string;
  systemPrompt: string;
  aboutYou: string;
  model: string;
  thinkingLevel: string;
  icon: string;
  skillIds: string[];
  subagentAllowAgentIds: string[];
  allowedRoles: string[];
  enabled: boolean;
  imChannels: string[];
}

export interface SyncReport {
  upserted: number;
  removed: number;
  skipped: number;
}

interface SyncOptions {
  serverView: ServerAgentView[];
  genworkStore: GenWorkStore;
  prefsStore: EnterpriseAgentPrefsStore;
  skillManager: SkillManager;
  defaultModelRef: string;
  /**
   * The loaded desktop server-model list (from `enterpriseModelCache`), in the
   * org-catalog shape. When provided, an enterprise agent's server-side model
   * ref (org format `provider/model`) is translated into the desktop ref
   * (`genwork-server/<catalog UUID>`) it must be stored as. Production always
   * provides this (with each entry's catalog `id`); when omitted the legacy
   * `isModelAvailable` + passthrough path is used (unit tests).
   */
  serverModels?: Array<Pick<import('../auth/enterpriseModelCache').EnterpriseModelEntry, 'id' | 'provider' | 'model' | 'displayName'>>;
  /** Optional model-availability check (legacy path); defaults to `catalogResolver` lookup. */
  isModelAvailable?: (modelRef: string) => boolean;
}

/**
 * Translate an enterprise-server model ref (org format `providerSlug/upstream`,
 * the form the org catalog stores on the agent) into the desktop server-model
 * ref it must be persisted as: `genwork-server/<catalog UUID>` when the loaded
 * entry carries its catalog `id`, else `genwork-server/<displayName ?? upstream>`
 * (legacy, pre-UUID). This is the same ref `toOpenClawModelRef` produces for
 * server models and that `resolveOpenClawModelRef` / the local model override
 * match against. Carrying the catalog UUID keeps two same-named rows under
 * different provider keys distinct and switchable.
 *
 * `matched` is true when `orgRef` was empty (nothing configured) or resolved to
 * a loaded model; it is false when a configured ref had no matching loaded
 * model and `ref` is the `defaultRef` fallback. Callers use `matched` for the
 * report's `skipped` counter.
 */
export function translateEnterpriseServerModelRef(
  orgRef: string,
  serverModels: Array<{ provider: string; model: string; displayName: string | null; id?: string }>,
  defaultRef: string,
): { ref: string; matched: boolean } {
  const ref = orgRef.trim();
  if (!ref) return { ref: '', matched: true };
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return { ref: defaultRef, matched: false };
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const match = serverModels.find((m) => m.provider === provider && m.model === modelId);
  if (!match) return { ref: defaultRef, matched: false };
  const identity = match.id || match.displayName || modelId;
  return { ref: `${OpenClawProviderId.GenworkServer}/${identity}`, matched: true };
}

function defaultIsModelAvailable(modelRef: string): boolean {
  if (!modelRef) return true; // empty ref passes; treated as "no model set"
  const parsed = parsePrimaryModelRef(modelRef);
  if (!parsed) return false;
  return Boolean(catalogResolver.lookupModel(parsed.providerId, parsed.modelId));
}

export const agentEnterpriseSync = {
  async syncFromServer(opts: SyncOptions): Promise<{ report: SyncReport }> {
    const report: SyncReport = { upserted: 0, removed: 0, skipped: 0 };
    const isModelAvailable = opts.isModelAvailable ?? defaultIsModelAvailable;

    const serverIds = new Set(opts.serverView.map(a => a.agentId));
    const existingLocal = opts.genworkStore.listAgents().filter(a => a.source === 'enterprise');

    // REMOVE phase
    for (const local of existingLocal) {
      const key = local.enterpriseAgentId;
      if (!key || !serverIds.has(key)) {
        // The sync is the authoritative mirror of the server: stale enterprise
        // rows must be deletable even though user edits cannot delete them.
        opts.genworkStore.deleteAgent(local.id, { bypassEnterpriseGuard: true });
        if (key) opts.prefsStore.remove(key);
        report.removed++;
      }
    }

    // UPSERT phase
    for (const sv of opts.serverView) {
      if (!sv.agentId) { report.skipped++; continue; }

      // Resolve the agent's default model into the desktop ref space. The server
      // stores it in org format (`provider/model`); the desktop runs server
      // models as `genwork-server/<name>`. When the loaded server-model list is
      // available (production) we translate it; otherwise (legacy/tests) fall
      // back to the `isModelAvailable` + passthrough path.
      let effectiveModel: string;
      let modelMatched: boolean;
      if (opts.serverModels) {
        const resolved = translateEnterpriseServerModelRef(sv.model, opts.serverModels, opts.defaultModelRef);
        effectiveModel = resolved.ref;
        modelMatched = resolved.matched;
      } else {
        modelMatched = isModelAvailable(sv.model);
        effectiveModel = modelMatched ? sv.model : (opts.defaultModelRef || '');
      }
      if (!modelMatched) report.skipped++;

      const existing = existingLocal.find(a => a.enterpriseAgentId === sv.agentId);

      // Map server skill ids → local ids. Unresolvable server ids are dropped
      // (not fallen back to the raw id): skill_ids holds local ids only, and
      // the unresolvable server ids remain in server_skill_ids.
      const baselineSkillLocal = sv.skillIds
        .map((sid) => opts.skillManager.getCatalogLocalId(sid) ?? null)
        .filter((id): id is string => id !== null);

      // Map server subagent ids → local agent ids (via enterprise_agent_id).
      const allLocal = opts.genworkStore.listAgents();
      const serverAgentIdToLocal = new Map(
        allLocal
          .filter(a => a.source === 'enterprise' && a.enterpriseAgentId)
          .map(a => [a.enterpriseAgentId as string, a.id] as const),
      );
      const baselineSubagentLocal = sv.subagentAllowAgentIds
        .map((aid) => serverAgentIdToLocal.get(aid) ?? null)
        .filter((id): id is string => id !== null);

      let nextSkillIds = baselineSkillLocal;
      let nextSubagentIds = baselineSubagentLocal;

      if (existing) {
        // Preserve the user overlay = previously effective set minus the
        // previous baseline. Server edits to the baseline then refresh
        // wholesale without clobbering local-only additions.
        const oldBaselineSkill = existing.serverSkillIds
          .map((sid) => opts.skillManager.getCatalogLocalId(sid) ?? null)
          .filter((id): id is string => id !== null);
        const oldBaselineSub = (existing.serverSubagentAllowAgentIds ?? [])
          .map((aid) => serverAgentIdToLocal.get(aid) ?? null)
          .filter((id): id is string => id !== null);
        // A skill_ids entry that matches a raw server_skill_ids entry is a
        // leaked raw server id (written by the old `?? sid` code), never a
        // local user addition — exclude it from the overlay so legacy rows
        // self-heal instead of perpetuating the raw id on every resync.
        const serverBaselineRaw = existing.serverSkillIds;
        const overlaySkills = existing.skillIds.filter(
          (id) => !oldBaselineSkill.includes(id) && !serverBaselineRaw.includes(id),
        );
        const overlaySubs = existing.subagentAllowAgentIds.filter((id) => !oldBaselineSub.includes(id));
        nextSkillIds = Array.from(new Set([...baselineSkillLocal, ...overlaySkills]));
        nextSubagentIds = Array.from(new Set([...baselineSubagentLocal, ...overlaySubs]));
      }

      const payload = {
        name: sv.name,
        description: sv.description,
        identity: sv.identity,
        systemPrompt: sv.systemPrompt,
        aboutYou: sv.aboutYou,
        model: effectiveModel,
        thinkingLevel: (sv.thinkingLevel ?? '') as '' | 'low' | 'medium' | 'high',
        workingDirectory: '',
        icon: sv.icon,
        skillIds: nextSkillIds,
        subagentAllowAgentIds: nextSubagentIds,
        serverSkillIds: sv.skillIds,
        serverSubagentAllowAgentIds: sv.subagentAllowAgentIds,
        serverImChannels: sv.imChannels ?? [],
        source: 'enterprise' as const,
        enterpriseAgentId: sv.agentId,
      };

      if (existing) {
        // Authoritative mirror write: server edits to scalars must apply.
        opts.genworkStore.updateAgent(existing.id, payload, { bypassEnterpriseGuard: true });
      } else {
        const req: CreateAgentRequest = { ...payload };
        opts.genworkStore.createAgent(req);
      }
      report.upserted++;
    }

    return { report };
  },
};
