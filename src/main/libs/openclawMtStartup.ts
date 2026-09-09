import { enterpriseClient } from '../auth/enterpriseClient';
import { sessionStorage } from '../auth/sessionStorage';
import { buildProviderConfig, type OpenclawModelRef,resolvePolicies } from './openclawProviderConfig';

/**
 * Multi-tenant OpenClaw startup integration.
 *
 * When ENTERPRISE_SERVER_URL is set, before each gateway start we:
 *   1. Refresh the JWT from the active enterprise session.
 *   2. Rewrite the gateway token file with the JWT (OpenClaw's gateway-token
 *      gate is the existing auth surface; rewriting it with the user's
 *      JWT means each gateway invocation carries that user's identity).
 *   3. Pull the user's model catalog from /models and write the
 *      endpoint-only provider block into the OpenClaw config.
 *
 * Personal builds (no env var) skip this and continue using the legacy
 * youdao flow.
 */

interface EnterpriseMtStartupOptions {
  /** Path to the gateway-token file managed by OpenClawEngineManager. */
  gatewayTokenPath: string;
  /** Function that returns the current OpenClaw config object (mutable). */
  readConfig: () => Record<string, unknown>;
  /** Function that persists the OpenClaw config back to disk. */
  writeConfig: (cfg: Record<string, unknown>) => void;
  /** Optional logger sink (defaults to console). */
  log?: (msg: string) => void;
}

export type BootstrapResult =
  | { wired: true; modelEndpoints: number }
  | { wired: false; reason: string };

const log = (sink: ((msg: string) => void) | undefined, msg: string): void => {
  if (sink) sink(msg);
  else console.log(`[enterpriseMtGateway] ${msg}`);
};

export async function bootstrapEnterpriseMtGateway(
  opts: EnterpriseMtStartupOptions
): Promise<BootstrapResult> {
  const sink = opts.log;
  const enterpriseUrl = process.env.ENTERPRISE_SERVER_URL;
  if (!enterpriseUrl || !enterpriseUrl.trim()) {
    log(sink, 'skipped: ENTERPRISE_SERVER_URL unset');
    return { wired: false, reason: 'enterprise_server_url_unset' };
  }
  const session = sessionStorage.load();
  if (!session) {
    return { wired: false, reason: 'no_enterprise_session' };
  }
  let activeSession = session;
  if (activeSession.expiresAt > 0 && activeSession.expiresAt < Date.now() + 30_000) {
    // Token expired or about to — refresh proactively.
    try {
      const r = await enterpriseClient.refresh();
      activeSession = {
        ...activeSession,
        jwt: r.token,
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
      sessionStorage.save(activeSession);
    } catch {
      return { wired: false, reason: 'token_refresh_failed' };
    }
  }

  // 1. Refresh the gateway-token file with the JWT so OpenClaw receives the
  //    user's bearer on every gateway connection.
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.dirname(opts.gatewayTokenPath), { recursive: true });
  fs.writeFileSync(opts.gatewayTokenPath, activeSession.jwt, 'utf8');

  // 2. Pull the user's model catalog and inject endpoint-only provider config.
  let models: OpenclawModelRef[] = [];
  try {
    const list = await enterpriseClient.getModels();
    const base = enterpriseUrl.replace(/\/$/, '');
    models = list.map((m) => ({
      id: m.id,
      provider: m.provider,
      model: m.model,
      endpoint: `${base}/proxy/${m.provider}`,
    }));
  } catch (e) {
    // Best-effort: token rewrite already succeeded; do not block startup on
    // a transient catalog failure. Caller treats wired=true + 0 endpoints as
    // "user must load catalog later".
    log(sink, `failed to load models: ${(e as Error).message}`);
  }

  const cfg = opts.readConfig();
  // openclaw config shape: { gateway: { mode, providers: {...} } }.
  // We only inject the providers block; everything else stays intact.
  const providerCfg = buildProviderConfig(
    { userId: activeSession.userId, orgId: activeSession.orgId, roles: activeSession.roles },
    models
  );
  const existing = (cfg.gateway as Record<string, unknown> | undefined) ?? {};
  cfg.gateway = { ...existing, providers: providerCfg };
  opts.writeConfig(cfg);
  log(sink, `wired ${models.length} model endpoint(s) into OpenClaw config`);

  return { wired: true, modelEndpoints: models.length };
}

/**
 * Pull the three admin/user-owned lists from enterprise_server and merge
 * via resolvePolicies to produce the effective visible set the user gets.
 * Used by openclawConfigSync when ENTERPRISE_SERVER_URL is configured.
 */
export async function fetchAndResolveEnterpriseMtPolicies(
  adminMcp: { id: string; disabled: boolean; scope: string }[] = [],
  adminSkill: { id: string; disabled: boolean; scope: string }[] = [],
  adminModel: { id: string; disabled: boolean; scope: string }[] = []
): Promise<{ mcp: unknown[]; skill: unknown[]; model: unknown[] } | null> {
  if (!process.env.ENTERPRISE_SERVER_URL) return null;
  const session = sessionStorage.load();
  if (!session) return null;
  // For v1 we rely on the admin-side lists already loaded by the caller;
  // the per-user lists (mcp/skill owned by user) are still TODO once the
  // desktop's own Skill/MCP registry learns to query the server.
  return resolvePolicies(
    { userId: session.userId, orgId: session.orgId, roles: session.roles },
    { mcp: adminMcp, skill: adminSkill, model: adminModel },
    { mcp: [], skill: [], model: [] }
  );
}