import { existsSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import { Readable } from 'node:stream';

import { Hono } from 'hono';

import { requireAuth } from '../auth/middleware';
import { releaseInstallerFile } from '../lib/stateDir';
import { appRelease } from '../models/appRelease';

export const releaseDownloadsRoutes = new Hono();
releaseDownloadsRoutes.use('/downloads/app-releases/*', requireAuth);

interface ByteRange {
  start: number;
  end: number;
}

/** Parse a `Range: bytes=...` header against `total`. Returns null for unsatisfiable, or undefined for absent/invalid (serve full). */
function parseByteRange(header: string | undefined, total: number): ByteRange | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined; // malformed -> serve full (200)
  const [, aRaw, bRaw] = m;
  let start: number;
  let end: number;
  if (aRaw === '' && bRaw !== '') {
    // suffix: last N bytes
    const suffix = Number(bRaw);
    if (suffix === 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = aRaw === '' ? 0 : Number(aRaw);
    end = bRaw === '' ? total - 1 : Math.min(Number(bRaw), total - 1);
  }
  if (start >= total || start > end) return null;
  return { start, end };
}

releaseDownloadsRoutes.get('/downloads/app-releases/:name', async (c) => {
  const claims = c.get('claims');
  const name = c.req.param('name');
  const ext = extname(name);
  const fileId = name.slice(0, name.length - ext.length);

  const meta = await appRelease.getInstallerMeta(fileId);
  if (!meta) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  if (meta.orgId !== claims.orgId) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
  }
  // The name's extension must match the stored file's extension.
  if (extname(meta.fileName).toLowerCase() !== ext.toLowerCase()) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }

  const filePath = releaseInstallerFile(fileId, ext);
  if (!existsSync(filePath)) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const total = statSync(filePath).size;
  const range = parseByteRange(c.req.header('range'), total);
  if (range === null) {
    return new Response(JSON.stringify({ error: 'range_not_satisfiable' }), { status: 416, headers: { 'content-type': 'application/json' } });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? total - 1;
  const length = end - start + 1;
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-length': String(length),
    'accept-ranges': 'bytes',
    'content-disposition': `attachment; filename="${meta.fileName}"`,
  };
  if (range) {
    headers['content-range'] = `bytes ${start}-${end}/${total}`;
  }

  const nodeStream = createReadStream(filePath, { start, end });
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new Response(webStream, { status: range ? 206 : 200, headers });
});
