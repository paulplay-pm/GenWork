import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';
import { z } from 'zod';

import { requireAuth } from '../auth/middleware';
import { pool } from '../db/pool';
import { stateDir } from '../lib/stateDir';

interface DeploymentRow {
  deployment_id: string;
  share_id: string;
  org_id: string;
  user_id: string;
  source_sha256: string;
  manifest_json: unknown;
  storage_path: string;
  status: string;
  deployment_kind: string;
  failure_code: string | null;
  failure_message: string | null;
  persistence_json: unknown;
  events_json: unknown;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
}

interface HtmlShareRow {
  share_id: string;
  org_id: string;
  user_id: string;
  source_type: string | null;
  client_source_key: string | null;
  access_mode: string;
  expires_at: Date | null;
  title: string;
}

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  deploymentKind: z.enum(['node_service', 'static_site']),
  runtimeLanguage: z.string(),
  projectRootName: z.string(),
});

/**
 * Whitelist the access modes the desktop may set. Anything else
 * (typo'd value, empty string, legacy clients) collapses to 'code'.
 * Mirrors the desktop's `HtmlShareAccessMode` in
 * `src/shared/htmlShare/constants.ts`.
 */
const normalizeAccessMode = (raw: string | undefined): 'code' | 'public' | 'org' => {
  if (raw === 'public' || raw === 'org') return raw;
  return 'code';
};

async function ensureShareDeploymentDir(orgId: string): Promise<string> {
  const root = join(stateDir(), 'share_deployments', orgId);
  await mkdir(root, { recursive: true });
  return root;
}

function deploymentResponse(row: DeploymentRow, share: HtmlShareRow | null): Record<string, unknown> {
  const manifest = (row.manifest_json ?? {}) as Record<string, unknown>;
  const resp: Record<string, unknown> = {
    deploymentId: row.deployment_id,
    shareId: row.share_id,
    accessMode: share?.access_mode ?? 'code',
    deploymentStatus: row.status,
    deploymentKind: row.deployment_kind,
    sourceSha256: row.source_sha256,
    sourceArchiveBytes: 0,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    runtimeLanguage: typeof manifest['runtimeLanguage'] === 'string' ? manifest['runtimeLanguage'] : undefined,
  };
  return resp;
}

async function loadShareForOrg(shareId: string, orgId: string): Promise<HtmlShareRow | null> {
  const r = await pool.query<HtmlShareRow>(
    `SELECT share_id, org_id, user_id, source_type, client_source_key, access_mode, expires_at, title
       FROM html_shares WHERE share_id = $1 AND org_id = $2`,
    [shareId, orgId]
  );
  return r.rows[0] ?? null;
}

async function loadDeploymentById(deploymentId: string, orgId: string): Promise<DeploymentRow | null> {
  const r = await pool.query<DeploymentRow>(
    `SELECT deployment_id, share_id, org_id, user_id, source_sha256, manifest_json,
            storage_path, status, deployment_kind, failure_code, failure_message,
            persistence_json, events_json, created_at, updated_at, expires_at
       FROM share_deployments WHERE deployment_id = $1 AND org_id = $2`,
    [deploymentId, orgId]
  );
  return r.rows[0] ?? null;
}

async function loadDeploymentByShareId(shareId: string, orgId: string): Promise<DeploymentRow | null> {
  const r = await pool.query<DeploymentRow>(
    `SELECT deployment_id, share_id, org_id, user_id, source_sha256, manifest_json,
            storage_path, status, deployment_kind, failure_code, failure_message,
            persistence_json, events_json, created_at, updated_at, expires_at
       FROM share_deployments
       WHERE share_id = $1 AND org_id = $2
       ORDER BY created_at DESC LIMIT 1`,
    [shareId, orgId]
  );
  return r.rows[0] ?? null;
}

export const shareDeploymentsRoutes = new Hono();
shareDeploymentsRoutes.use('/api/share-deployments/*', requireAuth);
shareDeploymentsRoutes.use('/api/html-shares/*', requireAuth);

