import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { descendantsOf, scopeApi } from '../auth/scopeResolver';
import { pool } from '../db/pool';
import {
  COLUMNS,
  type ConnectorRow,
  mapPublicConnector,
} from '../models/connectorView';
import { Role } from '../shared/enterpriseServerConstants';

export const mcpMarketplaceRoutes = new Hono();
mcpMarketplaceRoutes.use('/api/mcp-marketplace', requireAuth);

mcpMarketplaceRoutes.get('/api/mcp-marketplace', async (c) => {
  const claims = c.get('claims');
  const orgId = claims.orgId;
  const isSuperAdmin = (claims.roles ?? []).includes(Role.SuperAdmin);

  // The caller's own (leaf) department memberships.
  const callerDepts = isSuperAdmin ? [] : await scopeApi.deptIdsFor(orgId, claims.sub);
  const callerSet = new Set(callerDepts);

  // All dept paths in the org, once, to expand a connector's granted depts
  // to their subtree.
  const deptRows = await pool.query<{ id: string; path: string }>(
    `SELECT id, path FROM departments WHERE org_id = $1`, [orgId]);
  const deptPath = new Map(deptRows.rows.map((r) => [r.id, r.path]));

  const r = await pool.query<ConnectorRow>(
    `SELECT ${COLUMNS} FROM mcp_connectors WHERE org_id = $1 AND enabled = TRUE`, [orgId]);

  const visible = r.rows.filter((row) => {
    if (isSuperAdmin) return true;
    if (row.scope?.allCompany) return true;
    if ((row.scope?.userIds ?? []).includes(claims.sub)) return true;
    // A connector granted to a parent dept is visible to any user in that
    // dept's subtree: expand the GRANTED depts to their descendants and check
    // whether the caller's own depts intersect that subtree.
    const grantedSubtree = descendantsOf(row.scope?.deptIds ?? [], deptPath);
    for (const d of callerSet) if (grantedSubtree.has(d)) return true;
    return false;
  });

  const catIds = Array.from(new Set(visible.map((v) => v.category_id).filter(Boolean))) as string[];
  const cats = catIds.length === 0
    ? { rows: [] as { id: string; name: string }[] }
    : await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM mcp_connector_categories WHERE org_id = $1 AND id = ANY($2) ORDER BY name`,
        [orgId, catIds]);

  return c.json({
    categories: cats.rows.map((cat) => ({ id: cat.id, name_zh: cat.name, name_en: cat.name })),
    servers: visible.map(mapPublicConnector),
  });
});
