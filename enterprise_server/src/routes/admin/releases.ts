import { Hono } from 'hono';
import { z, ZodError } from 'zod';

import { auditStore } from '../../audit/auditStore';
import { requirePermission } from '../../auth/middleware';
import { appRelease, type ReleaseChangelog, type ReleaseInstallers } from '../../models/appRelease';
import { AuditAction } from '../../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../../shared/permissionPoints';

export const adminReleaseRoutes = new Hono();

const changeLogSchema = z
  .object({
    zh: z.object({ title: z.string(), content: z.array(z.string()) }).optional(),
    en: z.object({ title: z.string(), content: z.array(z.string()) }).optional(),
  })
  .default({});

const installerSchema = z.object({
  id: z.string().min(1),
  fileName: z.string().min(1),
  fileSize: z.number().int().positive(),
  sha256: z.string().min(1),
});

/** Per-platform file extension the installer upload route produces. Kept in sync
 * with PLATFORM_EXT in `src/routes/releaseInstallerUploads.ts`. */
const PLATFORM_EXT: Record<'macArm' | 'windowsX64', string> = {
  macArm: '.dmg',
  windowsX64: '.exe',
};

const installersSchema = z
  .object({
    macArm: installerSchema.optional(),
    windowsX64: installerSchema.optional(),
  })
  .default({});

const createSchema = z.object({
  orgId: z.string().min(1),
  version: z.string().min(1).max(64),
  published_at: z.string().datetime().optional(),
  changeLog: changeLogSchema,
  installers: installersSchema,
});

const patchSchema = z
  .object({
    changeLog: changeLogSchema.optional(),
    installers: installersSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .default({});

const httpError = (status: number, error: string, issues?: unknown): Response =>
  new Response(JSON.stringify({ error, ...(issues ? { issues } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

adminReleaseRoutes.get('/admin/releases', requirePermission(PP.VersionView), async (c) => {
  const orgId = c.req.query('orgId');
  if (!orgId) return httpError(400, 'orgId required');
  // Cross-tenant guard: the orgId query param must match the caller's token.
  const claims = c.get('claims');
  if (orgId !== claims.orgId) return httpError(400, 'org_mismatch');
  return c.json(await appRelease.listForAdmin(orgId));
});

adminReleaseRoutes.post('/admin/releases', requirePermission(PP.VersionCreate), async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return httpError(422, 'invalid_input', (parsed.error as ZodError).issues);
  }
  const body = parsed.data;
  const claims = c.get('claims');
  // Cross-tenant guard: the body's orgId must match the caller's token.
  if (body.orgId !== claims.orgId) return httpError(400, 'org_mismatch');
  // NL-4: per-platform extension must match the platform (case-insensitive).
  // A typo'd .exe under macArm or .dmg under windowsX64 would otherwise slip
  // past validation and produce a release whose download URL silently 404s
  // because the on-disk file's actual extension does not match the route's.
  for (const [platform, expected] of Object.entries(PLATFORM_EXT)) {
    const inst = body.installers[platform as keyof typeof body.installers];
    if (!inst) continue;
    if (!inst.fileName.toLowerCase().endsWith(expected)) {
      return httpError(400, 'bad_extension', { platform });
    }
  }
  // NL-4: every referenced installer id must already exist AND belong to the
  // caller's org. Without this an API typo can publish a release whose
  // installer URL silently 404s. Reuse `getInstallerMeta` so the same
  // cross-org rule used at download time also gates creation.
  for (const platform of ['macArm', 'windowsX64'] as const) {
    const inst = body.installers[platform];
    if (!inst) continue;
    const meta = await appRelease.getInstallerMeta(inst.id);
    if (!meta || meta.orgId !== body.orgId) {
      return httpError(400, 'installer_not_found', { platform });
    }
  }
  try {
    const { id } = await appRelease.add(body.orgId, {
      version: body.version,
      published_at: body.published_at,
      change_log: body.changeLog as ReleaseChangelog,
      installers: body.installers as ReleaseInstallers,
    });
    await auditStore.write({
      orgId: claims.orgId,
      userId: claims.sub,
      action: AuditAction.ReleaseCreate,
      targetType: 'release',
      targetId: id,
      payload: { version: body.version },
    });
    return c.json({ id });
  } catch (e) {
    const msg = (e as Error).message;
    if (/duplicate|unique|conflict/i.test(msg)) {
      return httpError(409, 'duplicate_version');
    }
    return httpError(500, msg);
  }
});

adminReleaseRoutes.patch('/admin/releases/:id', requirePermission(PP.VersionEdit), async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return httpError(422, 'invalid_input', (parsed.error as ZodError).issues);
  }
  const body = parsed.data;
  const claims = c.get('claims');
  const id = c.req.param('id');
  // NL-4: per-platform extension must match the platform (case-insensitive).
  // Same rule as POST; applies whenever PATCH replaces `installers`.
  if (body.installers) {
    for (const [platform, expected] of Object.entries(PLATFORM_EXT)) {
      const inst = body.installers[platform as keyof typeof body.installers];
      if (!inst) continue;
      if (!inst.fileName.toLowerCase().endsWith(expected)) {
        return httpError(400, 'bad_extension', { platform });
      }
    }
    for (const platform of ['macArm', 'windowsX64'] as const) {
      const inst = body.installers[platform];
      if (!inst) continue;
      const meta = await appRelease.getInstallerMeta(inst.id);
      if (!meta || meta.orgId !== claims.orgId) {
        return httpError(400, 'installer_not_found', { platform });
      }
    }
  }
  await appRelease.update(id, {
    change_log: body.changeLog as ReleaseChangelog | undefined,
    installers: body.installers as ReleaseInstallers | undefined,
    enabled: body.enabled,
  });
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.ReleaseUpdate,
    targetType: 'release',
    targetId: id,
  });
  return c.json({ ok: true });
});

adminReleaseRoutes.post('/admin/releases/:id/set-latest', requirePermission(PP.VersionPublish), async (c) => {
  const id = c.req.param('id');
  const claims = c.get('claims');
  try {
    await appRelease.setLatest(id);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'not_found') return httpError(404, 'not_found');
    if (msg === 'disabled') return httpError(422, 'release_disabled');
    if (msg === 'no_installer') return httpError(422, 'no_installer');
    return httpError(500, msg);
  }
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.ReleaseSetLatest,
    targetType: 'release',
    targetId: id,
  });
  return c.json({ ok: true });
});

adminReleaseRoutes.delete('/admin/releases/:id', requirePermission(PP.VersionRollback), async (c) => {
  const id = c.req.param('id');
  const claims = c.get('claims');
  await appRelease.remove(id);
  await auditStore.write({
    orgId: claims.orgId,
    userId: claims.sub,
    action: AuditAction.ReleaseDelete,
    targetType: 'release',
    targetId: id,
  });
  return c.json({ ok: true });
});