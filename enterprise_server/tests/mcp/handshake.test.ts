/**
 * Unit tests for the real MCP handshake (probeConnector).
 *
 * These tests do a genuine `initialize` + `tools/list` round-trip against
 * local in-process MCP servers (SDK `Server` over StreamableHTTP / legacy SSE
 * on ephemeral 127.0.0.1 ports) — no DB, no mocks of the SDK client.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { probeConnector } from '../../src/mcp/handshake';

const MCP_TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'get_time',
    description: 'Current server time',
    inputSchema: { type: 'object', properties: {} },
  },
];

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no address'));
      resolve(addr.port);
    });
  });
}

/** Real in-process MCP server over Streamable HTTP (ephemeral port). */
async function startStreamableHttpServer(): Promise<TestServer> {
  const mcp = new McpServer({ name: 'probe-test-mcp', version: '9.9.9' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  // Wire the protocol handlers into the transport (Server.connect also calls
  // transport.start()). Without this, requests hit the transport but no
  // handler ever answers them.
  await mcp.connect(transport);
  const http = createServer((req, res) => {
    void transport.handleRequest(req, res).catch(() => undefined);
  });
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await transport.close().catch(() => undefined);
      // Fire-and-forget: awaiting http.close() can hang in sandboxed envs
      // while an SSE stream socket lingers; closeAllConnections releases it.
      http.closeAllConnections();
      try {
        http.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Real in-process MCP server over the legacy SSE transport (ephemeral port). */
async function startSseServer(): Promise<TestServer> {
  const mcp = new McpServer({ name: 'probe-test-mcp-sse', version: '9.9.9' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));
  let sse: SSEServerTransport | undefined;
  const http = createServer((req, res) => {
    if (req.method === 'GET') {
      sse = new SSEServerTransport('/sse-message', res);
      res.on('close', () => {
        void sse?.close().catch(() => undefined);
      });
      // Server.connect() sets up the message handlers AND starts the SSE
      // stream (sends the `endpoint` event) — do not call start() manually.
      void mcp.connect(sse).catch(() => undefined);
    } else if (req.method === 'POST') {
      // The client posts to `/sse-message?sessionId=...` — match by path.
      const path = (req.url ?? '').split('?')[0];
      if (path === '/sse-message') {
        void sse?.handlePostMessage(req, res).catch(() => undefined);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/sse`,
    close: async () => {
      await sse?.close().catch(() => undefined);
      http.closeAllConnections();
      try {
        http.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Plain HTTP server that answers every request with a fixed status. */
function startStatusServer(status: number): Promise<TestServer> {
  const http = createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end('denied');
  });
  return listen(http).then(port => ({
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>(resolve => http.close(() => resolve())),
  }));
}

/** Port that is guaranteed to be closed (connection refused). */
async function deadUrl(): Promise<string> {
  const http = createServer(() => undefined);
  const port = await listen(http);
  await new Promise<void>(resolve => http.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

describe('probeConnector (real MCP handshake)', () => {
  test('success over Streamable HTTP: initialize + tools/list round-trip', async () => {
    const srv = await startStreamableHttpServer();
    try {
      const res = await probeConnector({
        url: srv.url,
        transport: 'http',
        headers: { Authorization: 'Bearer secret-token' },
        timeoutMs: 10_000,
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe('connected');
      expect(res.error).toBeUndefined();
      expect(res.serverInfo).toEqual({ name: 'probe-test-mcp', version: '9.9.9' });
      expect(Array.isArray(res.tools)).toBe(true);
      expect(res.tools?.map(t => t.name)).toEqual(['echo', 'get_time']);
      expect(res.tools).toEqual([
        { name: 'echo', desc: 'Echo back the input', enabled: true },
        { name: 'get_time', desc: 'Current server time', enabled: true },
      ]);
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await srv.close();
    }
  });

  test('success over legacy SSE transport', async () => {
    const srv = await startSseServer();
    try {
      const res = await probeConnector({
        url: srv.url,
        transport: 'sse',
        headers: { Authorization: 'Bearer secret-token' },
        timeoutMs: 10_000,
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe('connected');
      expect(res.serverInfo).toEqual({ name: 'probe-test-mcp-sse', version: '9.9.9' });
      expect(res.tools?.map(t => t.name)).toEqual(['echo', 'get_time']);
      expect(res.tools?.every(t => t.enabled)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  test('401 (http) -> failed / unauthorized', async () => {
    const srv = await startStatusServer(401);
    try {
      const res = await probeConnector({ url: srv.url, transport: 'http', headers: {}, timeoutMs: 5_000 });
      expect(res).toEqual({ ok: false, status: 'failed', error: 'unauthorized', latencyMs: expect.any(Number) });
    } finally {
      await srv.close();
    }
  });

  test('403 (http) -> failed / unauthorized', async () => {
    const srv = await startStatusServer(403);
    try {
      const res = await probeConnector({ url: srv.url, transport: 'http', headers: {}, timeoutMs: 5_000 });
      expect(res.ok).toBe(false);
      expect(res.status).toBe('failed');
      expect(res.error).toBe('unauthorized');
    } finally {
      await srv.close();
    }
  });

  test('401 (sse) -> failed / unauthorized', async () => {
    const srv = await startStatusServer(401);
    try {
      const res = await probeConnector({ url: srv.url, transport: 'sse', headers: {}, timeoutMs: 5_000 });
      expect(res.ok).toBe(false);
      expect(res.status).toBe('failed');
      expect(res.error).toBe('unauthorized');
    } finally {
      await srv.close();
    }
  });

  test('unreachable URL -> failed / connect-error', async () => {
    const url = await deadUrl();
    const res = await probeConnector({ url, transport: 'http', headers: {}, timeoutMs: 5_000 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toBe('connect-error');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('malformed URL -> failed / bad_url without any network attempt', async () => {
    const res = await probeConnector({ url: 'not a url', transport: 'http', headers: {}, timeoutMs: 5_000 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toBe('bad_url');

    const res2 = await probeConnector({ url: 'ftp://example.com/mcp', transport: 'http', headers: {}, timeoutMs: 5_000 });
    expect(res2.error).toBe('bad_url');
  });

  test('hung server -> failed / connect-error at the deadline', async () => {
    // Accepts the connection but never sends a response.
    const http = createServer(() => undefined);
    const port = await listen(http);
    try {
      const started = Date.now();
      const res = await probeConnector({
        url: `http://127.0.0.1:${port}/mcp`,
        transport: 'http',
        headers: {},
        timeoutMs: 400,
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe('failed');
      expect(res.error).toBe('connect-error');
      // Aborted at ~400ms, not left hanging.
      expect(res.latencyMs).toBeLessThan(1_500);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });
});
