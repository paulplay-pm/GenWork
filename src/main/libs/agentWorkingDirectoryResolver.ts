import type { Agent } from '../genworkStore';

export interface CwdResolverDeps {
  getAgent: (agentId: string) => Agent | null;
  getEnterpriseAgentPrefs: (enterpriseAgentId: string) => string;
  getGlobalDefaultCwd: () => string;
}

/**
 * Resolve the default working directory for a session bound to `agentId`.
 *
 * Enterprise-managed agents keep their working directory in the
 * `enterprise_agent_prefs` table (the strict-mirror sync engine pins the
 * agent row's `workingDirectory` to ''), so the prefs value is the cwd
 * source for them, with the Cowork global default cwd as fallback. For
 * non-enterprise agents the row's own working directory wins, then the
 * global default.
 */
export function resolveAgentDefaultWorkingDirectory(
  agentId: string | undefined,
  deps: CwdResolverDeps,
): string {
  const resolvedAgentId = agentId?.trim() || 'main';
  const agent = deps.getAgent(resolvedAgentId);

  const enterpriseAgentId = agent?.enterpriseAgentId?.trim();
  if (agent?.source === 'enterprise' && enterpriseAgentId) {
    const prefsWorkingDirectory = deps.getEnterpriseAgentPrefs(enterpriseAgentId).trim();
    if (prefsWorkingDirectory) return prefsWorkingDirectory;
  }

  const agentWorkingDirectory = agent?.workingDirectory?.trim();
  if (agentWorkingDirectory) return agentWorkingDirectory;

  return deps.getGlobalDefaultCwd();
}
