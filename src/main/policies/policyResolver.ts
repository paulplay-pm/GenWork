interface Policy {
  id: string;
  disabled: boolean;
  scope: string;
  [k: string]: unknown;
}
interface UserItem {
  id: string;
  [k: string]: unknown;
}
interface Ctx {
  roles: string[];
  id: string;
  departmentPath?: string;
}

function matchesScope(scopeExpr: string, ctx: Ctx): boolean {
  if (scopeExpr === 'org-wide') return true;
  if (scopeExpr.startsWith('role:')) return ctx.roles.includes(scopeExpr.slice(5));
  if (scopeExpr.startsWith('user:')) return ctx.id === scopeExpr.slice(5);
  if (scopeExpr.startsWith('dept-path:')) {
    const p = scopeExpr.slice(10);
    return ctx.departmentPath === p || (ctx.departmentPath?.startsWith(p + '/') ?? false);
  }
  return false;
}

function mergeLists<P extends Policy, U extends UserItem>(
  admin: P[],
  userOwned: U[],
  ctx: Ctx
): (P | U)[] {
  const out = new Map<string, P | U>();
  for (const p of admin) {
    if (!p.disabled && matchesScope(p.scope, ctx)) out.set(p.id, p);
  }
  for (const u of userOwned) {
    const adm = admin.find((a) => a.id === u.id);
    if (adm?.disabled) continue;
    out.set(u.id, u);
  }
  return Array.from(out.values());
}

export const policyResolver = {
  resolveMcpList<P extends Policy, U extends UserItem>(
    admin: P[],
    userOwned: U[],
    ctx: Ctx
  ): (P | U)[] {
    return mergeLists(admin, userOwned, ctx);
  },
  resolveSkillList<P extends Policy, U extends UserItem>(
    admin: P[],
    userOwned: U[],
    ctx: Ctx
  ): (P | U)[] {
    return mergeLists(admin, userOwned, ctx);
  },
  resolveModelList<P extends Policy, U extends UserItem>(
    admin: P[],
    catalog: U[],
    ctx: Ctx
  ): (P | U)[] {
    // Models follow the same upper-bound semantics as MCP/skills: an admin
    // policy marking a model disabled hides it from the catalog even if the
    // catalog lists it.
    return mergeLists(admin, catalog, ctx);
  },
};