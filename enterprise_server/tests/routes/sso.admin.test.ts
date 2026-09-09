// enterprise_server/tests/routes/sso.admin.test.ts
// Admin CRUD routes for SSO connections (Task 11).
//
// R16: permission resolution is LIVE (roleResolver reads the `roles` table
// through a 30s module-level cache), not from the JWT. Migrations 029 + 037
// seed the builtin `org_admin` role with sso:view/create/edit, so a JWT with
// roles: ['org_admin'] passes requirePermission(PP.Sso*) out of the box.
// We call roleResolver.invalidate() in beforeEach so the resolver re-reads
// the freshly-migrated roles instead of a stale cache from a prior file.
import '../helpers/setupEnv';

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { roleResolver } from '../../src/auth/roleResolver';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { ssoLogoUploadDir } from '../../src/lib/stateDir';
import { ssoRoutes } from '../../src/routes/sso';
import { ssoLogoUploadRoutes } from '../../src/routes/ssoLogoUpload';

function buildApp(): Hono {
  const a = new Hono();
  a.route('/', ssoRoutes);
  a.route('/', ssoLogoUploadRoutes);
  return a;
}
async function tok(orgId: string, roles: string[]): Promise<string> {
  return signToken({ sub: 'admin', orgId, roles });
}

