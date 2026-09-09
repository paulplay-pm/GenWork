import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { McpAuthMethod, McpAuthStatus } from '../../shared/mcp/constants';
import { deriveAuthStatus,McpStore } from './mcpStore';

describe('McpStore', () => {
  let db: Database.Database | undefined;
  let store: McpStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        auth_status TEXT NOT NULL DEFAULT 'authenticated',
        last_probe_status TEXT,
        last_probe_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE mcp_launch_resolutions (
        server_id TEXT PRIMARY KEY,
        resolver_kind TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        package_name TEXT,
        requested_version TEXT,
        resolved_version TEXT,
        install_dir TEXT,
        command TEXT,
        args_json TEXT,
        env_json TEXT,
        error TEXT,
        installed_at INTEGER,
        resolved_at INTEGER,
        last_probe_at INTEGER,
        last_probe_status TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    store = new McpStore(db);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  test('clears remote headers when update passes an empty headers object', () => {
    const server = store.createServer({
      name: 'remote',
      description: '',
      transportType: 'http',
      url: 'https://mcp.example.com',
      headers: {
        Authorization: 'Bearer token',
        'X-Tenant-Id': 'tenant-123',
      },
    });

    const updated = store.updateServer(server.id, { headers: {} });

    expect(updated?.headers).toBeUndefined();
    expect(updated?.url).toBe('https://mcp.example.com');
  });

  test('drops stale remote fields when switching to stdio', () => {
    const server = store.createServer({
      name: 'switchable',
      description: '',
      transportType: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer token' },
    });

    const updated = store.updateServer(server.id, {
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'key' },
    });

    expect(updated).toMatchObject({
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'key' },
    });
    expect(updated?.url).toBeUndefined();
    expect(updated?.headers).toBeUndefined();
  });

  test('drops stale stdio fields when switching to remote', () => {
    const server = store.createServer({
      name: 'stdio-server',
      description: '',
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'key' },
    });

    const updated = store.updateServer(server.id, {
      transportType: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token' },
    });

    expect(updated).toMatchObject({
      transportType: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token' },
    });
    expect(updated?.command).toBeUndefined();
    expect(updated?.args).toBeUndefined();
    expect(updated?.env).toBeUndefined();
  });

  test('updateAuthStatus writes the column', () => {
    const s = store.createServer({ name: 'a', description: '', transportType: 'http', url: 'https://x', headers: { Authorization: 'Bearer y' } });
    store.updateAuthStatus(s.id, McpAuthStatus.NeedsAuth, 'unauthorized', Date.now());
    const after = store.getServer(s.id)!;
    expect(after.authStatus).toBe(McpAuthStatus.NeedsAuth);
  });

  test('oauth credential round-trips through updateServer + getServer', () => {
    const s = store.createServer({
      name: 'qcc',
      description: '',
      transportType: 'http',
      url: 'https://agent.qcc.com',
      headers: {},
      authMethod: McpAuthMethod.OAuth,
    });
    const updated = store.updateServer(s.id, {
      oauth: { providerId: 'qichacha', token: 'tk-1' },
    });
    expect(updated).not.toBeNull();
    // The store only persists the `oauth` sub-key — the dispatcher (in
    // mcpAuthFlows) is responsible for mirroring the token into
    // headers.Authorization before the probe runs.
    expect(updated?.headers?.Authorization).toBeUndefined();

    // Reload from disk and verify the persisted record still carries
    // authMethod (via config_json) so deriveAuthStatus recognizes it.
    const after = store.getServer(s.id)!;
    expect(after.authMethod).toBe(McpAuthMethod.OAuth);
  });

  test('round-trips oauthConfig and serverKey through the config blob', () => {
    const s = store.createServer({
      name: 'fxsk',
      description: 'fenxiang',
      transportType: 'http',
      url: 'https://fxsk.example.com/mcp',
      authMethod: McpAuthMethod.OAuth,
      serverKey: 'fxsk-mcp',
      oauthConfig: {
        authorizeUrl: 'https://idp.example.com/oauth/authorize',
        tokenUrl: 'https://idp.example.com/oauth/token',
        clientId: 'public-cid',
        scopes: ['openid'],
      },
    });
    expect(s.serverKey).toBe('fxsk-mcp');
    expect(s.oauthConfig?.clientId).toBe('public-cid');

    const updated = store.updateServer(s.id, {
      oauthConfig: { authorizeUrl: 'https://x', tokenUrl: 'https://y', clientId: 'c2' },
    });
    expect(updated?.oauthConfig?.clientId).toBe('c2');
  });

  test('oauth preserves previous token when update omits the field', () => {
    const s = store.createServer({
      name: 'qcc-keep',
      description: '',
      transportType: 'http',
      url: 'https://agent.qcc.com',
      headers: {},
    });
    store.updateServer(s.id, { oauth: { providerId: 'qichacha', token: 'tk-1' } });

    // Sanity: the token really made it into config_json on the first write.
    const row1 = db!.prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(s.id) as { config_json: string };
    expect(JSON.parse(row1.config_json).oauth).toEqual({ providerId: 'qichacha', token: 'tk-1' });

    // A subsequent update that omits `oauth` must keep the prior value
    // (existing.oauth fallback in the merge).
    const unchanged = store.updateServer(s.id, { description: 'tweaked' });
    expect(unchanged?.description).toBe('tweaked');
    const row2 = db!.prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(s.id) as { config_json: string };
    expect(JSON.parse(row2.config_json).oauth).toEqual({ providerId: 'qichacha', token: 'tk-1' });
  });
});

describe('authStatus derivation', () => {
  test('none is always authenticated', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.None })).toBe(McpAuthStatus.Authenticated);
  });
  test('bearer without Authorization → needs-auth', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.Bearer, headers: {} })).toBe(McpAuthStatus.NeedsAuth);
  });
  test('bearer with Authorization → authenticated', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.Bearer, headers: { Authorization: 'Bearer x' } }))
      .toBe(McpAuthStatus.Authenticated);
  });
  test('api-key with empty headers → needs-auth', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.ApiKey, headers: {} })).toBe(McpAuthStatus.NeedsAuth);
  });
  test('api-key with a custom header → authenticated', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.ApiKey, headers: { 'X-API-Key': 'k' } }))
      .toBe(McpAuthStatus.Authenticated);
  });
  test('api-key does not treat Authorization as the key', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.ApiKey, headers: { Authorization: 'Bearer x' } }))
      .toBe(McpAuthStatus.NeedsAuth);
  });
  test('oauth without token → needs-auth', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.OAuth, oauth: {} })).toBe(McpAuthStatus.NeedsAuth);
  });
  test('oauth with token → authenticated', () => {
    expect(deriveAuthStatus({ authMethod: McpAuthMethod.OAuth, oauth: { token: 't' } }))
      .toBe(McpAuthStatus.Authenticated);
  });
});
