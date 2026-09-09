import '../helpers/setupEnv';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENTERPRISE_STATE_DIR = join(tmpdir(), 'enterprise-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import AdmZip from 'adm-zip';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations } from '../../src/db/testDb';
import { stateDir } from '../../src/lib/stateDir';
import { htmlSharesRoutes } from '../../src/routes/htmlShares';
import { shareDeploymentsRoutes } from '../../src/routes/shareDeployments';

const app = new Hono();
app.route('/', shareDeploymentsRoutes);
app.route('/', htmlSharesRoutes);

const tokenFor = async (sub: string, orgId: string, roles: string[] = ['user']): Promise<string> =>
  signToken({ sub, orgId, roles });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const buildZip = (files: Record<string, string>): Buffer => {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
};

const sha256Of = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

async function createHtmlShare(
  tok: string,
  overrides: { title?: string; sourceType?: string; sourceSha256?: string; clientSourceKey?: string } = {},
): Promise<string> {
  const res = await app.request('/api/html-shares', {
    method: 'POST',
    headers: { ...auth(tok), 'content-type': 'application/json' },
    body: JSON.stringify({
      title: overrides.title ?? 'share',
      sourceType: overrides.sourceType ?? 'html_file',
      sourceSha256: overrides.sourceSha256 ?? 'sha-x',
      clientSourceKey: overrides.clientSourceKey ?? 'k1',
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { shareId: string };
  return body.shareId;
}

const manifest = (deploymentKind: 'node_service' | 'static_site'): string =>
  JSON.stringify({
    schemaVersion: 1,
    deploymentKind,
    runtimeLanguage: 'node',
    projectRootName: 'proj',
  });

function buildMultipart(fields: Record<string, string | { filename: string; data: Buffer; type: string }>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') {
      form.append(k, v);
    } else {
      form.append(k, new File([v.data], v.filename, { type: v.type }), v.filename);
    }
  }
  return form;
}

describe('POST /api/share-deployments/node', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('creates a deployment row, archives the zip, returns ServerShareDeploymentResponse', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const zip = buildZip({ 'index.js': 'console.log(1)' });
    const sha = sha256Of(zip);
    const form = buildMultipart({
      sessionId: shareId,
      accessMode: 'code',
      clientSourceKey: 'k1',
      sourceSha256: sha,
      manifest: manifest('node_service'),
      sourceArchive: { filename: 'source.zip', data: zip, type: 'application/zip' },
    });
    const res = await app.request('/api/share-deployments/node', {
      method: 'POST',
      headers: auth(tok),
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      data: {
        deploymentId: string;
        shareId: string;
        accessMode: string;
        deploymentStatus: string;
        deploymentKind: string;
        sourceSha256: string;
        sourceArchiveBytes: number;
      };
    };
    expect(body.code).toBe(0);
    expect(body.data.deploymentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.data.shareId).toBe(shareId);
    expect(body.data.accessMode).toBe('code');
    expect(body.data.deploymentStatus).toBe('queued');
    expect(body.data.deploymentKind).toBe('node_service');
    expect(body.data.sourceSha256).toBe(sha);
    expect(body.data.sourceArchiveBytes).toBe(zip.byteLength);
  });

  test('rejects when source_sha256 does not match the uploaded archive', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const zip = buildZip({ 'index.js': 'x' });
    const form = buildMultipart({
      sessionId: shareId,
      accessMode: 'code',
      clientSourceKey: 'k1',
      sourceSha256: 'deadbeef'.repeat(8),
      manifest: manifest('node_service'),
      sourceArchive: { filename: 'source.zip', data: zip, type: 'application/zip' },
    });
    const res = await app.request('/api/share-deployments/node', {
      method: 'POST',
      headers: auth(tok),
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('sha256_mismatch');
  });

  test('rejects when the share does not exist', async () => {
    const tok = await tokenFor('u1', 'o1');
    const zip = buildZip({ 'index.js': 'x' });
    const sha = sha256Of(zip);
    const form = buildMultipart({
      sessionId: '00000000-0000-0000-0000-000000000000',
      accessMode: 'code',
      clientSourceKey: 'k1',
      sourceSha256: sha,
      manifest: manifest('node_service'),
      sourceArchive: { filename: 'source.zip', data: zip, type: 'application/zip' },
    });
    const res = await app.request('/api/share-deployments/node', {
      method: 'POST',
      headers: auth(tok),
      body: form,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('share_not_found');
  });

  test('rejects manifest JSON missing required fields', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const zip = buildZip({ 'x.js': 'x' });
    const sha = sha256Of(zip);
    const form = buildMultipart({
      sessionId: shareId,
      accessMode: 'code',
      clientSourceKey: 'k1',
      sourceSha256: sha,
      manifest: JSON.stringify({ schemaVersion: 2 }),
      sourceArchive: { filename: 'source.zip', data: zip, type: 'application/zip' },
    });
    const res = await app.request('/api/share-deployments/node', {
      method: 'POST',
      headers: auth(tok),
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_manifest');
  });
});

describe('POST /api/share-deployments/static', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('creates a deployment row with deployment_kind=static_site', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const zip = buildZip({ 'index.html': '<html></html>' });
    const sha = sha256Of(zip);
    const form = buildMultipart({
      sessionId: shareId,
      accessMode: 'code',
      clientSourceKey: 'k1',
      sourceSha256: sha,
      manifest: manifest('static_site'),
      sourceArchive: { filename: 'source.zip', data: zip, type: 'application/zip' },
    });
    const res = await app.request('/api/share-deployments/static', {
      method: 'POST',
      headers: auth(tok),
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { deploymentKind: string } };
    expect(body.code).toBe(0);
    expect(body.data.deploymentKind).toBe('static_site');
  });

  test('rejects when manifest deploymentKind does not match endpoint', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const zip = buildZip({ 'x.js': 'x' });
    const sha = sha256Of(zip);
    const form = buildMultipart({
      sessionId: shareId,
      accessMode: 'code',
      clientSourceKey: 'k1',
      sourceSha256: sha,
      manifest: manifest('node_service'),
      sourceArchive: { filename: 'source.zip', data: zip, type: 'application/zip' },
    });
    const res = await app.request('/api/share-deployments/static', {
      method: 'POST',
      headers: auth(tok),
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('manifest_kind_mismatch');
  });
});

describe('GET /api/share-deployments/:deploymentId', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('returns the row', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const zip = buildZip({ 'a.js': '1' });
    const sha = sha256Of(zip);
    const form = buildMultipart({
      sessionId: shareId,
      accessMode: 'code',
      clientSourceKey: 'k1',
      sourceSha256: sha,
      manifest: manifest('node_service'),
      sourceArchive: { filename: 'source.zip', data: zip, type: 'application/zip' },
    });
    const upload = await app.request('/api/share-deployments/node', {
      method: 'POST',
      headers: auth(tok),
      body: form,
    });
    const uploaded = (await upload.json()) as { data: { deploymentId: string } };
    const id = uploaded.data.deploymentId;

    const res = await app.request(`/api/share-deployments/${id}`, { headers: auth(tok) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { deploymentId: string; shareId: string } };
    expect(body.code).toBe(0);
    expect(body.data.deploymentId).toBe(id);
    expect(body.data.shareId).toBe(shareId);
  });

  test('returns 404 for unknown id', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/share-deployments/00000000-0000-0000-0000-000000000000', { headers: auth(tok) });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/html-shares/:shareId/deployment', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('returns the deployment by shareId', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const zip = buildZip({ 'a.js': '1' });
    const sha = sha256Of(zip);
    const form = buildMultipart({
      sessionId: shareId,
      accessMode: 'code',
      clientSourceKey: 'k1',
      sourceSha256: sha,
      manifest: manifest('node_service'),
      sourceArchive: { filename: 'source.zip', data: zip, type: 'application/zip' },
    });
    await app.request('/api/share-deployments/node', {
      method: 'POST',
      headers: auth(tok),
      body: form,
    });

    const res = await app.request(`/api/html-shares/${shareId}/deployment`, { headers: auth(tok) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { shareId: string; deploymentKind: string } };
    expect(body.code).toBe(0);
    expect(body.data.shareId).toBe(shareId);
    expect(body.data.deploymentKind).toBe('node_service');
  });

  test('returns 404 if no deployment is associated', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const res = await app.request(`/api/html-shares/${shareId}/deployment`, { headers: auth(tok) });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/html-shares/:shareId/access-mode', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('updates the column', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const res = await app.request(`/api/html-shares/${shareId}/access-mode`, {
      method: 'PATCH',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ accessMode: 'public' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessMode: string };
    expect(body.accessMode).toBe('public');

    const lookup = await app.request(
      `/api/html-shares?sourceType=html_file&clientSourceKey=k1`,
      { headers: auth(tok) },
    );
    expect(lookup.status).toBe(200);
    const lookupBody = (await lookup.json()) as { shares: Array<{ share_id: string; access_mode: string }> };
    expect(lookupBody.shares).toHaveLength(1);
    expect(lookupBody.shares[0].share_id).toBe(shareId);
    expect(lookupBody.shares[0].access_mode).toBe('public');
  });

  test('returns 404 for unknown shareId', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/html-shares/00000000-0000-0000-0000-000000000000/access-mode', {
      method: 'PATCH',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ accessMode: 'public' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/html-shares/:shareId/status', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('returns 200 when the share exists', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const res = await app.request(`/api/html-shares/${shareId}/status`, {
      method: 'PATCH',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('disabled');
  });

  test('returns 404 for unknown shareId', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/html-shares/00000000-0000-0000-0000-000000000000/status', {
      method: 'PATCH',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/share-deployments/:id/persistence', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('returns null when no persistence configured', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const zip = buildZip({ 'a.js': '1' });
    const sha = sha256Of(zip);
    const form = buildMultipart({
      sessionId: shareId,
      accessMode: 'code',
      clientSourceKey: 'k1',
      sourceSha256: sha,
      manifest: manifest('node_service'),
      sourceArchive: { filename: 'source.zip', data: zip, type: 'application/zip' },
    });
    const upload = await app.request('/api/share-deployments/node', {
      method: 'POST',
      headers: auth(tok),
      body: form,
    });
    const uploaded = (await upload.json()) as { data: { deploymentId: string } };

    const res = await app.request(`/api/share-deployments/${uploaded.data.deploymentId}/persistence`, {
      headers: auth(tok),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { persistence: unknown };
    expect(body.persistence).toBeNull();
  });
});

describe('GET /api/share-deployments/:id/persistence/archive', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('returns 204 when no archive exists', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const zip = buildZip({ 'a.js': '1' });
    const sha = sha256Of(zip);
    const form = buildMultipart({
      sessionId: shareId,
      accessMode: 'code',
      clientSourceKey: 'k1',
      sourceSha256: sha,
      manifest: manifest('node_service'),
      sourceArchive: { filename: 'source.zip', data: zip, type: 'application/zip' },
    });
    const upload = await app.request('/api/share-deployments/node', {
      method: 'POST',
      headers: auth(tok),
      body: form,
    });
    const uploaded = (await upload.json()) as { data: { deploymentId: string } };

    const res = await app.request(`/api/share-deployments/${uploaded.data.deploymentId}/persistence/archive`, {
      headers: auth(tok),
    });
    expect(res.status).toBe(204);
  });

  test('returns the zip when archive exists', async () => {
    const tok = await tokenFor('u1', 'o1');
    const shareId = await createHtmlShare(tok);
    const zip = buildZip({ 'a.js': '1' });
    const sha = sha256Of(zip);
    const form = buildMultipart({
      sessionId: shareId,
      accessMode: 'code',
      clientSourceKey: 'k1',
      sourceSha256: sha,
      manifest: manifest('node_service'),
      sourceArchive: { filename: 'source.zip', data: zip, type: 'application/zip' },
    });
    const upload = await app.request('/api/share-deployments/node', {
      method: 'POST',
      headers: auth(tok),
      body: form,
    });
    const uploaded = (await upload.json()) as { data: { deploymentId: string } };

    const archiveBuf = buildZip({ 'persist.bin': 'persisted' });
    const archivePath = join(stateDir(), 'share_deployments', 'o1', `${uploaded.data.deploymentId}.archive.zip`);
    await writeFile(archivePath, archiveBuf);

    const res = await app.request(`/api/share-deployments/${uploaded.data.deploymentId}/persistence/archive`, {
      headers: auth(tok),
    });
    expect(res.status).toBe(200);
    const out = Buffer.from(await res.arrayBuffer());
    expect(out.equals(archiveBuf)).toBe(true);
  });
});

describe('GET /api/html-shares?sourceType=X&clientSourceKey=Y', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('returns the matching share', async () => {
    const tok = await tokenFor('u1', 'o1');
    await createHtmlShare(tok, { sourceType: 'html_file', clientSourceKey: 'k1' });
    const res = await app.request('/api/html-shares?sourceType=html_file&clientSourceKey=k1', {
      headers: auth(tok),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shares: Array<{ share_id: string; source_type: string; client_source_key: string }> };
    expect(body.shares).toHaveLength(1);
    expect(body.shares[0].source_type).toBe('html_file');
    expect(body.shares[0].client_source_key).toBe('k1');
  });

  test('returns empty array when no match', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/html-shares?sourceType=html_file&clientSourceKey=nope', {
      headers: auth(tok),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shares: unknown[] };
    expect(body.shares).toHaveLength(0);
  });

  test('returns 400 when query params missing', async () => {
    const tok = await tokenFor('u1', 'o1');
    const res = await app.request('/api/html-shares', { headers: auth(tok) });
    expect(res.status).toBe(400);
  });
});

describe('Auth gating', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('rejects unauthenticated POST to /api/share-deployments/node', async () => {
    const res = await app.request('/api/share-deployments/node', {
      method: 'POST',
      body: new FormData(),
    });
    expect(res.status).toBe(401);
  });

  test('rejects unauthenticated GET to /api/share-deployments/:id', async () => {
    const res = await app.request('/api/share-deployments/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
  });
});