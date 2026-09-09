import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { apiClient } from '../../src/api/client';
import { InstallerUploadError, uploadInstaller } from '../../src/api/releaseInstallers';

const getToken = () => 'tok';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('api/releaseInstallers.uploadInstaller', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    apiClient.setBaseUrl('http://test');
  });

  test('init -> chunks -> complete posts the right endpoints and returns meta', async () => {
    const file = new File([new Uint8Array(5).fill(65)], 'genwork.exe', { type: 'application/octet-stream' });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { uploadId: 'up1', chunkSize: 8 * 1024 * 1024 })); // init
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { acceptedIndex: 0, totalAccepted: 1 })); // chunk 0
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'up1', fileName: 'genwork.exe', fileSize: 5, sha256: 'abc' })); // complete

    const meta = await uploadInstaller({ platform: 'windowsX64', file, getToken, onProgress: vi.fn() });
    expect(meta).toEqual({ id: 'up1', fileName: 'genwork.exe', fileSize: 5, sha256: 'abc' });

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe('http://test/admin/releases/installers/init');
    expect(urls[1]).toBe('http://test/admin/releases/installers/up1/chunks/0');
    expect(urls[2]).toBe('http://test/admin/releases/installers/up1/complete');

    const initBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(initBody).toMatchObject({ platform: 'windowsX64', fileName: 'genwork.exe', fileSize: 5 });
    const authHeader = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(authHeader.authorization).toBe('Bearer tok');
  });

  test('a failed chunk surfaces a resumable InstallerUploadError', async () => {
    const file = new File([new Uint8Array(5).fill(65)], 'genwork.exe', { type: 'application/octet-stream' });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { uploadId: 'up1', chunkSize: 8 * 1024 * 1024 })); // init
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' })); // chunk 0 fails

    let err: unknown;
    try {
      await uploadInstaller({ platform: 'windowsX64', file, getToken, onProgress: vi.fn() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InstallerUploadError);
    expect((err as InstallerUploadError).resume).toEqual({ uploadId: 'up1', totalAccepted: 0, chunkSize: 8 * 1024 * 1024 });
  });

  test('resume skips already-accepted chunks', async () => {
    // 8-byte file with a 4-byte chunkSize = 2 chunks; resume from totalAccepted=1
    // sends only chunk 1 (not chunk 0) and does not call init.
    const file = new File([new Uint8Array(8).fill(65)], 'genwork.exe', { type: 'application/octet-stream' });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { acceptedIndex: 1, totalAccepted: 2 })); // chunk 1
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'up9', fileName: 'genwork.exe', fileSize: 8, sha256: 'z' })); // complete

    const meta = await uploadInstaller({
      platform: 'windowsX64',
      file,
      getToken,
      onProgress: vi.fn(),
      chunkSize: 4,
      resume: { uploadId: 'up9', totalAccepted: 1 },
    });
    expect(meta.id).toBe('up9');
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain('http://test/admin/releases/installers/up9/chunks/1');
    expect(urls).not.toContain('http://test/admin/releases/installers/up9/chunks/0');
    expect(urls).not.toContain('http://test/admin/releases/installers/init');
  });

  test('resume carries the server-returned chunkSize instead of re-slicing at the default', async () => {
    // 8-byte file; the server's init returns a non-default chunkSize: 4 -> 2 chunks.
    // First attempt: chunk 0 accepted, chunk 1 PUT fails. The thrown .resume must
    // carry chunkSize: 4, and resuming from it (without an explicit chunkSize) must
    // continue at chunk 1 computed with the 4-byte slices — not re-slice at the
    // 8 MiB default (which would yield 1 chunk and skip the loop entirely).
    const file = new File([new Uint8Array(8).fill(65)], 'genwork.exe', { type: 'application/octet-stream' });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { uploadId: 'up1', chunkSize: 4 })); // init (server chunkSize: 4)
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { acceptedIndex: 0, totalAccepted: 1 })); // chunk 0
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' })); // chunk 1 fails

    let err: unknown;
    try {
      await uploadInstaller({ platform: 'windowsX64', file, getToken, onProgress: vi.fn() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InstallerUploadError);
    const resume = (err as InstallerUploadError).resume;
    expect(resume).toEqual({ uploadId: 'up1', totalAccepted: 1, chunkSize: 4 });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { acceptedIndex: 1, totalAccepted: 2 })); // resumed chunk 1
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'up1', fileName: 'genwork.exe', fileSize: 8, sha256: 'z' })); // complete

    const meta = await uploadInstaller({
      platform: 'windowsX64',
      file,
      getToken,
      onProgress: vi.fn(),
      resume,
    });
    expect(meta.id).toBe('up1');

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    // Calls 0-2 were the first attempt (init, chunk 0, failed chunk 1).
    // The resumed request (call 3) hits chunk index 1 computed with the
    // server's 4-byte slices (8 bytes / 4 = 2 chunks), not the 8 MiB default
    // (which would be a single chunk and skip the loop entirely).
    expect(urls[3]).toBe('http://test/admin/releases/installers/up1/chunks/1');
    expect(urls[4]).toBe('http://test/admin/releases/installers/up1/complete');
    // init was called exactly once — only by the first attempt.
    expect(urls.filter((u) => u.endsWith('/init'))).toHaveLength(1);
  });

  test('error message includes the server-stated reason (NL-1 envelope)', async () => {
    // Regression: raw() used to parse `.detail`, which the server never sends.
    // Every upload error became just "upload failed (http 400)" — the server
    // returns `{error: 'bad_order'}` (matches the rest of the codebase). After
    // the fix the parsed code flows into the thrown Error message.
    const file = new File([new Uint8Array(5).fill(65)], 'genwork.exe', { type: 'application/octet-stream' });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { uploadId: 'up1', chunkSize: 8 * 1024 * 1024 })); // init
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'bad_order' })); // chunk 0 fails

    let err: unknown;
    try {
      await uploadInstaller({ platform: 'windowsX64', file, getToken, onProgress: vi.fn() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InstallerUploadError);
    expect((err as Error).message).toBe('upload failed (http 400): bad_order');
  });
});
