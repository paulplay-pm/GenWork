import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const clearStorageDataMock = vi.fn().mockResolvedValue(undefined);
vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn((name: string) => ({
      _name: name,
      clearStorageData: clearStorageDataMock,
    })),
  },
}));

import { enterpriseClient } from './enterpriseClient';

beforeEach(() => {
  clearStorageDataMock.mockClear();
});

/**
 * The desktop sends the org *name* the user picked (the login field is the
 * org name, not a UUID). The server's /auth/login schema reads that value
 * from the `orgName` key and drops unknown keys, so the wire key must be
 * `orgName` — a stray `orgId` key is silently ignored and multi-org login
 * fails with org_required.
 */
describe('enterpriseClient.login', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('posts the chosen org name under the orgName key', async () => {
    const captured: { body: string }[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      captured.push({ body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ token: 't' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    enterpriseClient.configure('https://srv.example.com');
    const r = await enterpriseClient.login('Acme', 'alice', 'pw');

    expect(r.token).toBe('t');
    expect(captured).toHaveLength(1);
    const sent = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    expect(sent.orgName).toBe('Acme');
    expect(sent.username).toBe('alice');
    expect('orgId' in sent).toBe(false);
  });
});

describe('enterpriseClient.submitConnectorRequest', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('posts the FULL cfg (secrets intact) to /admin/mcp-connectors/submissions with the org JWT', async () => {
    const captured: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 'sub-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    enterpriseClient.configure('https://srv.example.com');
    enterpriseClient.setTokenProvider(() => 'org-jwt');
    const cfg = {
      serverKey: 'my-data',
      url: 'https://mcp.example.com/sse',
      transport: 'sse' as const,
      authMode: 'shared-key' as const,
      authConfig: { apiKey: 'sk-member-secret' },
    };
    const r = await enterpriseClient.submitConnectorRequest(cfg);

    expect(r).toEqual({ id: 'sub-1' });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('https://srv.example.com/admin/mcp-connectors/submissions');
    const headers = new Headers(captured[0]!.init?.headers as HeadersInit | undefined);
    expect(headers.get('authorization')).toBe('Bearer org-jwt');
    const sent = JSON.parse(String(captured[0]!.init?.body)) as Record<string, unknown>;
    expect(sent.serverKey).toBe('my-data');
    // The submit path must NOT run the list-getter `sanitize` — the member's
    // own secret travels to the server, which encrypts it on approve.
    expect((sent.authConfig as { apiKey?: string }).apiKey).toBe('sk-member-secret');
    expect('orgId' in sent).toBe(false);
  });
});

describe('enterpriseClient.logout', () => {
  test('clears the genwork-sso-oauth partition with the expected storages', async () => {
    await enterpriseClient.logout();
    expect(clearStorageDataMock).toHaveBeenCalledTimes(1);
    const [arg] = clearStorageDataMock.mock.calls[0]!;
    expect(arg).toEqual({
      storages: expect.arrayContaining([
        'cookies', 'indexdb', 'localstorage', 'serviceworkers', 'cachestorage',
      ]),
    });
  });

  test('does not throw when clearStorageData rejects (best-effort)', async () => {
    clearStorageDataMock.mockRejectedValueOnce(new Error('session closed'));
    await expect(enterpriseClient.logout()).resolves.toBeUndefined();
  });
});
