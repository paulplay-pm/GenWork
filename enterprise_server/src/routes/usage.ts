import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import { tokenUsage } from '../models/tokenUsage';

export const usageRoutes = new Hono();
usageRoutes.use('/usage/*', requireAuth);

usageRoutes.get('/usage/today', async (c) => {
  const claims = c.get('claims');
  return c.json(await tokenUsage.today(claims.sub));
});