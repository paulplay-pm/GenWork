import { Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import {
  AGENT_COLUMNS,
  type AgentRow,
  mapAgent,
} from '../models/agentMarketplaceView';
import { AuditAction } from '../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../shared/permissionPoints';

const agentCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  identity: z.string().optional().default(''),
  system_prompt: z.string().optional().default(''),
  model: z.string().optional().default(''),
  thinking_level: z.string().optional().default(''),
  icon: z.string().optional().default(''),
  skill_ids: z.array(z.string().min(1)).optional().default([]),
  subagent_allow_agent_ids: z.array(z.string().min(1)).optional().default([]),
  allowed_roles: z.array(z.string().min(1)).min(1, { message: 'no_roles' }),
  enabled: z.boolean().optional(),
  about_you: z.string().optional().default(''),
  icon_color: z.number().int().min(0).optional().default(0),
  // IM channels the agent is enabled for (platform ids). All-off (empty) is
  // valid, so no min(1); no existence check — these are catalog ids, not rows.
  im_channels: z.array(z.string()).optional().default([]),
});

const agentPatchSchema = agentCreateSchema.partial();

async function assertSkillIdsExist(enabledOnly: boolean, ids: string[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const r = await pool.query<{ skill_id: string }>(
    `SELECT skill_id FROM skill_marketplace_skills WHERE skill_id = ANY($1)` +
    (enabledOnly ? ' AND enabled = TRUE' : ''),
    [ids],
  );
  const have = new Set(r.rows.map(x => x.skill_id));
  return ids.find(id => !have.has(id)) ?? null;
}

async function assertAgentIdsExist(ids: string[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const r = await pool.query<{ agent_id: string }>(
    `SELECT agent_id FROM agent_marketplace_agents WHERE agent_id = ANY($1)`, [ids]);
  const have = new Set(r.rows.map(x => x.agent_id));
  return ids.find(id => !have.has(id)) ?? null;
}

export const agentMarketplaceAdminRoutes = new Hono();
agentMarketplaceAdminRoutes.use('/api/admin/agent-marketplace/*', requireAuth);

agentMarketplaceAdminRoutes.post('/api/admin/agent-marketplace/agents', requirePermission(PP.AgentCreate), async (c) => {
  const parsed = agentCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  }
  const b = parsed.data;
  if (b.allowed_roles.length === 0) return c.json({ error: 'no_roles' }, 400);

  const missingSkill = await assertSkillIdsExist(true, b.skill_ids);
  if (missingSkill) return c.json({ error: 'unknown_skill', skill_id: missingSkill }, 400);
  const missingAgent = await assertAgentIdsExist(b.subagent_allow_agent_ids);
  if (missingAgent) return c.json({ error: 'unknown_subagent', agent_id: missingAgent }, 400);

  const agentId = `agent_${Date.now()}`;
  await pool.query(
    `INSERT INTO agent_marketplace_agents
       (agent_id, name, description, identity, system_prompt, model, thinking_level, icon,
        skill_ids, subagent_allow_agent_ids, allowed_roles, enabled, about_you, icon_color, im_channels)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15::jsonb)`,
    [agentId, b.name, b.description, b.identity, b.system_prompt, b.model, b.thinking_level, b.icon,
     JSON.stringify(b.skill_ids), JSON.stringify(b.subagent_allow_agent_ids), JSON.stringify(b.allowed_roles),
     b.enabled ?? true, b.about_you, b.icon_color, JSON.stringify(b.im_channels)],
  );
  const claims = c.get('claims');
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.AgentCreate, targetType: 'agent', targetId: agentId,
  });
  return c.json({ agent_id: agentId });
});

