import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { McpAuthMethod } from '../../shared/mcp/constants';
import type { McpServerRecord } from './mcpStore';
import { McpStore } from './mcpStore';

// Hoist the spawn mock so it is in place when the module under test is imported.
const spawnMock = vi.hoisted(() => vi.fn<(cmd: string, args: readonly string[], opts: unknown) => MockChild>());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

interface MockChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  kill: ReturnType<typeof vi.fn>;
}

function makeMockChild(): MockChild {
  const stdout = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk, _enc, cb) { cb(); },
  });
  const child = new EventEmitter() as MockChild;
  child.stdout = stdout;
  child.stdin = stdin;
  child.kill = vi.fn();
  return child;
}

function baseRecord(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: 'srv-1',
    name: 'test',
    description: '',
    enabled: true,
    transportType: 'http',
    isBuiltIn: false,
    authMethod: McpAuthMethod.None,
    authStatus: 'authenticated',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeInMemoryStore(): McpStore {
  const db = new Database(':memory:');
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
  `);
  return new McpStore(db);
}

// Import after vi.mock so the module under test sees the mocked spawn.
import { probeAuthorization } from './mcpAuthProbe';

let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  spawnMock.mockReset();
});

afterEach(() => {
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = originalFetch as typeof globalThis.fetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('probeAuthorization — HTTP transport', () => {
  test('HTTP ok: 200 with JSON-RPC result marks authorized and surfaces serverInfo', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'fxm', version: '1' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const result = await probeAuthorization(baseRecord({ url: 'https://mcp.example.com' }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe('authorized');
    expect(result.serverInfo).toEqual({ name: 'fxm', version: '1' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [_url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).method).toBe('initialize');
  });

  test('HTTP 401 returns unauthorized', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const result = await probeAuthorization(baseRecord({ url: 'https://mcp.example.com' }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe('unauthorized');
    expect(result.error).toBe('HTTP 401');
  });

  test('HTTP 403 returns unauthorized', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const result = await probeAuthorization(baseRecord({ url: 'https://mcp.example.com' }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe('unauthorized');
    expect(result.error).toBe('HTTP 403');
  });

  test('HTTP timeout (AbortError) returns connect-error with timeout message', async () => {
    const fetchSpy = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const result = await probeAuthorization(baseRecord({ url: 'https://mcp.example.com' }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe('connect-error');
    expect(result.error).toMatch(/timeout/);
  });

  test('bearer authMethod with no Authorization header returns missing-credential before any network call', async () => {
    const fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const result = await probeAuthorization(
      baseRecord({ authMethod: McpAuthMethod.Bearer, url: 'https://mcp.example.com' }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe('missing-credential');
    expect(result.error).toMatch(/Authorization/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('SSE transport accepts `data: {…}` frame and reports authorized', async () => {
    const body =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"sse-srv","version":"2.0"}}}\n' +
      '\n';
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const result = await probeAuthorization(
      baseRecord({ transportType: 'sse', url: 'https://mcp.example.com/sse' }),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe('authorized');
    expect(result.serverInfo).toEqual({ name: 'sse-srv', version: '2.0' });
  });

  test('OAuth authMethod without Authorization header returns missing-credential with re-authorize hint', async () => {
    const fetchSpy = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const result = await probeAuthorization(
      baseRecord({ authMethod: McpAuthMethod.OAuth, url: 'https://mcp.example.com' }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe('missing-credential');
    expect(result.error).toMatch(/re-authorize/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('probeAuthorization — stdio transport', () => {
  test('stdio ok: child responds with serverInfo on next line', async () => {
    const child = makeMockChild();
    spawnMock.mockReturnValue(child);

    const p = probeAuthorization(
      baseRecord({
        transportType: 'stdio',
        command: 'node',
        args: ['server.js'],
        authMethod: McpAuthMethod.None,
      }),
    );

    // Allow the spawn call and listeners to register before emitting data.
    await new Promise((r) => setImmediate(r));
    child.stdout.emit(
      'data',
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"local-mcp","version":"0.1"}}}\n',
      ),
    );

    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.status).toBe('authorized');
    expect(result.serverInfo).toEqual({ name: 'local-mcp', version: '0.1' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('stdio missing credential: bearer authMethod with empty headers returns missing-credential', async () => {
    const result = await probeAuthorization(
      baseRecord({
        transportType: 'stdio',
        command: 'node',
        args: ['server.js'],
        authMethod: McpAuthMethod.Bearer,
        headers: {},
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe('missing-credential');
    expect(result.error).toMatch(/Authorization/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('probeAuthorization — writeback', () => {
  test('persists auth-error / unauthorized when bearer probe returns 401', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const store = makeInMemoryStore();
    const updateSpy = vi.spyOn(store, 'updateAuthStatus');

    const result = await probeAuthorization(
      baseRecord({
        authMethod: McpAuthMethod.Bearer,
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer stale' },
      }),
      store,
    );

    expect(result.status).toBe('unauthorized');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [id, authStatus, lastProbeStatus, lastProbeAt] = updateSpy.mock.calls[0];
    expect(id).toBe('srv-1');
    expect(authStatus).toBe('auth-error');
    expect(lastProbeStatus).toBe('unauthorized');
    expect(typeof lastProbeAt).toBe('number');
  });

  test('writeback failure is swallowed and does not propagate', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeInMemoryStore();
    vi.spyOn(store, 'updateAuthStatus').mockImplementation(() => {
      throw new Error('disk full');
    });

    const result = await probeAuthorization(
      baseRecord({
        authMethod: McpAuthMethod.Bearer,
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer stale' },
      }),
      store,
    );

    // Caller still gets the probe outcome — DB failure is non-fatal.
    expect(result.status).toBe('unauthorized');
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/mcpAuthProbe/);
  });
});
