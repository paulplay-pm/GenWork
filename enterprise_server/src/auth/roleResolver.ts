import { pool } from '../db/pool';
import type { PermissionPoint } from '../shared/permissionPoints';

export interface RoleResolver {
  /** Resolve role names to the union of their permission points. */
  pointsFor(roles: string[]): Promise<Set<PermissionPoint>>;
  /** Drop the cache (call after any role create/update/delete). */
  invalidate(): void;
}

const TTL_MS = 30_000;
/** Compat alias: the legacy free-form 'admin' role maps to 'org_admin'. */
const LEGACY_ADMIN = { from: 'admin', to: 'org_admin' } as const;

let cache: Map<string, PermissionPoint[]> | null = null;
let expiresAt = 0;

async function load(): Promise<Map<string, PermissionPoint[]>> {
  const r = await pool.query<{ name: string; permissions: PermissionPoint[] }>(
    `SELECT name, permissions FROM roles`
  );
  const m = new Map<string, PermissionPoint[]>();
  for (const row of r.rows) m.set(row.name, row.permissions ?? []);
  return m;
}

async function resolveMap(): Promise<Map<string, PermissionPoint[]>> {
  const now = Date.now();
  if (!cache || now >= expiresAt) {
    cache = await load();
    expiresAt = now + TTL_MS;
  }
  return cache;
}

export const roleResolver: RoleResolver = {
  async pointsFor(roles: string[]): Promise<Set<PermissionPoint>> {
    const map = await resolveMap();
    const pts = new Set<PermissionPoint>();
    for (const raw of roles) {
      const name = raw === LEGACY_ADMIN.from ? LEGACY_ADMIN.to : raw;
      const p = map.get(name);
      if (p) for (const x of p) pts.add(x);
    }
    return pts;
  },
  invalidate(): void {
    cache = null;
    expiresAt = 0;
  },
};
