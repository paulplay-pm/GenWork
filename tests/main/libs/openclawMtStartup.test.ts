import { beforeEach,describe, expect, test, vi } from 'vitest';

vi.mock('../../../src/main/auth/sessionStorage', () => {
  const save = vi.fn();
  const load = vi.fn();
  const clear = vi.fn();
  const configure = vi.fn();
  return {
    sessionStorage: { save, load, clear, configure },
  };
});

vi.mock('../../../src/main/auth/enterpriseClient', () => {
  const getModels = vi.fn();
  const refresh = vi.fn();
  return {
    enterpriseClient: {
      getModels,
      refresh,
      configure: vi.fn(),
      setTokenProvider: vi.fn(),
      login: vi.fn(),
      postAudit: vi.fn(),
      getMe: vi.fn(),
      getPolicies: vi.fn(),
      getUsageToday: vi.fn(),
      archiveUpload: vi.fn(),
      persistSession: vi.fn(),
      logout: vi.fn(),
    },
  };
});

import { bootstrapEnterpriseMtGateway } from '../../../src/main/libs/openclawMtStartup';

describe('main/libs/openclawMtStartup', () => {
  beforeEach(async () => {
    const { sessionStorage } = await import('../../../src/main/auth/sessionStorage');
    const { enterpriseClient } = await import('../../../src/main/auth/enterpriseClient');
    (sessionStorage.load as unknown as ReturnType<typeof vi.fn>).mockReset();
    (sessionStorage.save as unknown as ReturnType<typeof vi.fn>).mockReset();
    (enterpriseClient.refresh as unknown as ReturnType<typeof vi.fn>).mockReset();
    (enterpriseClient.getModels as unknown as ReturnType<typeof vi.fn>).mockReset();
    delete process.env.ENTERPRISE_SERVER_URL;
  });

  test('ENTERPRISE_SERVER_URL 未设置 → wired=false', async () => {
    const r = await bootstrapEnterpriseMtGateway({
      gatewayTokenPath: '/tmp/gw-token',
      readConfig: () => ({}),
      writeConfig: () => {},
    });
    expect(r.wired).toBe(false);
  });

  test('无 session → wired=false', async () => {
    process.env.ENTERPRISE_SERVER_URL = 'http://ent';
    const { sessionStorage } = await import('../../../src/main/auth/sessionStorage');
    (sessionStorage.load as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const r = await bootstrapEnterpriseMtGateway({
      gatewayTokenPath: '/tmp/gw-token',
      readConfig: () => ({}),
      writeConfig: () => {},
    });
    expect(r.wired).toBe(false);
    expect(r.reason).toMatch(/no_enterprise_session/);
  });

  test('session 过期 → refresh 失败 → wired=false', async () => {
    process.env.ENTERPRISE_SERVER_URL = 'http://ent';
    const { sessionStorage } = await import('../../../src/main/auth/sessionStorage');
    const { enterpriseClient } = await import('../../../src/main/auth/enterpriseClient');
    (sessionStorage.load as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      userId: 'u1',
      orgId: 'o1',
      username: 'a',
      displayName: 'A',
      roles: ['user'],
      jwt: 'old',
      expiresAt: Date.now() - 100,
    });
    (enterpriseClient.refresh as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('token expired')
    );
    const r = await bootstrapEnterpriseMtGateway({
      gatewayTokenPath: '/tmp/gw-token',
      readConfig: () => ({}),
      writeConfig: () => {},
    });
    expect(r.wired).toBe(false);
  });

  test('happy path: 写 gateway token + 注入 endpoint-only provider config', async () => {
    process.env.ENTERPRISE_SERVER_URL = 'http://ent';
    const { sessionStorage } = await import('../../../src/main/auth/sessionStorage');
    const { enterpriseClient } = await import('../../../src/main/auth/enterpriseClient');
    (sessionStorage.load as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      userId: 'u1',
      orgId: 'o1',
      username: 'a',
      displayName: 'A',
      roles: ['user'],
      jwt: 'jwt-xyz',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    (enterpriseClient.getModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'm1',
        provider: 'openai',
        model: 'gpt-4o',
        display_name: 'GPT-4o',
        quota_per_user_per_day: 100000,
        enabled: true,
      },
    ]);
    const written: Array<Record<string, unknown>> = [];
    const r = await bootstrapEnterpriseMtGateway({
      gatewayTokenPath: '/tmp/genwork-gw-token-' + Date.now(),
      readConfig: () => ({ gateway: { mode: 'local' } }),
      writeConfig: (cfg) => written.push(cfg),
    });
    expect(r.wired).toBe(true);
    const last = written[written.length - 1];
    const gw = last.gateway as Record<string, unknown>;
    const providers = gw.providers as Record<string, { endpoint: string; model: string }>;
    expect(providers.openai.endpoint).toBe('http://ent/proxy/openai');
    expect(providers.openai.model).toBe('gpt-4o');
  });
});