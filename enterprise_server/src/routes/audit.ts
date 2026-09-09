import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import { auditStore } from '../audit/auditStore';

export const auditReceiveRoutes = new Hono();
auditReceiveRoutes.use('/audit', requireAuth);

auditReceiveRoutes.post('/audit', async (c) => {
  const body = z
    .object({
      events: z.array(
        z.object({
          action: z.string(),
          targetType: z.string().optional(),
          targetId: z.string().optional(),
          payload: z.unknown().optional(),
        })
      ),
    })
    .parse(await c.req.json());
  const claims = c.get('claims');
  for (const e of body.events) {
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: e.action,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      payload: e.payload,
    });
  }
  return c.json({ ok: true });
});