import '../helpers/setupEnv';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENTERPRISE_STATE_DIR = join(tmpdir(), 'enterprise-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import AdmZip from 'adm-zip';
import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { htmlSharesRoutes } from '../../src/routes/htmlShares';
import { pagesRoutes } from '../../src/routes/pages';
import { shareDeploymentsRoutes } from '../../src/routes/shareDeployments';
import { uploadRoutes } from '../../src/routes/uploads';

const app = new Hono();
app.route('/', htmlSharesRoutes);
app.route('/', shareDeploymentsRoutes);
app.route('/', uploadRoutes);
app.route('/', pagesRoutes);

const tokenFor = async (sub: string, orgId: string): Promise<string> =>
  signToken({ sub, orgId, roles: ['user'] });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const cookieAuth = (t: string) => ({ cookie: `genwork_session=${t}` });
const browserNav = { accept: 'text/html,application/xhtml+xml,*/*' };

const buildZip = (files: Record<string, string>): Buffer => {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
};

describe('pages route', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('GET /index.html returns the entry file', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };

    const zip = buildZip({ 'index.html': '<html><body>hi</body></html>' });
    await app.request(`/api/uploads/${shareId}`, {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/zip' },
      body: zip,
    });

    const res = await app.request(`/api/pages/${shareId}/index.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<html>');
  });

  test('GET /assets/x.css returns the asset file', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };

    const zip = buildZip({ 'index.html': '<html>hi</html>', 'assets/x.css': 'body{color:red;}' });
    await app.request(`/api/uploads/${shareId}`, {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/zip' },
      body: zip,
    });

    const res = await app.request(`/api/pages/${shareId}/assets/assets/x.css`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('body{color:red;}');
  });

  test('GET /assets/../etc/passwd returns 400 (path traversal)', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };

    const zip = buildZip({ 'index.html': '<html>hi</html>' });
    await app.request(`/api/uploads/${shareId}`, {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/zip' },
      body: zip,
    });

    // Hono may normalize the URL — try the URL-encoded form
    const res = await app.request(`/api/pages/${shareId}/assets/..%2F..%2Fetc%2Fpasswd`);
    // Acceptable outcomes: 400 (path sanitization rejected) or 404 (file not found).
    // Either is correct security posture; reject only if 200.
    expect([400, 404]).toContain(res.status);
  });

  test('GET returns 410 when expires_at is past', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };

    // Update the row to set expires_at in the past.
    await testPool.query(`UPDATE html_shares SET expires_at = NOW() - INTERVAL '1 day' WHERE share_id = $1`, [shareId]);

    const res = await app.request(`/api/pages/${shareId}/index.html`);
    expect(res.status).toBe(410);
  });

  test('GET /index.html returns 404 when no upload yet', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };
    const res = await app.request(`/api/pages/${shareId}/index.html`);
    expect(res.status).toBe(404);
  });

  // access_mode='org': same-org token can read, cross-org cannot, anonymous cannot.
  const setOrgMode = async (shareId: string) => {
    await testPool.query(`UPDATE html_shares SET access_mode = 'org' WHERE share_id = $1`, [shareId]);
  };

  // Create a share, upload a page, and mark it org-only. Returns the shareId.
  const createOrgShare = async (ownerTok: string): Promise<string> => {
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(ownerTok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };
    const zip = buildZip({ 'index.html': '<html><body>org-share</body></html>' });
    await app.request(`/api/uploads/${shareId}`, {
      method: 'POST',
      headers: { ...auth(ownerTok), 'content-type': 'application/zip' },
      body: zip,
    });
    await setOrgMode(shareId);
    return shareId;
  };

  test('GET /index.html returns 200 with same-org token when access_mode=org', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };

    const zip = buildZip({ 'index.html': '<html><body>org-share</body></html>' });
    await app.request(`/api/uploads/${shareId}`, {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/zip' },
      body: zip,
    });

    await setOrgMode(shareId);

    // Different user, same org.
    const otherTok = await tokenFor('u2', 'o1');
    const res = await app.request(`/api/pages/${shareId}/index.html`, { headers: auth(otherTok) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('org-share');
  });

  test('GET /index.html returns 403 with cross-org token when access_mode=org', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };

    const zip = buildZip({ 'index.html': '<html><body>x</body></html>' });
    await app.request(`/api/uploads/${shareId}`, {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/zip' },
      body: zip,
    });
    await setOrgMode(shareId);

    const crossOrgTok = await tokenFor('u3', 'o2');
    const res = await app.request(`/api/pages/${shareId}/index.html`, { headers: auth(crossOrgTok) });
    expect(res.status).toBe(403);
  });

  test('GET /index.html returns 401 without a token when access_mode=org', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };
    await setOrgMode(shareId);

    const res = await app.request(`/api/pages/${shareId}/index.html`);
    expect(res.status).toBe(401);
  });

  test('GET /index.html returns 200 with a same-org session cookie when access_mode=org', async () => {
    const owner = await tokenFor('u1', 'o1');
    const shareId = await createOrgShare(owner);

    // A second user in the same org, authenticated by the browser session
    // cookie (not the Bearer header) — the Phase 2 login-then-view flow.
    const cookieTok = await tokenFor('u2', 'o1');
    const res = await app.request(`/api/pages/${shareId}/index.html`, {
      headers: cookieAuth(cookieTok),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('org-share');
  });

  test('GET /index.html returns 403 with a cross-org session cookie when access_mode=org', async () => {
    const owner = await tokenFor('u1', 'o1');
    const shareId = await createOrgShare(owner);

    const crossOrgCookie = await tokenFor('u3', 'o2');
    const res = await app.request(`/api/pages/${shareId}/index.html`, {
      headers: cookieAuth(crossOrgCookie),
    });
    expect(res.status).toBe(403);
  });

  test('GET /index.html redirects a signed-out browser to /login?next=... when access_mode=org', async () => {
    const owner = await tokenFor('u1', 'o1');
    const shareId = await createOrgShare(owner);

    // A top-level browser navigation with no credentials at all.
    const res = await app.request(`/api/pages/${shareId}/index.html`, {
      headers: browserNav,
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBe(`/login?next=${encodeURIComponent(`/api/pages/${shareId}/index.html`)}`);
  });

  test('GET /index.html returns JSON 401 (not a redirect) for an API/desktop client when access_mode=org', async () => {
    const owner = await tokenFor('u1', 'o1');
    const shareId = await createOrgShare(owner);

    // No browser navigation signals (no sec-fetch-mode, accept is not
    // text/html) and no credentials: the desktop/API path must stay a 401.
    const res = await app.request(`/api/pages/${shareId}/index.html`, {
      headers: { accept: 'application/json' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('unauthorized');
  });

  test('GET /assets/* also enforces access_mode=org (cross-org token → 403)', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };

    const zip = buildZip({
      'index.html': '<html>hi</html>',
      'assets/x.css': 'body{color:red;}',
    });
    await app.request(`/api/uploads/${shareId}`, {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/zip' },
      body: zip,
    });
    await setOrgMode(shareId);

    const crossOrgTok = await tokenFor('u3', 'o2');
    const res = await app.request(`/api/pages/${shareId}/assets/assets/x.css`, {
      headers: auth(crossOrgTok),
    });
    expect(res.status).toBe(403);
  });

  test('PATCH /api/html-shares/:shareId/access-mode accepts org', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };

    const res = await app.request(`/api/html-shares/${shareId}/access-mode`, {
      method: 'PATCH',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ accessMode: 'org' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { accessMode: string };
    expect(body.accessMode).toBe('org');
  });
});
