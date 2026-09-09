import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  HtmlShareAccessMode,
  HtmlShareStatus,
} from '../../../shared/htmlShare/constants';
import {
  buildHtmlSharePublicUrl,
  createHtmlShareFromHtmlFile,
  deleteHtmlShare,
  getHtmlShare,
  getHtmlShareBySource,
  getHtmlShareQuota,
  updateHtmlShareAccessMode,
  updateHtmlShareStatus,
} from './htmlShareClient';

const ENTERPRISE_BASE_URL = 'https://enterprise.example.test';

const tempRoots: string[] = [];

async function createArchiveFile(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'genwork-html-share-client-test-'));
  tempRoots.push(root);
  const archivePath = path.join(root, 'share.zip');
  await fs.promises.writeFile(archivePath, Buffer.from('zip-content'));
  return archivePath;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true })),
  );
});

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('htmlShareClient (enterprise)', () => {
  test('builds public share URLs from the enterprise base', () => {
    expect(buildHtmlSharePublicUrl(`${ENTERPRISE_BASE_URL}/api/pages`, 'shr_123')).toBe(
      `${ENTERPRISE_BASE_URL}/api/pages/shr_123`,
    );
  });

  test('createFromHtmlFile posts flat metadata then uploads the raw zip to enterprise_server', async () => {
    const archivePath = await createArchiveFile();
    const calls: Array<{
      url: string;
      method: string;
      body: unknown;
      contentType: string | null;
    }> = [];
    const fetchWithAuth = vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method || 'GET';
      const headers = options?.headers as Record<string, string> | undefined;
      const contentType =
        typeof headers?.['Content-Type'] === 'string' ? headers['Content-Type'] : null;
      if (options?.body instanceof ArrayBuffer) {
        calls.push({ url, method, body: '[raw-zip]', contentType });
        return makeJsonResponse({
          status: 'uploaded',
          entryFile: 'index.html',
          totalFiles: 1,
          totalBytes: 11,
          warnings: [],
        });
      }
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ url, method, body, contentType });
      return makeJsonResponse({
        shareId: 'shr_new',
        publicUrl: `${ENTERPRISE_BASE_URL}/api/pages/shr_new`,
        expiresAt: '2026-10-01T00:00:00.000Z',
      });
    });

    const result = await createHtmlShareFromHtmlFile(
      ENTERPRISE_BASE_URL,
      fetchWithAuth,
      {
        archivePath,
        sourceType: 'html_file',
        clientSourceKey: 'html_file:file:/a/b.html',
        title: 'Preview',
        entryFile: 'index.html',
        sourceSha256: 'hash',
      },
    );

    expect(result.success).toBe(true);
    expect(result.shareId).toBe('shr_new');
    expect(result.url).toBe(`${ENTERPRISE_BASE_URL}/api/pages/shr_new`);
    expect(result.status).toBe('live');
    expect(result.accessExpiresAt).toBe('2026-10-01T00:00:00.000Z');

    expect(calls[0].url).toBe(`${ENTERPRISE_BASE_URL}/api/html-shares`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].contentType).toBe('application/json');
    expect(calls[0].body).toEqual({
      title: 'Preview',
      sourceType: 'html_file',
      sourceSha256: 'hash',
      clientSourceKey: 'html_file:file:/a/b.html',
    });

    expect(calls[1].url).toBe(`${ENTERPRISE_BASE_URL}/api/uploads/shr_new`);
    expect(calls[1].method).toBe('POST');
    expect(calls[1].contentType).toBe('application/zip');
    expect(calls[1].body).toBe('[raw-zip]');
  });

  test('createFromHtmlFile returns failure when the server rejects metadata with a flat error', async () => {
    const archivePath = await createArchiveFile();
    const fetchWithAuth = vi.fn(async () => makeJsonResponse({ error: 'invalid_body' }, 400));
    const result = await createHtmlShareFromHtmlFile(ENTERPRISE_BASE_URL, fetchWithAuth, {
      archivePath,
      sourceType: 'html_file',
      clientSourceKey: 'html_file:file:/a/b.html',
      title: 'Preview',
      entryFile: 'index.html',
      sourceSha256: 'hash',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_body');
  });

  test('get reads a single share from the enterprise server (flat response)', async () => {
    let requestedUrl = '';
    const fetchWithAuth = vi.fn(async (url: string) => {
      requestedUrl = url;
      return makeJsonResponse({
        shareId: 'shr_1',
        title: 'Preview',
        sourceType: 'html_file',
        entryFile: 'index.html',
        totalFiles: 1,
        totalBytes: 10,
        createdAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-10-01T00:00:00.000Z',
      });
    });
    const result = await getHtmlShare(ENTERPRISE_BASE_URL, fetchWithAuth, 'shr_1');
    expect(requestedUrl).toBe(`${ENTERPRISE_BASE_URL}/api/html-shares/shr_1`);
    expect(result.success).toBe(true);
    expect(result.share?.shareId).toBe('shr_1');
    expect(result.share?.url).toBe(`${ENTERPRISE_BASE_URL}/api/pages/shr_1`);
    expect(result.share?.status).toBe(HtmlShareStatus.Live);
    expect(result.share?.accessExpiresAt).toBe('2026-10-01T00:00:00.000Z');
  });

  test('get returns failure when the server 404s with a flat error', async () => {
    const fetchWithAuth = vi.fn(async () => makeJsonResponse({ error: 'not_found' }, 404));
    const result = await getHtmlShare(ENTERPRISE_BASE_URL, fetchWithAuth, 'shr_x');
    expect(result.success).toBe(false);
    expect(result.error).toBe('not_found');
  });

  test('getQuota maps the flat used/quota snapshot into a publishing quota', async () => {
    let requestedUrl = '';
    const fetchWithAuth = vi.fn(async (url: string) => {
      requestedUrl = url;
      return makeJsonResponse({ used: 7, quota: 100 });
    });
    const result = await getHtmlShareQuota(ENTERPRISE_BASE_URL, fetchWithAuth);
    expect(requestedUrl).toBe(`${ENTERPRISE_BASE_URL}/api/html-shares/quota`);
    expect(result).toEqual({
      success: true,
      data: {
        resourceKind: 'file',
        identityType: 'enterprise',
        countMode: 'total',
        used: 7,
        limit: 100,
        canReleaseByClosing: false,
        allowed: true,
        remaining: 93,
      },
    });
  });

  test('getQuota fails closed when used reaches the limit', async () => {
    const fetchWithAuth = vi.fn(async () => makeJsonResponse({ used: 100, quota: 100 }));
    const result = await getHtmlShareQuota(ENTERPRISE_BASE_URL, fetchWithAuth);
    expect(result.success).toBe(true);
    expect(result.data?.allowed).toBe(false);
    expect(result.data?.remaining).toBe(0);
  });

  test('getQuota rejects malformed enterprise responses', async () => {
    const fetchWithAuth = vi.fn(async () => makeJsonResponse({}));
    const result = await getHtmlShareQuota(ENTERPRISE_BASE_URL, fetchWithAuth);
    expect(result.success).toBe(false);
  });

  test('getHtmlShareBySource returns the matching share on hit (flat response)', async () => {
    let requestedUrl = '';
    const fetchWithAuth = vi.fn(async (url: string) => {
      requestedUrl = url;
      return makeJsonResponse({
        shares: [
          {
            share_id: 'shr_src',
            org_id: 'org_1',
            user_id: 'user_1',
            source_type: 'html_file',
            client_source_key: 'session:abc',
            access_mode: 'public',
            expires_at: '2026-10-01T00:00:00.000Z',
            title: 'Preview',
          },
        ],
      });
    });
    const result = await getHtmlShareBySource(
      ENTERPRISE_BASE_URL,
      `${ENTERPRISE_BASE_URL}/api/pages`,
      fetchWithAuth,
      'html_file',
      'session:abc',
    );
    expect(requestedUrl).toBe(
      `${ENTERPRISE_BASE_URL}/api/html-shares?sourceType=html_file&clientSourceKey=session%3Aabc`,
    );
    expect(result.success).toBe(true);
    expect(result.share).toEqual({
      success: true,
      shareId: 'shr_src',
      url: `${ENTERPRISE_BASE_URL}/api/pages/shr_src`,
      accessMode: HtmlShareAccessMode.Public,
      accessExpiresAt: '2026-10-01T00:00:00.000Z',
    });
  });

  test('getHtmlShareBySource returns success:true with share:null when the server has no match', async () => {
    const fetchWithAuth = vi.fn(async () => makeJsonResponse({ shares: [] }));
    const result = await getHtmlShareBySource(
      ENTERPRISE_BASE_URL,
      `${ENTERPRISE_BASE_URL}/api/pages`,
      fetchWithAuth,
      'html_file',
      'session:nope',
    );
    expect(result.success).toBe(true);
    expect(result.share).toBeNull();
  });

  test('getHtmlShareBySource returns failure when the server rejects the lookup', async () => {
    const fetchWithAuth = vi.fn(async () => makeJsonResponse({ error: 'missing_query_params' }, 400));
    const result = await getHtmlShareBySource(
      ENTERPRISE_BASE_URL,
      `${ENTERPRISE_BASE_URL}/api/pages`,
      fetchWithAuth,
      'html_file',
      'session:abc',
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('missing_query_params');
  });

  test('getHtmlShareBySource returns failure when fetchWithAuth throws', async () => {
    const fetchWithAuth = vi.fn(async () => {
      throw new Error('network down');
    });
    const result = await getHtmlShareBySource(
      ENTERPRISE_BASE_URL,
      `${ENTERPRISE_BASE_URL}/api/pages`,
      fetchWithAuth,
      'html_file',
      'session:abc',
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('network down');
  });

  test('deleteHtmlShare issues a DELETE and reports success', async () => {
    let method = '';
    const fetchWithAuth = vi.fn(async (_url: string, options?: RequestInit) => {
      method = options?.method || 'GET';
      return makeJsonResponse({ deleted: true });
    });
    const result = await deleteHtmlShare(ENTERPRISE_BASE_URL, fetchWithAuth, 'shr_1');
    expect(method).toBe('DELETE');
    expect(result).toEqual({ success: true });
  });

  test('deleteHtmlShare surfaces a flat error on non-ok responses', async () => {
    const fetchWithAuth = vi.fn(async () => makeJsonResponse({ error: 'not_owner' }, 401));
    const result = await deleteHtmlShare(ENTERPRISE_BASE_URL, fetchWithAuth, 'shr_1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('not_owner');
  });

  test('updateHtmlShareAccessMode PATCHes the access mode on success', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchWithAuth = vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method || 'GET';
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ url, method, body });
      return makeJsonResponse({ code: 0 });
    });
    const result = await updateHtmlShareAccessMode(
      ENTERPRISE_BASE_URL,
      `${ENTERPRISE_BASE_URL}/api/pages`,
      fetchWithAuth,
      'shr_1',
      HtmlShareAccessMode.Public,
    );
    expect(calls[0].url).toBe(`${ENTERPRISE_BASE_URL}/api/html-shares/shr_1/access-mode`);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body).toEqual({ accessMode: HtmlShareAccessMode.Public });
    expect(result).toEqual({ success: true, accessMode: HtmlShareAccessMode.Public });
  });

  test('updateHtmlShareAccessMode returns failure when the server rejects the update', async () => {
    const fetchWithAuth = vi.fn(async () =>
      makeJsonResponse({ error: 'not_found' }, 404),
    );
    const result = await updateHtmlShareAccessMode(
      ENTERPRISE_BASE_URL,
      `${ENTERPRISE_BASE_URL}/api/pages`,
      fetchWithAuth,
      'shr_missing',
      HtmlShareAccessMode.Code,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('not_found');
  });

  test('updateHtmlShareAccessMode returns failure when fetchWithAuth throws', async () => {
    const fetchWithAuth = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const result = await updateHtmlShareAccessMode(
      ENTERPRISE_BASE_URL,
      `${ENTERPRISE_BASE_URL}/api/pages`,
      fetchWithAuth,
      'shr_1',
      HtmlShareAccessMode.Code,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('connection reset');
  });

  test('updateHtmlShareStatus PATCHes the status on success', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchWithAuth = vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method || 'GET';
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ url, method, body });
      return makeJsonResponse({ code: 0 });
    });
    const result = await updateHtmlShareStatus(
      ENTERPRISE_BASE_URL,
      `${ENTERPRISE_BASE_URL}/api/pages`,
      fetchWithAuth,
      'shr_1',
      HtmlShareStatus.Disabled,
    );
    expect(calls[0].url).toBe(`${ENTERPRISE_BASE_URL}/api/html-shares/shr_1/status`);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body).toEqual({ status: HtmlShareStatus.Disabled });
    expect(result).toEqual({ success: true, status: HtmlShareStatus.Disabled });
  });

  test('updateHtmlShareStatus returns failure when the server rejects the update', async () => {
    const fetchWithAuth = vi.fn(async () =>
      makeJsonResponse({ code: 14004, message: 'share not found' }, 404),
    );
    const result = await updateHtmlShareStatus(
      ENTERPRISE_BASE_URL,
      `${ENTERPRISE_BASE_URL}/api/pages`,
      fetchWithAuth,
      'shr_missing',
      HtmlShareStatus.Live,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('share not found');
    expect(result.code).toBe(14004);
  });

  test('updateHtmlShareStatus returns failure when fetchWithAuth throws', async () => {
    const fetchWithAuth = vi.fn(async () => {
      throw new Error('timeout');
    });
    const result = await updateHtmlShareStatus(
      ENTERPRISE_BASE_URL,
      `${ENTERPRISE_BASE_URL}/api/pages`,
      fetchWithAuth,
      'shr_1',
      HtmlShareStatus.Disabled,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
  });
});
