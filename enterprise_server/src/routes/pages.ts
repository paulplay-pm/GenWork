import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { type Context, Hono } from 'hono';

import { readSessionCookie } from '../auth/cookieSession';
import { verifyToken } from '../auth/jwt';
import { pool } from '../db/pool';
import { htmlShareDir } from '../lib/stateDir';

export const pagesRoutes = new Hono();

/** Pull the raw JWT out of an `Authorization: Bearer <token>` header, if any. */
const bearerToken = (header: string | undefined): string | null =>
  header?.startsWith('Bearer ') ? (header.slice(7) || null) : null;

/**
 * A top-level human browser navigation to a share page. Browsers send
 * `Sec-Fetch-Mode: navigate` and an `Accept` that includes `text/html`; the
 * desktop client and API clients send a wildcard accept with no
 * sec-fetch-mode. We only redirect the former to the login page.
 */
const isBrowserNavigation = (c: Context): boolean => {
  if ((c.req.header('sec-fetch-mode') ?? '').toLowerCase() === 'navigate') return true;
  return /text\/html/i.test(c.req.header('accept') ?? '');
};

/**
 * Response for an org-restricted share the viewer is not (yet) authorized
 * for. Browsers are sent to the SPA login page (`/login?next=...`) so they
 * can sign in and be bounced back; API/desktop clients get a JSON 401 so
 * their existing handling is unchanged.
 */
const unauthorizedOrgResponse = (c: Context): Response => {
  if (isBrowserNavigation(c)) {
    const next = new URL(c.req.url).pathname;
    return new Response(null, { status: 302, headers: { location: `/login?next=${encodeURIComponent(next)}` } });
  }
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
};

const resolveShare = async (shareId: string) => {
  const r = await pool.query<{
    share_id: string;
    entry_file: string | null;
    user_id: string;
    org_id: string;
    access_mode: string | null;
    expires_at: Date | null;
  }>(
    `SELECT share_id, entry_file, user_id, org_id, access_mode, expires_at
       FROM html_shares WHERE share_id = $1`,
    [shareId]
  );
  return r.rows[0] ?? null;
};

/**
 * When `access_mode = 'org'`, the share is open to anyone in the same
 * organization. The JWT can arrive either as the desktop/API
 * `Authorization: Bearer` token or as the browser session cookie set by
 * `/auth/login`. Both are verified with the same `verifyToken`.
 *
 * Returns `null` if the share may be served, or a `Response` to short-circuit
 * with the appropriate status:
 *   - no/invalid token → 302 to `/login?next=...` for browsers, JSON 401 for
 *     API/desktop clients
 *   - valid token, wrong org → JSON 403
 */
const enforceOrgModeIfNeeded = async (
  c: Context,
  row: { org_id: string; access_mode: string | null },
): Promise<Response | null> => {
  if (row.access_mode !== 'org') return null;

  const token = bearerToken(c.req.header('authorization')) ?? readSessionCookie(c);
  let claims: { orgId?: string } | undefined;
  if (token) {
    try {
      claims = await verifyToken(token);
    } catch {
      claims = undefined;
    }
  }
  if (!claims || !claims.orgId) return unauthorizedOrgResponse(c);
  if (claims.orgId !== row.org_id) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  return null;
};

const safePath = (shareDir: string, rel: string): string | null => {
  const absoluteRoot = resolve(shareDir) + sep;
  const candidate = resolve(shareDir, rel);
  if (candidate !== resolve(shareDir) && !candidate.startsWith(absoluteRoot)) {
    return null;
  }
  return candidate;
};

const guessContentType = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'html':
    case 'htm':
      return 'text/html; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
    case 'js':
    case 'mjs':
      return 'text/javascript; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'ico':
      return 'image/x-icon';
    case 'txt':
      return 'text/plain; charset=utf-8';
    case 'pdf':
      return 'application/pdf';
    case 'woff':
      return 'font/woff';
    case 'woff2':
      return 'font/woff2';
    case 'ttf':
      return 'font/ttf';
    case 'otf':
      return 'font/otf';
    case 'wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
};

// GET /api/pages/:shareId  -> serves the entry file (index.html)
pagesRoutes.get('/api/pages/:shareId', async (c) => {
  const shareId = c.req.param('shareId');
  const row = await resolveShare(shareId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.expires_at && row.expires_at.getTime() < Date.now()) return c.json({ error: 'expired' }, 410);
  if (row.access_mode === 'org') {
    const forbidden = await enforceOrgModeIfNeeded(c, row);
    if (forbidden) return forbidden;
  }
  const entryFile = row.entry_file ?? 'index.html';
  const filePath = safePath(htmlShareDir(shareId), entryFile);
  if (!filePath) return c.json({ error: 'not_uploaded' }, 404);
  if (!existsSync(filePath)) return c.json({ error: 'not_uploaded' }, 404);
  let stat;
  try { stat = statSync(filePath); } catch { return c.json({ error: 'not_uploaded' }, 404); }
  if (stat.isDirectory()) return c.json({ error: 'not_uploaded' }, 404);
  return new Response(readFileSync(filePath), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
});

// GET /api/pages/:shareId/index.html  -> canonical entry file URL
pagesRoutes.get('/api/pages/:shareId/index.html', async (c) => {
  const shareId = c.req.param('shareId');
  const row = await resolveShare(shareId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.expires_at && row.expires_at.getTime() < Date.now()) return c.json({ error: 'expired' }, 410);
  if (row.access_mode === 'org') {
    const forbidden = await enforceOrgModeIfNeeded(c, row);
    if (forbidden) return forbidden;
  }
  const entryFile = row.entry_file ?? 'index.html';
  const filePath = safePath(htmlShareDir(shareId), entryFile);
  if (!filePath) return c.json({ error: 'not_uploaded' }, 404);
  if (!existsSync(filePath)) return c.json({ error: 'not_uploaded' }, 404);
  let stat;
  try { stat = statSync(filePath); } catch { return c.json({ error: 'not_uploaded' }, 404); }
  if (stat.isDirectory()) return c.json({ error: 'not_uploaded' }, 404);
  return new Response(readFileSync(filePath), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
});

// GET /api/pages/:shareId/assets/*  -> serve a file under the share dir.
// The wildcard tail is taken from c.req.path because Hono v4 does not
// populate c.req.param('*').
pagesRoutes.get('/api/pages/:shareId/assets/*', async (c) => {
  const shareId = c.req.param('shareId');
  const rest = c.req.path.replace(/^\/api\/pages\/[^/]+\/assets\//, '');
  const row = await resolveShare(shareId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.expires_at && row.expires_at.getTime() < Date.now()) return c.json({ error: 'expired' }, 410);
  if (row.access_mode === 'org') {
    const forbidden = await enforceOrgModeIfNeeded(c, row);
    if (forbidden) return forbidden;
  }
  const shareDir = htmlShareDir(shareId);
  const assetPath = safePath(shareDir, rest);
  if (!assetPath) return c.json({ error: 'bad_path' }, 400);
  if (!existsSync(assetPath)) return c.json({ error: 'not_found' }, 404);
  let stat;
  try { stat = statSync(assetPath); } catch { return c.json({ error: 'not_found' }, 404); }
  if (stat.isDirectory()) return c.json({ error: 'not_found' }, 404);
  return new Response(readFileSync(assetPath), {
    status: 200,
    headers: { 'content-type': guessContentType(rest) },
  });
});
