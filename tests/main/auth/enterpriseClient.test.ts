import { beforeEach,describe, expect, test, vi } from 'vitest';

import { enterpriseClient } from '../../../src/main/auth/enterpriseClient';
import { loginGate } from '../../../src/main/auth/loginGate';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

const fakeSession = {
  userId: 'u1',
  orgId: 'o1',
  username: 'alice',
  displayName: 'Alice',
  roles: [],
  jwt: 'jwt-1',
  expiresAt: Date.now() + 60 * 60 * 1000,
};

describe('main/auth/enterpriseClient', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    enterpriseClient.configure('https://test');
  });

  test('login 成功返回 token', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'jwt-1' }), { status: 200 })
    );
    const r = await enterpriseClient.login('o1', 'a', 'pw');
    expect(r.token).toBe('jwt-1');
  });

  test('getModels 过滤掉含 key 的字段', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 'm1',
            provider: 'openai',
            model: 'gpt-4o',
            api_key: 'sk-leak',
            quota_per_user_per_day: 100,
            enabled: true,
          },
        ]),
        { status: 200 }
      )
    );
    const list = await enterpriseClient.getModels();
    expect(list[0]).not.toHaveProperty('api_key');
    expect(list[0].model).toBe('gpt-4o');
  });

  test('401 抛 unauthorized', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(enterpriseClient.getModels()).rejects.toThrow(/unauthorized/i);
  });

  test('401 session-expired (error: unauthorized) locks the gate', async () => {
    loginGate.unlock(fakeSession);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    );
    await expect(enterpriseClient.getModels()).rejects.toThrow(/unauthorized/i);
    // The gate must be locked so the renderer returns to LoginPage.
    expect(loginGate.current()).toBeNull();
  });

  test('401 invalid_current does NOT lock the gate', async () => {
    loginGate.unlock(fakeSession);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_current' }), { status: 401 })
    );
    const r = await enterpriseClient.changePassword('wrong', 'newPass123');
    expect(r).toEqual({ ok: false, error: 'invalid_current' });
    // The wrong-password 401 is a business error; the session must stay valid.
    expect(loginGate.current()).not.toBeNull();
  });

  test('401 on a wrong current password keeps the session', async () => {
    loginGate.unlock(fakeSession);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_current' }), { status: 401 })
    );
    const r = await enterpriseClient.changePassword('wrong', 'newPass123');
    expect(r.ok).toBe(false);
    expect(() => loginGate.requireEnterprise()).not.toThrow();
  });

  test('postAudit 重试一次', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await enterpriseClient.postAudit([{ action: 'mcp_call' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});