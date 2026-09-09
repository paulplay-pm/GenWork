import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { McpAuthMethod } from '../../shared/mcp/constants';
import { probeOnly,saveCredential } from './mcpAuthFlows';
import type { ProbeResult } from './mcpAuthProbe';
import { McpStore } from './mcpStore';

const probeSpy = vi.fn<(...args: unknown[]) => Promise<ProbeResult>>();

vi.mock('./mcpAuthProbe', () => ({
  probeAuthorization: (...args: unknown[]) => probeSpy(...args),
}));

// Loose mock for qichacha so the OAuth path doesn't open a real BrowserWindow.
const qichachaSpy = vi.fn(async () => 'mock-qichacha-token');

vi.mock('./qichachaMcpAuth', () => ({
  startQichachaMcpApiKeyLogin: (...args: unknown[]) => qichachaSpy(...args),
}));

// Loose mock for the per-provider generic flow so no real window / localhost
// callback server opens in the unit test.
const genericFlowSpy = vi.fn(async () => 'mock-generic-token');

vi.mock('./genericOauthFlow', () => ({
  runGenericOauthFlow: (...args: unknown[]) => genericFlowSpy(...args),
}));

describe('mcpAuthFlows', () => {
  let db: Database.Database | undefined;
  let store: McpStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1, transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        auth_status TEXT NOT NULL DEFAULT 'authenticated',
        last_probe_status TEXT, last_probe_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY, resolver_kind TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL, status TEXT NOT NULL,
        package_name TEXT, requested_version TEXT, resolved_version TEXT,
        install_dir TEXT, command TEXT, args_json TEXT, env_json TEXT,
        error TEXT, installed_at INTEGER, resolved_at INTEGER,
        last_probe_at INTEGER, last_probe_status TEXT, updated_at INTEGER NOT NULL
      );
    `);
    store = new McpStore(db);
    probeSpy.mockReset();
    probeSpy.mockResolvedValue({ ok: true, status: 'authorized', latencyMs: 5 });
    qichachaSpy.mockClear();
    genericFlowSpy.mockClear();
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  test('saveCredential with bearer persists Authorization header on HTTP and probes', async () => {
    const s = store.createServer({
      name: 'fx',
      description: '',
      transportType: 'http',
      url: 'https://x',
      headers: {},
      authMethod: McpAuthMethod.Bearer,
    });
    const res = await saveCredential(null, s.id, { kind: 'bearer', bearer: 'tok-123' }, { store });
    expect(res.ok).toBe(true);
    const after = store.getServer(s.id)!;
    expect(after.headers?.Authorization).toBe('Bearer tok-123');
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  test('saveCredential with bearer on stdio stashes token under env.API_KEY', async () => {
    const s = store.createServer({
      name: 'local',
      description: '',
      transportType: 'stdio',
      command: 'node',
      args: ['srv.js'],
      env: {},
    });
    const res = await saveCredential(null, s.id, { kind: 'bearer', bearer: 'tok-stdio' }, { store });
    expect(res.ok).toBe(true);
    const after = store.getServer(s.id)!;
    expect(after.env?.API_KEY).toBe('tok-stdio');
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  test('saveCredential with apiKey writes header on HTTP', async () => {
    const s = store.createServer({
      name: 'api',
      description: '',
      transportType: 'http',
      url: 'https://x',
      headers: {},
    });
    const res = await saveCredential(
      null,
      s.id,
      { kind: 'apiKey', headerName: 'X-API-Key', value: 'kv' },
      { store },
    );
    expect(res.ok).toBe(true);
    const after = store.getServer(s.id)!;
    expect(after.headers?.['X-API-Key']).toBe('kv');
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  test('saveCredential with apiKey writes env on stdio', async () => {
    const s = store.createServer({
      name: 'api-stdio',
      description: '',
      transportType: 'stdio',
      command: 'node',
      args: ['srv.js'],
      env: {},
    });
    const res = await saveCredential(
      null,
      s.id,
      { kind: 'apiKey', headerName: 'IGNORED', value: 'kv' },
      { store },
    );
    expect(res.ok).toBe(true);
    const after = store.getServer(s.id)!;
    expect(after.env?.IGNORED).toBe('kv');
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  test('saveCredential with env on stdio merges into env without touching headers', async () => {
    const s = store.createServer({
      name: 'env-srv',
      description: '',
      transportType: 'stdio',
      command: 'node',
      args: ['srv.js'],
      env: { EXISTING: 'yes' },
    });
    const res = await saveCredential(
      null,
      s.id,
      { kind: 'env', envKey: 'NEW_KEY', value: 'v' },
      { store },
    );
    expect(res.ok).toBe(true);
    const after = store.getServer(s.id)!;
    expect(after.env).toEqual({ EXISTING: 'yes', NEW_KEY: 'v' });
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  test('saveCredential with oauth runs qichacha flow, persists oauth sub-key + Authorization header', async () => {
    const s = store.createServer({
      name: 'qcc',
      description: '',
      transportType: 'http',
      url: 'https://agent.qcc.com/mcp/company/stream',
      headers: {},
    });
    const res = await saveCredential(
      null,
      s.id,
      { kind: 'oauth', providerId: 'qichacha' },
      { store },
    );
    expect(res.ok).toBe(true);
    expect(qichachaSpy).toHaveBeenCalledTimes(1);
    const after = store.getServer(s.id)!;
    expect(after.headers?.Authorization).toBe('Bearer mock-qichacha-token');
    expect(after.authMethod).toBe(McpAuthMethod.OAuth);
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  test('oauth payload with a generic:<serverKey> providerId drives the generic flow and persists the token', async () => {
    const s = store.createServer({
      name: 'fxsk',
      description: '',
      transportType: 'http',
      url: 'https://fxsk.example.com/mcp',
      authMethod: McpAuthMethod.OAuth,
    });
    const res = await saveCredential(
      null,
      s.id,
      {
        kind: 'oauth',
        providerId: 'generic:fxsk-mcp',
        oauthConfig: { authorizeUrl: 'https://idp/a', tokenUrl: 'https://idp/t', clientId: 'c' },
      },
      { store },
    );
    expect(res.ok).toBe(true);
    expect(genericFlowSpy).toHaveBeenCalledTimes(1);
    // Guardrail: the generic path must not fall through to the built-in
    // qichacha registry entry.
    expect(qichachaSpy).not.toHaveBeenCalled();
    const after = store.getServer(s.id)!;
    expect(after.oauth?.providerId).toBe('generic:fxsk-mcp');
    expect(after.authMethod).toBe(McpAuthMethod.OAuth);
    expect(after.headers?.Authorization).toMatch(/^Bearer /);
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  test('saveCredential with unknown oauth provider returns ok=false without probing', async () => {
    const s = store.createServer({
      name: 'foo',
      description: '',
      transportType: 'http',
      url: 'https://x',
      headers: {},
    });
    const res = await saveCredential(
      null,
      s.id,
      { kind: 'oauth', providerId: 'made-up-provider' },
      { store },
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/unknown oauth provider/);
    expect(probeSpy).not.toHaveBeenCalled();
  });

  test('saveCredential returns server-not-found for missing id', async () => {
    const res = await saveCredential(null, 'no-such', { kind: 'bearer', bearer: 'x' }, { store });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/not found/);
    expect(probeSpy).not.toHaveBeenCalled();
  });

  test('saveCredential still returns ok=true when probe fails (credential is persisted first)', async () => {
    probeSpy.mockResolvedValueOnce({ ok: false, status: 'unauthorized', latencyMs: 10, error: 'HTTP 401' });
    const s = store.createServer({
      name: 'flaky',
      description: '',
      transportType: 'http',
      url: 'https://flaky',
      headers: {},
    });
    const res = await saveCredential(null, s.id, { kind: 'bearer', bearer: 't' }, { store });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.status).toBe('unauthorized');
    }
    expect(store.getServer(s.id)?.headers?.Authorization).toBe('Bearer t');
  });

  test('probeOnly runs the probe against the stored record', async () => {
    const s = store.createServer({
      name: 'p',
      description: '',
      transportType: 'http',
      url: 'https://p',
      headers: { Authorization: 'Bearer pre' },
    });
    const result = await probeOnly(s.id, { store });
    expect(result.ok).toBe(true);
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  test('probeOnly returns connect-error for unknown id', async () => {
    const result = await probeOnly('nope', { store });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('connect-error');
    expect(probeSpy).not.toHaveBeenCalled();
  });
});
