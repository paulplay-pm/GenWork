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
import { resetSchema, runMigrations } from '../../src/db/testDb';
import { htmlSharesRoutes } from '../../src/routes/htmlShares';
import { uploadRoutes } from '../../src/routes/uploads';

const app = new Hono();
app.route('/', htmlSharesRoutes);
app.route('/', uploadRoutes);

const tokenFor = async (sub: string, orgId: string): Promise<string> =>
  signToken({ sub, orgId, roles: ['user'] });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const buildZip = (files: Record<string, string>): Buffer => {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
};

describe('uploads route', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('POST uploads a zip, writes archive.zip, returns entryFile', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };

    const zip = buildZip({ 'index.html': '<html>hi</html>', 'style.css': 'body{}' });
    const res = await app.request(`/api/uploads/${shareId}`, {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/zip' },
      body: zip,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; entryFile: string | null; totalFiles: number; totalBytes: number };
    expect(body.status).toBe('uploaded');
    expect(body.entryFile).toBe('index.html');
    expect(body.totalFiles).toBe(2);
  });

  test('POST returns 404 for missing share', async () => {
    const tok = await tokenFor('u1', 'o1');
    const zip = buildZip({ 'index.html': '<html>hi</html>' });
    const res = await app.request('/api/uploads/00000000-0000-0000-0000-000000000000', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/zip' },
      body: zip,
    });
    expect(res.status).toBe(404);
  });

  test('POST returns 401 for non-owner', async () => {
    const tokA = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tokA), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };

    const tokB = await tokenFor('u2', 'o1');
    const zip = buildZip({ 'index.html': '<html>hi</html>' });
    const res = await app.request(`/api/uploads/${shareId}`, {
      method: 'POST',
      headers: { ...auth(tokB), 'content-type': 'application/zip' },
      body: zip,
    });
    expect(res.status).toBe(401);
  });

  test('POST returns 400 on empty body', async () => {
    const tok = await tokenFor('u1', 'o1');
    const create = await app.request('/api/html-shares', {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', sourceType: 'html_file', sourceSha256: 'x', clientSourceKey: 'k' }),
    });
    const { shareId } = await create.json() as { shareId: string };
    const res = await app.request(`/api/uploads/${shareId}`, {
      method: 'POST',
      headers: { ...auth(tok), 'content-type': 'application/zip' },
      body: Buffer.alloc(0),
    });
    expect(res.status).toBe(400);
  });
});