describe('routes/sso — admin CRUD', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    // org_admin permissions already include sso:* from migration 037 —
    // no manual role seeding needed (R16). Drop the resolver cache so the
    // live role table is re-read for this worker.
    roleResolver.invalidate();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','A'),('o2','B')`);
  });

  test('403 without sso:view', async () => {
    const a = buildApp();
    const t = await tok('o1', ['member']);
    const r = await a.request('/admin/sso-connections', { headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(403);
  });

  test('create + get returns masked secret only', async () => {
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const create = await a.request('/admin/sso-connections', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1', name: 'Okta', providerType: 'generic-oidc', protocol: 'oidc',
        authorizeUrl: 'https://idp/a', tokenUrl: 'https://idp/t', userinfoUrl: 'https://idp/u',
        clientId: 'cid', clientSecret: 'super-secret-key', scopes: 'openid email',
        identityIdField: 'sub', emailField: 'email', emailDomainWhitelist: [], enabled: true, sortOrder: 0,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };
    const get = await a.request(`/admin/sso-connections/${created.id}`, { headers: { authorization: `Bearer ${t}` } });
    const j = (await get.json()) as Record<string, unknown>;
    expect(j.name).toBe('Okta');
    expect(j.client_secret_masked).toMatch(/^sup/);
    expect((j as Record<string, unknown>).client_secret_encrypted).toBeUndefined();
    expect((j as Record<string, unknown>).client_secret).toBeUndefined();
  });

  test('create round-trips the logo via the upload endpoint (no logoUrl in JSON body)', async () => {
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const create = await a.request('/admin/sso-connections', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'o1', name: 'Okta', providerType: 'generic-oidc', protocol: 'oidc',
        authorizeUrl: 'https://idp/a', tokenUrl: 'https://idp/t', userinfoUrl: 'https://idp/u',
        clientId: 'cid', scopes: 'openid email',
        identityIdField: 'sub', emailField: 'email', emailDomainWhitelist: [], enabled: true, sortOrder: 0,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };
    // logo_url starts NULL.
    const initial = await a.request(`/admin/sso-connections/${created.id}`, { headers: { authorization: `Bearer ${t}` } });
    const j0 = (await initial.json()) as Record<string, unknown>;
    expect(j0.logo_url).toBeNull();
    // Upload a logo through the multipart endpoint.
    const { body: fileBody, contentType } = buildMultipart('logo', 'okta.png', 'image/png', TINY_PNG);
    const up = await a.request(`/admin/sso-connections/${created.id}/logo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': contentType, 'content-length': String(fileBody.length) },
      body: fileBody,
    });
    expect(up.status).toBe(200);
    const upJ = (await up.json()) as { logoUrl: string };
    expect(upJ.logoUrl).toBe(`/sso-logos/uploads/${created.id}.png`);
    // Re-fetch and confirm logo_url is now the uploaded path.
    const after = await a.request(`/admin/sso-connections/${created.id}`, { headers: { authorization: `Bearer ${t}` } });
    const j1 = (await after.json()) as Record<string, unknown>;
    expect(j1.logo_url).toBe(`/sso-logos/uploads/${created.id}.png`);
  });

  test('cross-org isolation: o2 admin cannot see o1 connection', async () => {
    // create one in o1
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url)
       VALUES ('c1','o1','Acme','generic-oidc','oidc','https://x/a','https://x/t')`
    );
    const a = buildApp();
    const t = await tok('o2', ['org_admin']);
    const r = await a.request(`/admin/sso-connections/c1`, { headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(404);
  });

  test('patch with blank secret keeps stored secret (mask unchanged)', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, authorize_url, token_url, client_secret_encrypted, client_secret_masked)
       VALUES ('c1','o1','Okta','generic-oidc','oidc','https://x/a','https://x/t','CIPHER','okt••••cret')`
    );
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const r = await a.request('/admin/sso-connections/c1', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sortOrder: 5 }),
    });
    expect(r.status).toBe(200);
    const after = await testPool.query<{ client_secret_masked: string | null; sort_order: number }>(`SELECT client_secret_masked, sort_order FROM sso_connections WHERE id='c1'`);
    expect(after.rows[0]!.client_secret_masked).toBe('okt••••cret');
    expect(after.rows[0]!.sort_order).toBe(5);
  });

  test('delete soft-disables (enabled=false), row stays', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, enabled)
       VALUES ('c1','o1','X','generic-oidc','oidc',true)`
    );
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const r = await a.request('/admin/sso-connections/c1', { method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(200);
    const after = await testPool.query<{ enabled: boolean }>(`SELECT enabled FROM sso_connections WHERE id='c1'`);
    expect(after.rows[0]!.enabled).toBe(false);
  });

  // --- Logo upload ---

  /** Build a multipart/form-data body with a single image file. The
   * `content-type` of the part is taken from the file's actual type so the
   * server can reject non-image uploads. */
  function buildMultipart(
    fieldName: string,
    filename: string,
    contentType: string,
    body: Uint8Array,
  ): { body: Uint8Array; contentType: string } {
    const boundary = `----test-boundary-${Math.random().toString(36).slice(2)}`;
    const head = new TextEncoder().encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const merged = new Uint8Array(head.length + body.length + tail.length);
    merged.set(head, 0);
    merged.set(body, head.length);
    merged.set(tail, head.length + body.length);
    return { body: merged, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  /** 1x1 transparent PNG (the smallest valid PNG). */
  const TINY_PNG = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
  );

  test('POST /admin/sso-connections/:id/logo accepts a 1x1 PNG and stores the upload path', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, enabled)
       VALUES ('c1','o1','Feishu','feishu','oidc',true)`
    );
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const { body, contentType } = buildMultipart('logo', 'feishu.png', 'image/png', TINY_PNG);
    const r = await a.request('/admin/sso-connections/c1/logo', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': contentType, 'content-length': String(body.length) },
      body,
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { logoUrl: string };
    // The persisted value is a server-relative path; the public endpoint
    // resolves it to an absolute URL.
    expect(j.logoUrl).toBe('/sso-logos/uploads/c1.png');
    const after = await testPool.query<{ logo_url: string | null }>(`SELECT logo_url FROM sso_connections WHERE id='c1'`);
    expect(after.rows[0]!.logo_url).toBe('/sso-logos/uploads/c1.png');
  });

  test('POST .../logo rejects files larger than 1 MB', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, enabled)
       VALUES ('c1','o1','Feishu','feishu','oidc',true)`
    );
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const tooBig = new Uint8Array(1024 * 1024 + 1);
    tooBig.fill(0);
    const { body, contentType } = buildMultipart('logo', 'big.png', 'image/png', tooBig);
    const r = await a.request('/admin/sso-connections/c1/logo', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': contentType, 'content-length': String(body.length) },
      body,
    });
    expect(r.status).toBe(413);
    const j = (await r.json()) as { error: string };
    expect(j.error).toMatch(/too_large|size/);
  });

  test('POST .../logo rejects non-image MIME types', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, enabled)
       VALUES ('c1','o1','Feishu','feishu','oidc',true)`
    );
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const { body, contentType } = buildMultipart('logo', 'evil.html', 'text/html', new TextEncoder().encode('<script>alert(1)</script>'));
    const r = await a.request('/admin/sso-connections/c1/logo', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': contentType, 'content-length': String(body.length) },
      body,
    });
    expect(r.status).toBe(415);
    const j = (await r.json()) as { error: string };
    expect(j.error).toMatch(/mime|unsupported/);
  });

  test('POST .../logo with no file part returns 400', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, enabled)
       VALUES ('c1','o1','Feishu','feishu','oidc',true)`
    );
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const r = await a.request('/admin/sso-connections/c1/logo', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  test('POST .../logo on an unknown connection returns 404', async () => {
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const { body, contentType } = buildMultipart('logo', 'x.png', 'image/png', TINY_PNG);
    const r = await a.request('/admin/sso-connections/nope/logo', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': contentType, 'content-length': String(body.length) },
      body,
    });
    expect(r.status).toBe(404);
  });

  test('POST .../logo on a connection from another org returns 404 (cross-org isolation)', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, enabled)
       VALUES ('c1','o2','Other','feishu','oidc',true)`
    );
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const { body, contentType } = buildMultipart('logo', 'x.png', 'image/png', TINY_PNG);
    const r = await a.request('/admin/sso-connections/c1/logo', {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': contentType, 'content-length': String(body.length) },
      body,
    });
    expect(r.status).toBe(404);
  });

  test('DELETE .../logo clears the column and removes the file', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, enabled, logo_url)
       VALUES ('c1','o1','Feishu','feishu','oidc',true,'/sso-logos/uploads/c1.png')`
    );
    // Seed the on-disk file so the delete actually has something to remove.
    const dir = ssoLogoUploadDir('c1');
    const file = join(dir, 'c1.png');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, TINY_PNG);
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const r = await a.request('/admin/sso-connections/c1/logo', { method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(200);
    const after = await testPool.query<{ logo_url: string | null }>(`SELECT logo_url FROM sso_connections WHERE id='c1'`);
    expect(after.rows[0]!.logo_url).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  test('DELETE .../logo is idempotent when no upload exists', async () => {
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, enabled)
       VALUES ('c1','o1','Feishu','feishu','oidc',true)`
    );
    const a = buildApp();
    const t = await tok('o1', ['org_admin']);
    const r = await a.request('/admin/sso-connections/c1/logo', { method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(200);
    const after = await testPool.query<{ logo_url: string | null }>(`SELECT logo_url FROM sso_connections WHERE id='c1'`);
    expect(after.rows[0]!.logo_url).toBeNull();
  });
});
