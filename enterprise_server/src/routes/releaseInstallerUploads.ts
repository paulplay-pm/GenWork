import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { Hono } from 'hono';

import { requireAuth, requirePermission } from '../auth/middleware';
import { releaseInstallerFile, releaseInstallerUploadDir } from '../lib/stateDir';
import { PermissionPoint as PP } from '../shared/permissionPoints';

export const releaseInstallerUploadsRoutes = new Hono();
releaseInstallerUploadsRoutes.use('/admin/releases/installers/*', requireAuth, requirePermission(PP.VersionCreate));

/** Chunk size in bytes for resumable uploads (env-overridable for proxy limits). */
const CHUNK_SIZE = Number(process.env.RELEASE_INSTALLER_CHUNK_SIZE ?? 8 * 1024 * 1024);

type Platform = 'macArm' | 'windowsX64';
const PLATFORM_EXT: Record<Platform, string> = { macArm: '.dmg', windowsX64: '.exe' };

interface UploadMeta {
  orgId: string;
  platform: Platform;
  fileName: string;
  ext: string;
  expectedSize: number;
  totalAccepted: number;
}

const jsonError = (status: number, error: string, issues?: unknown): Response =>
  new Response(JSON.stringify({ error, ...(issues ? { issues } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function readMeta(uploadId: string): UploadMeta | null {
  const p = join(releaseInstallerUploadDir(uploadId), 'meta.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as UploadMeta;
  } catch {
    return null;
  }
}

function writeMeta(uploadId: string, meta: UploadMeta): void {
  const dir = releaseInstallerUploadDir(uploadId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
}

function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

releaseInstallerUploadsRoutes.post('/admin/releases/installers/init', async (c) => {
  const claims = c.get('claims');
  const raw = await c.req.json().catch(() => ({}));
  const platform = raw.platform as Platform;
  const fileName = typeof raw.fileName === 'string' ? raw.fileName.trim() : '';
  const fileSize = typeof raw.fileSize === 'number' ? raw.fileSize : NaN;
  if (platform !== 'macArm' && platform !== 'windowsX64') {
    return jsonError(400, 'bad_platform');
  }
  const ext = PLATFORM_EXT[platform];
  if (!fileName || !fileName.toLowerCase().endsWith(ext)) {
    return jsonError(400, 'bad_extension');
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return jsonError(400, 'bad_size');
  }
  const uploadId = randomUUID();
  writeMeta(uploadId, {
    orgId: claims.orgId,
    platform,
    fileName,
    ext,
    expectedSize: Math.floor(fileSize),
    totalAccepted: 0,
  });
  return c.json({ uploadId, chunkSize: CHUNK_SIZE });
});

releaseInstallerUploadsRoutes.put('/admin/releases/installers/:uploadId/chunks/:index', async (c) => {
  const claims = c.get('claims');
  const uploadId = c.req.param('uploadId');
  const index = Number(c.req.param('index'));
  if (!Number.isInteger(index) || index < 0) return jsonError(400, 'bad_order');

  const meta = readMeta(uploadId);
  if (!meta) return jsonError(404, 'not_found');
  if (meta.orgId !== claims.orgId) return jsonError(404, 'not_found');

  if (index > meta.totalAccepted) return jsonError(400, 'bad_order');

  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength === 0) return jsonError(400, 'empty_chunk');

  const dir = releaseInstallerUploadDir(uploadId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `chunk-${index}`), buf);

  if (index === meta.totalAccepted) {
    meta.totalAccepted = index + 1;
    writeMeta(uploadId, meta);
  }
  return c.json({ acceptedIndex: index, totalAccepted: meta.totalAccepted });
});

releaseInstallerUploadsRoutes.post('/admin/releases/installers/:uploadId/complete', async (c) => {
  const claims = c.get('claims');
  const uploadId = c.req.param('uploadId');
  const meta = readMeta(uploadId);
  if (!meta) return jsonError(404, 'not_found');
  if (meta.orgId !== claims.orgId) return jsonError(404, 'not_found');

  const dir = releaseInstallerUploadDir(uploadId);
  // Verify every chunk 0..totalAccepted-1 exists before touching the final file.
  for (let i = 0; i < meta.totalAccepted; i += 1) {
    if (!existsSync(join(dir, `chunk-${i}`))) {
      rmSync(dir, { recursive: true, force: true });
      return jsonError(400, 'bad_order');
    }
  }

  // Stream all chunks, in order, into the final file (never holds the whole file
  // in memory), and clean up staging.
  const finalPath = releaseInstallerFile(uploadId, meta.ext);
  mkdirSync(dirname(finalPath), { recursive: true });
  const out = createWriteStream(finalPath);
  try {
    for (let i = 0; i < meta.totalAccepted; i += 1) {
      const chunk = readFileSync(join(dir, `chunk-${i}`));
      if (!out.write(chunk)) {
        // back-pressure: wait for drain before the next chunk
        await new Promise<void>((resolve) => out.once('drain', resolve));
      }
    }
    out.end();
    await new Promise<void>((resolve, reject) => {
      out.once('finish', resolve);
      out.once('error', reject);
    });
  } catch {
    out.destroy();
    rmSync(finalPath, { force: true });
    return jsonError(500, 'write_failed');
  }

  rmSync(dir, { recursive: true, force: true });

  const totalBytes = statSync(finalPath).size;
  if (totalBytes !== meta.expectedSize) {
    rmSync(finalPath, { force: true });
    return jsonError(400, 'size_mismatch');
  }
  const sha256 = await sha256OfFile(finalPath);
  return c.json({ id: uploadId, fileName: meta.fileName, fileSize: totalBytes, sha256 });
});
