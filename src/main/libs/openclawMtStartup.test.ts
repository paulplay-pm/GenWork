import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const sessionState = vi.hoisted(() => ({
  loadReturn: null as null | {
    userId: string;
    orgId: string;
    username: string;
    displayName: string;
    roles: string[];
    jwt: string;
    expiresAt: number;
  },
  savedWith: null as unknown,
  refreshImpl: null as null | (() => Promise<{ token: string }>),
  getModelsImpl: null as null | (() => Promise<unknown[]>),
}));

vi.mock('../auth/sessionStorage', () => ({
  sessionStorage: {
    load: () => sessionState.loadReturn,
    save: (s: unknown) => {
      sessionState.savedWith = s;
    },
  },
}));

vi.mock('../auth/enterpriseClient', () => ({
  enterpriseClient: {
    refresh: () => sessionState.refreshImpl!(),
    getModels: () => sessionState.getModelsImpl!(),
  },
}));

const electronPaths = vi.hoisted(() => ({
  userData: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return electronPaths.userData;
      return electronPaths.userData;
    },
    isPackaged: false,
  },
}));

import { bootstrapEnterpriseMtGateway } from './openclawMtStartup';

const ORIGINAL_ENV = { ...process.env };

describe('bootstrapEnterpriseMtGateway', () => {
  let tmpDir: string;
  let tokenPath: string;

  beforeEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawMtStartup-test-'));
    electronPaths.userData = path.join(tmpDir, 'userData');
    fs.mkdirSync(electronPaths.userData, { recursive: true });
    tokenPath = path.join(tmpDir, 'gateway-token');
    sessionState.loadReturn = null;
    sessionState.savedWith = null;
    sessionState.refreshImpl = null;
    sessionState.getModelsImpl = null;
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('returns wired=false with enterprise_server_url_unset when env is missing', async () => {
    delete process.env.ENTERPRISE_SERVER_URL;
    const result = await bootstrapEnterpriseMtGateway({
      gatewayTokenPath: tokenPath,
      readConfig: () => ({}),
      writeConfig: () => {},
      log: () => {},
    });
    expect(result.wired).toBe(false);
    if (!result.wired) {
      expect(result.reason).toBe('enterprise_server_url_unset');
    }
  });

  test('returns wired=false with no_enterprise_session when no session is loaded', async () => {
    process.env.ENTERPRISE_SERVER_URL = 'http://ent';
    sessionState.loadReturn = null;
    const result = await bootstrapEnterpriseMtGateway({
      gatewayTokenPath: tokenPath,
      readConfig: () => ({}),
      writeConfig: () => {},
      log: () => {},
    });
    expect(result.wired).toBe(false);
    if (!result.wired) {
      expect(result.reason).toBe('no_enterprise_session');
    }
  });

  test('returns wired=true, writes JWT to gateway token path, and writes provider block to config', async () => {
    process.env.ENTERPRISE_SERVER_URL = 'http://ent';
    sessionState.loadReturn = {
      userId: 'u1',
      orgId: 'o1',
      username: 'user',
      displayName: 'User',
      roles: ['user'],
      jwt: 'jwt-abc',
      // Far future — no refresh triggered
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    sessionState.getModelsImpl = async () => [
      { id: 'm1', provider: 'openai', model: 'gpt-4o', enabled: true },
      { id: 'm2', provider: 'anthropic', model: 'claude-sonnet', enabled: true },
    ];
    let written: Record<string, unknown> | undefined;
    const result = await bootstrapEnterpriseMtGateway({
      gatewayTokenPath: tokenPath,
      readConfig: () => ({}),
      writeConfig: (cfg) => {
        written = cfg;
      },
      log: () => {},
    });
    expect(result.wired).toBe(true);
    if (result.wired) {
      expect(result.modelEndpoints).toBe(2);
    }
    expect(fs.readFileSync(tokenPath, 'utf8')).toBe('jwt-abc');
    expect(written).toBeDefined();
    const gateway = (written as { gateway?: { providers?: Record<string, { endpoint: string; model: string }> } })
      .gateway;
    expect(gateway?.providers?.openai?.endpoint).toBe('http://ent/proxy/openai');
    expect(gateway?.providers?.openai?.model).toBe('gpt-4o');
    expect(gateway?.providers?.anthropic?.endpoint).toBe('http://ent/proxy/anthropic');
  });

  test('refreshes JWT when session is about to expire, persists new JWT', async () => {
    process.env.ENTERPRISE_SERVER_URL = 'http://ent';
    sessionState.loadReturn = {
      userId: 'u1',
      orgId: 'o1',
      username: 'user',
      displayName: 'User',
      roles: ['user'],
      jwt: 'old-jwt',
      // Already past the 30s grace
      expiresAt: Date.now() + 5_000,
    };
    let refreshCalls = 0;
    sessionState.refreshImpl = async () => {
      refreshCalls += 1;
      return { token: 'new-jwt' };
    };
    sessionState.getModelsImpl = async () => [];
    const result = await bootstrapEnterpriseMtGateway({
      gatewayTokenPath: tokenPath,
      readConfig: () => ({}),
      writeConfig: () => {},
      log: () => {},
    });
    expect(refreshCalls).toBe(1);
    expect(result.wired).toBe(true);
    expect(fs.readFileSync(tokenPath, 'utf8')).toBe('new-jwt');
    expect(sessionState.savedWith).toMatchObject({ jwt: 'new-jwt' });
  });

  test('returns wired=false with token_refresh_failed when refresh throws', async () => {
    process.env.ENTERPRISE_SERVER_URL = 'http://ent';
    sessionState.loadReturn = {
      userId: 'u1',
      orgId: 'o1',
      username: 'user',
      displayName: 'User',
      roles: ['user'],
      jwt: 'old-jwt',
      expiresAt: Date.now() + 5_000,
    };
    sessionState.refreshImpl = async () => {
      throw new Error('refresh boom');
    };
    const result = await bootstrapEnterpriseMtGateway({
      gatewayTokenPath: tokenPath,
      readConfig: () => ({}),
      writeConfig: () => {},
      log: () => {},
    });
    expect(result.wired).toBe(false);
    if (!result.wired) {
      expect(result.reason).toBe('token_refresh_failed');
    }
  });

  test('returns wired=false gracefully when getModels throws (does not block startup)', async () => {
    process.env.ENTERPRISE_SERVER_URL = 'http://ent';
    sessionState.loadReturn = {
      userId: 'u1',
      orgId: 'o1',
      username: 'user',
      displayName: 'User',
      roles: ['user'],
      jwt: 'jwt-abc',
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    sessionState.getModelsImpl = async () => {
      throw new Error('catalog boom');
    };
    let written: Record<string, unknown> | undefined;
    const result = await bootstrapEnterpriseMtGateway({
      gatewayTokenPath: tokenPath,
      readConfig: () => ({}),
      writeConfig: (cfg) => {
        written = cfg;
      },
      log: () => {},
    });
    // Should still wire (token rewrite succeeds; model list is best-effort)
    expect(result.wired).toBe(true);
    if (result.wired) {
      expect(result.modelEndpoints).toBe(0);
    }
    expect(fs.readFileSync(tokenPath, 'utf8')).toBe('jwt-abc');
    expect(written).toBeDefined();
  });
});
