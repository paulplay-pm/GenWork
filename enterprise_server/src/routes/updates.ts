import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { appRelease } from '../models/appRelease';

export const updatesRoutes = new Hono();
updatesRoutes.use('/updates/latest', requireAuth);

updatesRoutes.get('/updates/latest', async (c) => {
  const claims = c.get('claims');
  const release = await appRelease.getLatestEnabled(claims.orgId);
  if (!release) {
    return c.json({ latest: false });
  }
  const origin = new URL(c.req.url).origin;
  // A platform key is emitted only when that platform has an installer; the
  // desktop's pickPlatformUrl returns null for absent platforms → "no update".
  const installers = release.installers ?? {};
  const toEntry = (raw: { title?: unknown; content?: unknown } | undefined) => ({
    title: typeof raw?.title === 'string' ? raw.title : '',
    content: Array.isArray(raw?.content) ? raw.content.filter((x) => typeof x === 'string') : [],
  });
  return c.json({
    latest: true,
    version: release.version,
    date: new Date(release.published_at).toISOString(),
    changeLog: {
      zh: toEntry((release.change_log as Record<string, { title?: string; content?: string[] }>).zh),
      en: toEntry((release.change_log as Record<string, { title?: string; content?: string[] }>).en),
    },
    ...(installers.macArm
      ? { macArm: { url: `${origin}/downloads/app-releases/${installers.macArm.id}.dmg` } }
      : {}),
    ...(installers.windowsX64
      ? { windowsX64: { url: `${origin}/downloads/app-releases/${installers.windowsX64.id}.exe` } }
      : {}),
  });
});
