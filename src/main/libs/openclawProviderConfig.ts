import { policyResolver } from '../policies/policyResolver';

/**
 * Provider config shape that OpenClaw runtime accepts. Endpoint-only — no key
 * is ever embedded; the upstream gateway calls enterprise_server's
 * ProviderProxy, which holds the encrypted key.
 */
export interface OpenclawProviderConfig {
  [provider: string]: { endpoint: string; model: string };
}

export interface OpenclawUserContext {
  userId: string;
  orgId: string;
  roles: string[];
  departmentPath?: string;
}

export interface OpenclawModelRef {
  id: string;
  provider: string;
  model: string;
  endpoint?: string;
}

/**
 * Build the provider block for the OpenClaw config. We deliberately never
 * read provider key material here — endpoint points at the enterprise_server
 * Proxy route which carries the user's JWT and handles auth + quota.
 */
export function buildProviderConfig(
  _userContext: OpenclawUserContext,
  models: OpenclawModelRef[]
): OpenclawProviderConfig {
  const cfg: OpenclawProviderConfig = {};
  for (const m of models) {
    cfg[m.provider] = { endpoint: m.endpoint ?? '', model: m.model };
  }
  return cfg;
}

/**
 * Apply PolicyResolver on the three admin/user lists to produce the
 * effective set the user can see. Returns the merged lists, not the raw
 * admin policies — caller decides how to push them to OpenClaw.
 */
export function resolvePolicies(
  userContext: OpenclawUserContext,
  admin: {
    mcp: { id: string; disabled: boolean; scope: string }[];
    skill: { id: string; disabled: boolean; scope: string }[];
    model: { id: string; disabled: boolean; scope: string }[];
  },
  userOwned: {
    mcp: { id: string }[];
    skill: { id: string }[];
    model: { id: string }[];
  }
): { mcp: unknown[]; skill: unknown[]; model: unknown[] } {
  const ctx = {
    id: userContext.userId,
    roles: userContext.roles,
    departmentPath: userContext.departmentPath,
  };
  return {
    mcp: policyResolver.resolveMcpList(admin.mcp, userOwned.mcp, ctx),
    skill: policyResolver.resolveSkillList(admin.skill, userOwned.skill, ctx),
    model: policyResolver.resolveModelList(admin.model, userOwned.model, ctx),
  };
}