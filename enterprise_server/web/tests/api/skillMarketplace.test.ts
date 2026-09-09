import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { apiClient } from '../../src/api/client';
import { skillMarketplaceApi } from '../../src/api/skillMarketplace';

beforeEach(() => {
  fetchMock.mockReset();
  apiClient.setBaseUrl('http://server');
  apiClient.setTokenProvider(() => 'tok');
});

describe('skillMarketplaceApi', () => {
  test('listSkills hits the admin route', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await skillMarketplaceApi.listSkills();
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://server/api/admin/skill-marketplace/skills');
  });

  test('uploadZip posts raw bytes with a zip content-type', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'uploaded' }), { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3]);
    const res = await skillMarketplaceApi.uploadZip('s1', bytes as unknown as File);
    expect(res).toEqual({ status: 'uploaded' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('content-type')).toBe('application/zip');
    // the binary body is passed through as-is — never JSON.stringify'd by the client
    expect(init.body).toBe(bytes);
  });
});
