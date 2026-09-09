import { existsSync,readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';

import { runMigrations } from './db/migrate';
import { sweepStaleReleaseUploads } from './lib/stateDir';
import { seedBuiltinKitsForAllOrgs } from './org/builtinKits';
import { seedBuiltinProvidersForAllOrgs } from './org/builtinProviders';
import { archiveRoutes } from './routes/admin/archives';
import { adminAuditRoutes } from './routes/admin/audit';
import { catalogRoutes } from './routes/admin/catalog';
import { deptRoutes } from './routes/admin/departments';
import { adminModelRoutes } from './routes/admin/models';
import { adminProviderKeyRoutes } from './routes/admin/providerKeys';
import { adminReleaseRoutes } from './routes/admin/releases';
import { roleAdminRoutes } from './routes/admin/roles';
import { adminSsoBindingRoutes } from './routes/admin/ssoBindings';
import { adminUserRoutes } from './routes/admin/users';
import { agentMarketplaceRoutes } from './routes/agentMarketplace';
import { agentMarketplaceAdminRoutes } from './routes/agentMarketplaceAdmin';
import { auditReceiveRoutes } from './routes/audit';
import { authRoutes } from './routes/auth';
import { ssoBindRoutes } from './routes/auth/ssoBind';
import { changePasswordRoutes } from './routes/changePassword';
import { enterpriseModelsRoutes } from './routes/enterpriseModels';
import { htmlSharesRoutes } from './routes/htmlShares';
import { kitCatalogRoutes } from './routes/kitCatalog';
import { kitCatalogAdminRoutes } from './routes/kitCatalogAdmin';
import { mcpConnectorsRoutes } from './routes/mcpConnectors';
import { mcpMarketplaceRoutes } from './routes/mcpMarketplace';
import { mcpSubmissionsRoutes } from './routes/mcpSubmissions';
import { meRoutes } from './routes/me';
import { meSsoBindingRoutes } from './routes/me/ssoBinding';
import { modelsRoutes } from './routes/models';
import { pagesRoutes } from './routes/pages';
import { proxyRoutes } from './routes/proxy';
import { releaseDownloadsRoutes } from './routes/releaseDownloads';
import { releaseInstallerUploadsRoutes } from './routes/releaseInstallerUploads';
import { roleVocabularyRoutes } from './routes/roleVocabulary';
import { setupAliasRoutes } from './routes/setupAlias';
import { shareDeploymentsRoutes } from './routes/shareDeployments';
import { skillMarketplaceRoutes } from './routes/skillMarketplace';
import { skillMarketplaceAdminRoutes } from './routes/skillMarketplaceAdmin';
import { skillSubmissionsRoutes } from './routes/skillSubmissions';
import { ssoRoutes } from './routes/sso';
import { ssoLogoUploadRoutes } from './routes/ssoLogoUpload';
import { updatesRoutes } from './routes/updates';
import { uploadRoutes } from './routes/uploads';
import { usageRoutes } from './routes/usage';

export function buildApp(): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/', authRoutes);
  app.route('/', meRoutes);
  app.route('/', meSsoBindingRoutes);
  app.route('/', mcpMarketplaceRoutes);
  // Mounted BEFORE mcpConnectorsRoutes: Hono resolves overlapping patterns in
  // registration order, so the static GET /admin/mcp-connectors/submissions
  // must beat mcpConnectors' GET /admin/mcp-connectors/:id.
  app.route('/', mcpSubmissionsRoutes);
  app.route('/', mcpConnectorsRoutes);
  app.route('/', skillMarketplaceRoutes);
  app.route('/', kitCatalogRoutes);
  app.route('/', agentMarketplaceRoutes);
  // Mounted BEFORE skillMarketplaceAdminRoutes: mirrors the
  // mcpSubmissions-before-mcpConnectors ordering (registration order wins for
  // overlapping patterns).
  app.route('/', skillSubmissionsRoutes);
  app.route('/', skillMarketplaceAdminRoutes);
  app.route('/', kitCatalogAdminRoutes);
  app.route('/', agentMarketplaceAdminRoutes);
  app.route('/', roleVocabularyRoutes);
  app.route('/', modelsRoutes);
  app.route('/', usageRoutes);
  app.route('/', auditReceiveRoutes);
  app.route('/', proxyRoutes);
  app.route('/', deptRoutes);
  app.route('/', adminUserRoutes);
  app.route('/', adminProviderKeyRoutes);
  app.route('/', adminModelRoutes);
  app.route('/', roleAdminRoutes);
  app.route('/', adminAuditRoutes);
  app.route('/', archiveRoutes);
  app.route('/', catalogRoutes);
  app.route('/', updatesRoutes);
  app.route('/', releaseDownloadsRoutes);
  app.route('/', releaseInstallerUploadsRoutes);
  app.route('/', adminReleaseRoutes);
  app.route('/api/setup', setupAliasRoutes);
  app.route('/', changePasswordRoutes);
  app.route('/', enterpriseModelsRoutes);
  app.route('/', htmlSharesRoutes);
  app.route('/', shareDeploymentsRoutes);
  app.route('/', uploadRoutes);
  app.route('/', pagesRoutes);
  app.route('/', ssoRoutes);
  app.route('/', ssoBindRoutes);
  // The web /me/sso-binding/start flow's post-bind callback lives at
  // /auth/sso/callback (the same URL the org admin already registered
  // in the IdP developer console for the login flow) and is handled by
  // ssoRoutes — see sso.ts's GET /auth/sso/callback, which routes on
  // the parked context's returnTarget === 'web' to render the post-bind
  // HTML (localStorage token + sessionStorage.ssoBindJustSucceeded +
  // redirect to /account/sso-bindings). No separate /auth/sso/bind-callback
  // route exists: the org admin only registers one web URL with the IdP,
  // and any second URL would trigger Feishu 20029 "redirect_uri mismatch".
  app.route('/', adminSsoBindingRoutes);
  app.route('/', ssoLogoUploadRoutes);

  // Static SSO logos:
  //  - /sso-logos/<file>          → built-in assets shipped in web/public/
  //    (Vite copies them into web-dist/sso-logos/ in prod; vite serves
  //    them directly in dev).
  //  - /sso-logos/uploads/<file>  → per-connection uploads written at
  //    runtime to <stateDir>/sso-logos/uploads/. Mounted UNCONDITIONALLY
  //    (not gated on the web build) so dev and prod both serve the
  //    upload directory.
  //
  // Without these routes the SPA fallback would return index.html for
  // image fetches and the <img> tags on the login page would render
  // broken.
  const imageMime: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  app.get('/sso-logos/uploads/:file', async (c) => {
    const file = c.req.param('file');
    // Reject path-traversal characters and parent-directory references.
    if (file.includes('..') || file.includes('/') || file.includes('\\')) return c.notFound();
    const { ssoLogoUploadDir } = await import('./lib/stateDir');
    const fullPath = join(ssoLogoUploadDir(), file);
    if (!existsSync(fullPath)) return c.notFound();
    const buf = readFileSync(fullPath);
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    return c.body(buf, 200, { 'content-type': imageMime[ext] ?? 'application/octet-stream' });
  });

  // Static SPA (web-dist/) + history fallback. Only mounted when the build
  // output exists; otherwise the API-only server still works. The wildcard
  // must come after every API route so /api/* and /admin/* are never
  // shadowed by the SPA fallback.
  const webDist = process.env.WEB_DIST_DIR ?? join(process.cwd(), 'web-dist');
  const indexHtml = join(webDist, 'index.html');
  const assetsDir = join(webDist, 'assets');

  if (existsSync(indexHtml)) {
    app.get('/assets/*', async (c) => {
      const rel = c.req.path.replace(/^\/assets\//, '');
      const file = join(assetsDir, rel);
      if (!existsSync(file)) return c.notFound();
      const buf = readFileSync(file);
      const ext = rel.split('.').pop() ?? '';
      const mime = ext === 'js' ? 'text/javascript' : ext === 'css' ? 'text/css' : 'application/octet-stream';
      return c.body(buf, 200, { 'content-type': mime });
    });
    // IM channel logos (web/public/im-logos/) referenced by absolute /im-logos/*
    // paths in the SPA. Without this route they fall through to the wildcard
    // below and return index.html, so the <img> tags render broken.
    const imLogosDir = join(webDist, 'im-logos');
    const imageMime: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      svg: 'image/svg+xml',
      webp: 'image/webp',
    };
    app.get('/im-logos/*', async (c) => {
      const rel = c.req.path.replace(/^\/im-logos\//, '');
      const file = join(imLogosDir, rel);
      if (!existsSync(file)) return c.notFound();
      const buf = readFileSync(file);
      const ext = rel.split('.').pop()?.toLowerCase() ?? '';
      const mime = imageMime[ext] ?? 'application/octet-stream';
      return c.body(buf, 200, { 'content-type': mime });
    });
    // Brand logo (web/public/brand/) referenced by absolute /brand/* paths in
    // the SPA. Without this route it would fall through to the wildcard below
    // and return index.html, so the <img> tags render broken.
    const brandDir = join(webDist, 'brand');
    app.get('/brand/*', async (c) => {
      const rel = c.req.path.replace(/^\/brand\//, '');
      const file = join(brandDir, rel);
      if (!existsSync(file)) return c.notFound();
      const buf = readFileSync(file);
      const ext = rel.split('.').pop()?.toLowerCase() ?? '';
      const mime = imageMime[ext] ?? 'application/octet-stream';
      return c.body(buf, 200, { 'content-type': mime });
    });
    // Built-in SSO logos (web/public/sso-logos/) referenced as
    // /sso-logos/<file> in the public /auth/sso/providers response when
    // the connection has no per-connection override. Without this route
    // the SPA fallback returns index.html and the login page icons break.
    // /sso-logos/uploads/<file> is served by the unconditional route
    // above (mounted before this block) and falls through here as
    // /sso-logos/<file> with name 'uploads' — that case returns 404
    // because there is no file named `uploads` in ssoLogosDir.
    const ssoLogosDir = join(webDist, 'sso-logos');
    app.get('/sso-logos/:file', async (c) => {
      const file = c.req.param('file');
      if (file.includes('..') || file.includes('/') || file.includes('\\')) return c.notFound();
      const full = join(ssoLogosDir, file);
      if (!existsSync(full)) return c.notFound();
      const buf = readFileSync(full);
      const ext = file.split('.').pop()?.toLowerCase() ?? '';
      return c.body(buf, 200, { 'content-type': imageMime[ext] ?? 'application/octet-stream' });
    });
    app.get('*', (c) => {
      return c.html(readFileSync(indexHtml, 'utf8'));
    });
  }

  return app;
}

export async function serve(): Promise<void> {
  await runMigrations();
  // Spec §6: best-effort GC of chunked-upload staging older than 24h. Wrapped
  // because it touches the on-disk state dir; failures must never block the
  // server from booting. `sweepStaleReleaseUploads` already catches per-dir
  // errors; this catches startup-time surprises.
  try {
    const n = await sweepStaleReleaseUploads();
    if (n > 0) console.log(`[ReleaseUploads] swept ${n} stale staging dir(s)`);
  } catch (e) {
    console.warn('[ReleaseUploads] staging GC failed', e);
  }
  await seedBuiltinProvidersForAllOrgs();
  await seedBuiltinKitsForAllOrgs();
  const app = buildApp();
  const port = Number(process.env.PORT ?? '8787');
  // node:http serve：避免再拉 @hono/node-server
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) headers.set(k, v.join(','));
      else if (typeof v === 'string') headers.set(k, v);
    }
    let body: Uint8Array | undefined;
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = new Uint8Array(Buffer.concat(chunks));
    }
    const method = req.method ?? 'GET';
    const honoRes = await app.fetch(new Request(url, { method, headers, body }));
    res.statusCode = honoRes.status;
    honoRes.headers.forEach((v, k) => res.setHeader(k, v));
    // Stream rangeable responses (release installer downloads) so a hundreds-of-MB
    // file is not buffered in memory. Gated on the Accept-Ranges header the
    // download route sets; every other route keeps the buffered path unchanged.
    if (honoRes.headers.get('accept-ranges') && honoRes.body) {
      const { Readable } = await import('node:stream');
      const readable = Readable.fromWeb(honoRes.body as ReadableStream<Uint8Array>);
      readable.on('error', (err) => {
        console.error('[ReleaseDownload] stream error', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'download_failed' }));
        } else {
          res.end();
        }
      });
      readable.pipe(res);
      return;
    }
    const buf = Buffer.from(await honoRes.arrayBuffer());
    res.end(buf);
  });
  server.listen(port, () => {
    console.log(`enterprise_server listening on :${port}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  serve().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}