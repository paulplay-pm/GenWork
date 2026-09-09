import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import { modelCatalog } from '../models/modelCatalog';

export const modelsRoutes = new Hono();
modelsRoutes.use('/models', requireAuth);

modelsRoutes.get('/models', async (c) => {
  const claims = c.get('claims');
  return c.json(await modelCatalog.list(claims.orgId));
});