async function persistDeployment(
  deploymentKind: 'node_service' | 'static_site',
  form: FormData,
  claims: { orgId: string; sub: string }
): Promise<Response> {
  const shareId = form.get('sessionId')?.toString() ?? '';
  const accessModeRaw = form.get('accessMode')?.toString() ?? 'code';
  const clientSourceKey = form.get('clientSourceKey')?.toString() ?? '';
  const sourceSha256 = form.get('sourceSha256')?.toString() ?? '';
  const manifestRaw = form.get('manifest')?.toString() ?? '';
  const archiveFile = form.get('sourceArchive');

  let manifestParsed: z.infer<typeof manifestSchema>;
  try {
    const json: unknown = JSON.parse(manifestRaw);
    const result = manifestSchema.safeParse(json);
    if (!result.success) {
      return new Response(JSON.stringify({ error: 'invalid_manifest', issues: result.error.issues }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    manifestParsed = result.data;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_manifest' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (manifestParsed.deploymentKind !== deploymentKind) {
    return new Response(JSON.stringify({ error: 'manifest_kind_mismatch' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (!shareId || !clientSourceKey || !sourceSha256) {
    return new Response(JSON.stringify({ error: 'missing_required_fields' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const accessMode = normalizeAccessMode(accessModeRaw);
  if (!(archiveFile instanceof File)) {
    return new Response(JSON.stringify({ error: 'missing_archive' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const share = await loadShareForOrg(shareId, claims.orgId);
  if (!share) {
    return new Response(JSON.stringify({ error: 'share_not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const buffer = Buffer.from(await archiveFile.arrayBuffer());
  const actualSha = createHash('sha256').update(buffer).digest('hex');
  if (actualSha !== sourceSha256) {
    return new Response(JSON.stringify({ error: 'sha256_mismatch' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const deploymentId = randomUUID();
  const dir = await ensureShareDeploymentDir(claims.orgId);
  const storagePath = join(dir, `${deploymentId}.zip`);
  await writeFile(storagePath, buffer);

  const inserted = await pool.query<DeploymentRow>(
    `INSERT INTO share_deployments
       (deployment_id, org_id, user_id, share_id, source_sha256,
        manifest_json, storage_path, deployment_kind)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING deployment_id, share_id, org_id, user_id, source_sha256, manifest_json,
               storage_path, status, deployment_kind, failure_code, failure_message,
               persistence_json, events_json, created_at, updated_at, expires_at`,
    [deploymentId, claims.orgId, claims.sub, shareId, sourceSha256, manifestRaw, storagePath, deploymentKind]
  );

  if (accessMode === 'public' && share.access_mode !== 'public') {
    await pool.query(
      `UPDATE html_shares SET access_mode = 'public' WHERE share_id = $1 AND org_id = $2`,
      [shareId, claims.orgId]
    );
    share.access_mode = 'public';
  }

  const row = inserted.rows[0];
  const response = deploymentResponse(row, share);
  response.sourceArchiveBytes = buffer.byteLength;
  return new Response(JSON.stringify({ code: 0, data: response }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

shareDeploymentsRoutes.post('/api/share-deployments/node', async (c) => {
  const claims = c.get('claims');
  const form = await c.req.formData();
  return persistDeployment('node_service', form, claims);
});

shareDeploymentsRoutes.post('/api/share-deployments/static', async (c) => {
  const claims = c.get('claims');
  const form = await c.req.formData();
  return persistDeployment('static_site', form, claims);
});

shareDeploymentsRoutes.get('/api/share-deployments/:deploymentId', async (c) => {
  const claims = c.get('claims');
  const deploymentId = c.req.param('deploymentId');
  const row = await loadDeploymentById(deploymentId, claims.orgId);
  if (!row) {
    return c.json({ error: 'not_found' }, 404);
  }
  const share = await loadShareForOrg(row.share_id, claims.orgId);
  const response = deploymentResponse(row, share);
  response.sourceArchiveBytes = 0;
  return c.json({ code: 0, data: response });
});

shareDeploymentsRoutes.get('/api/share-deployments/:deploymentId/persistence', async (c) => {
  const claims = c.get('claims');
  const deploymentId = c.req.param('deploymentId');
  const row = await loadDeploymentById(deploymentId, claims.orgId);
  if (!row) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ persistence: row.persistence_json ?? null });
});

shareDeploymentsRoutes.get('/api/share-deployments/:deploymentId/persistence/archive', async (c) => {
  const claims = c.get('claims');
  const deploymentId = c.req.param('deploymentId');
  const row = await loadDeploymentById(deploymentId, claims.orgId);
  if (!row) {
    return c.json({ error: 'not_found' }, 404);
  }
  const archivePath = join(stateDir(), 'share_deployments', claims.orgId, `${deploymentId}.archive.zip`);
  if (!existsSync(archivePath)) {
    return c.body(null, 204);
  }
  const buf = await readFile(archivePath);
  return c.body(buf, 200, { 'content-type': 'application/zip' });
});

shareDeploymentsRoutes.get('/api/html-shares/:shareId/deployment', async (c) => {
  const claims = c.get('claims');
  const shareId = c.req.param('shareId');
  const share = await loadShareForOrg(shareId, claims.orgId);
  if (!share) {
    return c.json({ error: 'share_not_found' }, 404);
  }
  const row = await loadDeploymentByShareId(shareId, claims.orgId);
  if (!row) {
    return c.json({ error: 'not_found' }, 404);
  }
  const response = deploymentResponse(row, share);
  response.sourceArchiveBytes = 0;
  return c.json({ code: 0, data: response });
});

shareDeploymentsRoutes.patch('/api/html-shares/:shareId/access-mode', async (c) => {
  const claims = c.get('claims');
  const shareId = c.req.param('shareId');
  const body = await c.req.json<{ accessMode?: string }>().catch(() => ({} as { accessMode?: string }));
  const accessMode = normalizeAccessMode(body.accessMode);
  const r = await pool.query(
    `UPDATE html_shares SET access_mode = $1
       WHERE share_id = $2 AND org_id = $3`,
    [accessMode, shareId, claims.orgId]
  );
  if (r.rowCount === 0) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ accessMode });
});

shareDeploymentsRoutes.patch('/api/html-shares/:shareId/status', async (c) => {
  const claims = c.get('claims');
  const shareId = c.req.param('shareId');
  const body = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }));
  const status = body.status === 'disabled' ? 'disabled' : 'live';
  const r = await pool.query<{ share_id: string }>(
    `UPDATE html_shares SET status = $1
       WHERE share_id = $2 AND org_id = $3
       RETURNING share_id`,
    [status, shareId, claims.orgId]
  );
  if (r.rowCount === 0) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ status });
});