// enterprise_server/src/sso/ssoLoginContext.ts
// In-memory store for SSO login contexts that need to span two HTTP
// requests (`/auth/sso/callback` -> `/bind-sso` -> `/auth/sso/callback`).
// Single-instance only; multi-instance deployments must move this to DB
// or Redis (spec §12 P2). TTL is enforced lazily on `get`/`size`.

export type SsoLoginContext =
  | { kind: 'pending_bind';
      orgId: string; connectionId: string; externalId: string;
      email: string | null; loginName: string | null;
      returnTarget: 'console' | 'desktop' | 'web';
      redirectUri: string | null; codeVerifier: string | null;
      expiresAt: Date; }
  | { kind: 'ready_to_finalize';
      orgId: string; connectionId: string; boundUserId: string;
      externalId: string; returnTarget: 'console' | 'desktop' | 'web';
      redirectUri: string | null;
      codeVerifier: string | null; expiresAt: Date; }
  | { kind: 'self_binding';
      orgId: string; connectionId: string; userId: string;
      redirectUri: string | null; codeVerifier: string | null;
      returnTarget: 'console' | 'desktop' | 'web';
      expiresAt: Date; };

const map = new Map<string, SsoLoginContext>();

function isLive(ctx: SsoLoginContext | undefined): ctx is SsoLoginContext {
  return !!ctx && ctx.expiresAt.getTime() > Date.now();
}

export const ssoLoginContextStore = {
  set(state: string, ctx: SsoLoginContext): void {
    map.set(state, ctx);
  },
  get(state: string): SsoLoginContext | undefined {
    const ctx = map.get(state);
    if (!isLive(ctx)) {
      map.delete(state);
      return undefined;
    }
    return ctx;
  },
  delete(state: string): boolean {
    return map.delete(state);
  },
  size(): number {
    let n = 0;
    for (const [k, v] of map) {
      if (isLive(v)) n++;
      else map.delete(k);
    }
    return n;
  },
};