agentMarketplaceAdminRoutes.put('/api/admin/agent-marketplace/agents/:agentId', requirePermission(PP.AgentEdit), async (c) => {
  const id = c.req.param('agentId');
  const parsed = agentPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;

  if (b.skill_ids !== undefined) {
    const missing = await assertSkillIdsExist(true, b.skill_ids);
    if (missing) return c.json({ error: 'unknown_skill', skill_id: missing }, 400);
  }
  if (b.subagent_allow_agent_ids !== undefined) {
    const missing = await assertAgentIdsExist(b.subagent_allow_agent_ids);
    if (missing) return c.json({ error: 'unknown_subagent', agent_id: missing }, 400);
  }
  if (b.allowed_roles !== undefined && b.allowed_roles.length === 0) {
    return c.json({ error: 'no_roles' }, 400);
  }

  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.name !== undefined) push('name', b.name);
  if (b.description !== undefined) push('description', b.description);
  if (b.identity !== undefined) push('identity', b.identity);
  if (b.system_prompt !== undefined) push('system_prompt', b.system_prompt);
  if (b.model !== undefined) push('model', b.model);
  if (b.thinking_level !== undefined) push('thinking_level', b.thinking_level);
  if (b.icon !== undefined) push('icon', b.icon);
  if (b.skill_ids !== undefined) push('skill_ids', JSON.stringify(b.skill_ids));
  if (b.subagent_allow_agent_ids !== undefined) push('subagent_allow_agent_ids', JSON.stringify(b.subagent_allow_agent_ids));
  if (b.allowed_roles !== undefined) push('allowed_roles', JSON.stringify(b.allowed_roles));
  if (b.enabled !== undefined) push('enabled', b.enabled);
  if (b.about_you !== undefined) push('about_you', b.about_you);
  if (b.icon_color !== undefined) push('icon_color', b.icon_color);
  if (b.im_channels !== undefined) push('im_channels', JSON.stringify(b.im_channels));

  if (sets.length === 0) return c.json({ error: 'empty_patch' }, 400);
  const result = await pool.query(
    `UPDATE agent_marketplace_agents SET ${sets.join(', ')}, updated_at = NOW() WHERE agent_id = $1`, params);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);

  const claims = c.get('claims');
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.AgentUpdate, targetType: 'agent', targetId: id,
  });
  return c.body(null, 204);
});

agentMarketplaceAdminRoutes.delete('/api/admin/agent-marketplace/agents/:agentId', requirePermission(PP.AgentDelete), async (c) => {
  const id = c.req.param('agentId');
  // References cleanup: drop this id from every other agent's
  // subagent_allow_agent_ids using the Postgres JSONB `-` operator so the
  // desktop never sees a stale reference.
  const rehome = await pool.query(
    `UPDATE agent_marketplace_agents
        SET subagent_allow_agent_ids = subagent_allow_agent_ids - $1, updated_at = NOW()
      WHERE subagent_allow_agent_ids ? $1`, [id]);
  const result = await pool.query(`DELETE FROM agent_marketplace_agents WHERE agent_id = $1`, [id]);
  if (result.rowCount === 0) return c.json({ error: 'not_found' }, 404);

  const claims = c.get('claims');
  if (rehome.rowCount && rehome.rowCount > 0) {
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub,
      action: AuditAction.AgentUpdate, targetType: 'agent_references', targetId: id,
      payload: { affected: rehome.rowCount },
    });
  }
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.AgentDelete, targetType: 'agent', targetId: id,
  });
  return c.body(null, 204);
});

agentMarketplaceAdminRoutes.get('/api/admin/agent-marketplace/agents', requirePermission(PP.AgentView), async (c) => {
  const r = await pool.query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agent_marketplace_agents ORDER BY created_at DESC`,
  );
  return c.json(r.rows.map(mapAgent));
});

agentMarketplaceAdminRoutes.get('/api/admin/agent-marketplace/agents/:agentId/references', requirePermission(PP.AgentView), async (c) => {
  const id = c.req.param('agentId');
  const r = await pool.query<{ agent_id: string; name: string }>(
    `SELECT agent_id, name FROM agent_marketplace_agents
      WHERE subagent_allow_agent_ids ? $1 ORDER BY agent_id`, [id]);
  return c.json({ ids: r.rows.map(x => x.agent_id), names: r.rows.map(x => x.name) });
});
