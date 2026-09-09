import type { Agent } from '../genworkStore';
import { parsePrimaryModelRef } from './openclawAgentModels';

/** The model ref an agent actually runs with: a parseable local override for
 *  enterprise agents (from `enterprise_agent_prefs`), else the agent row's
 *  server-provided model. Non-enterprise agents always use their row model. */
export function effectiveAgentModelRef(
  agent: Agent,
  getOverrideModel: (enterpriseAgentId: string) => string,
): string {
  if (agent.source === 'enterprise' && agent.enterpriseAgentId) {
    const override = getOverrideModel(agent.enterpriseAgentId).trim();
    if (override && parsePrimaryModelRef(override)) return override;
  }
  return agent.model;
}
