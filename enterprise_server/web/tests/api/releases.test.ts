import { beforeEach,describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { apiClient } from '../../src/api/client';
import { releasesApi } from '../../src/api/releases';

describe('api/releases', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    apiClient.setBaseUrl('http://test');
    apiClient.setTokenProvider(() => 'tok');
  });

  test('list hits /admin/releases with orgId', async () => {
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 }));
    await releasesApi.list('o1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/admin/releases?orgId=o1');
    expect(init.method).toBe('GET');
  });

  test('add POSTs the structured body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"id":"r1"}', { status: 200 }));
    const id = await releasesApi.add({
      orgId: 'o1',
      version: '1.2.0',
      changeLog: { zh: { title: 't', content: ['a'] } },
      installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
    });
    expect(id).toBe('r1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/admin/releases');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      orgId: 'o1',
      version: '1.2.0',
      changeLog: { zh: { title: 't', content: ['a'] } },
      installers: { macArm: { id: 'file-1', fileName: 'a.dmg', fileSize: 10, sha256: 's' } },
    });
  });

  test('setLatest POSTs to /admin/releases/:id/set-latest', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await releasesApi.setLatest('r1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/admin/releases/r1/set-latest');
    expect(init.method).toBe('POST');
  });

  test('remove DELETEs /admin/releases/:id', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    await releasesApi.remove('r1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/admin/releases/r1');
    expect(init.method).toBe('DELETE');
  });
});
