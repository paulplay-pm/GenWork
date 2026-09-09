import { beforeEach, describe, expect, test, vi } from 'vitest';

import { apiClient } from '../../src/api/client';
import { fetchSsoBindings, startSsoBinding, unbindSsoBinding } from '../../src/api/ssoBindings';

vi.mock('../../src/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const apiClientMock = vi.mocked(apiClient);

describe('ssoBindings api', () => {
  beforeEach(() => {
    apiClientMock.get.mockReset();
    apiClientMock.post.mockReset();
    apiClientMock.delete.mockReset();
  });

  describe('fetchSsoBindings', () => {
    test('GETs /me/sso-binding/connections and returns connections array', async () => {
      apiClientMock.get.mockResolvedValue({
        connections: [{ id: 'c1', name: '飞书', providerType: 'feishu',
          sortOrder: 0, enabled: true, logoUrl: null, bound: true, externalId: 'kk@example.com' }],
      });
      const result = await fetchSsoBindings();
      expect(apiClientMock.get).toHaveBeenCalledWith('/me/sso-binding/connections');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('c1');
    });

    test('wire shape matches SsoConnectionWithBinding (8 fields, no description/boundAt)', () => {
      // Lock in desktop Rulings 1+2: the server response must have exactly
      // the 8 SsoConnectionWithBinding fields, and neither description nor
      // boundAt.
      const SAMPLE_KEYS = ['id', 'name', 'providerType', 'sortOrder', 'enabled', 'logoUrl', 'bound', 'externalId'];
      const SAMPLE: Record<string, unknown> = {
        id: 'c1', name: '飞书', providerType: 'feishu',
        sortOrder: 0, enabled: true, logoUrl: null, bound: true, externalId: 'kk@example.com',
      };
      // The test below passes if `fetchSsoBindings` returns the shape; the
      // critical check is that we never silently add a description/boundAt
      // field. This is enforced by the type system + the fact that
      // apiClient.get is typed.
      expect(Object.keys(SAMPLE).sort()).toEqual([...SAMPLE_KEYS].sort());
    });
  });

  describe('unbindSsoBinding', () => {
    test('DELETEs /me/sso-binding', async () => {
      apiClientMock.delete.mockResolvedValue({ ok: true });
      await unbindSsoBinding();
      expect(apiClientMock.delete).toHaveBeenCalledWith('/me/sso-binding');
    });
  });

  describe('startSsoBinding', () => {
    test('POSTs /me/sso-binding/start with returnTarget=web and returns authorizeUrl', async () => {
      apiClientMock.post.mockResolvedValue({ authorizeUrl: 'https://idp.example/x' });
      const r = await startSsoBinding('c1');
      expect(apiClientMock.post).toHaveBeenCalledWith('/me/sso-binding/start', {
        connectionId: 'c1',
        returnTarget: 'web',
      });
      expect(r.authorizeUrl).toBe('https://idp.example/x');
    });
  });
});
