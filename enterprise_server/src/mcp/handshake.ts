/**
 * MCP handshake for a connector's "Test Connection" action.
 *
 * Pure function: performs a genuine MCP `initialize` + `tools/list` round-trip
 * against the given URL using @modelcontextprotocol/sdk. It does NOT touch the
 * database, the vault, or the filesystem — the caller decrypts the stored
 * `authConfig` and builds the request headers (e.g. shared-key ->
 * `Authorization: Bearer <apiKey>`), then passes them in.
 *
 * Failure taxonomy (ProbeResult.error):
 *   - 'unauthorized'  : server answered 401/403
 *   - 'connect-error' : network/DNS failure or handshake timed out
 *   - 'bad_url'       : url is not a parseable http(s) URL
 *
 * Security: `headers` may carry a bearer token — they are NEVER logged.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { ToolEntry } from '../models/connectorView';

export type ProbeTransport = 'http' | 'sse';

export interface ProbeConnectorArgs {
  url: string;
  transport: ProbeTransport;
  /** Already-decrypted request headers (may include `Authorization`). */
  headers: Record<string, string>;
  /** Whole-handshake wall-clock budget in milliseconds. */
  timeoutMs: number;
}

export type ProbeError = 'unauthorized' | 'connect-error' | 'bad_url';

export interface ProbeResult {
  ok: boolean;
  status: 'connected' | 'failed';
  error?: ProbeError;
  serverInfo?: { name?: string; version?: string };
  tools?: ToolEntry[];
  latencyMs: number;
}

/**
 * Classify a handshake failure into the wire error code.
 *
 * 401/403 surface differently per transport and per where the status was seen
 * (no OAuth authProvider is ever configured here):
 *  - StreamableHTTP throws `StreamableHTTPError` for any non-OK response; it
 *    carries `.code` = the HTTP status.
 *  - SSE wraps the eventsource failure in `SseError`; `.code` = the HTTP
 *    status (the `eventsource` package sets code to the HTTP status on
 *    non-200 responses).
 *  - The SSE POST fallback path throws `Error('Error POSTing to endpoint
 *    (HTTP <status>): ...')` — match the status out of the message.
 *  - `UnauthorizedError` (only reachable with an authProvider) is matched by
 *    name.
 */
function classifyError(err: unknown): ProbeError {
  if (err instanceof Error) {
    if (err.name === 'UnauthorizedError') return 'unauthorized';
    if (/HTTP 40[13]\b/.test(err.message)) return 'unauthorized';
  }
  const e = err as { code?: unknown } | null;
  if (e !== null && e !== undefined && (e.code === 401 || e.code === 403)) return 'unauthorized';
  return 'connect-error';
}

/**
 * Await `promise` but reject as soon as `deadline` aborts. If the promise
 * settles first, its original value/error is what the caller sees. Keeps a
 * hung remote from stalling the probe beyond `timeoutMs` even for stalls
 * outside fetch (e.g. an RPC response that never completes).
 */
function raceDeadline<T>(promise: Promise<T>, deadline: AbortSignal, step: string): Promise<T> {
  if (deadline.aborted) return Promise.reject(new Error(`${step} timed out`));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`${step} timed out`));
    deadline.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        deadline.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        deadline.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Run a real MCP `initialize` + `tools/list` against `url`.
 *
 * Never throws — all outcomes are encoded in the returned ProbeResult.
 */
export async function probeConnector(args: ProbeConnectorArgs): Promise<ProbeResult> {
  const startedAt = Date.now();
  const fail = (error: ProbeError): ProbeResult => ({
    ok: false,
    status: 'failed',
    error,
    latencyMs: Date.now() - startedAt,
  });

  // Unparseable / non-http(s) URL -> bad_url, no network attempt.
  let endpoint: URL;
  try {
    endpoint = new URL(args.url);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    return fail('bad_url');
  }

  // One wall-clock deadline for the whole handshake, enforced two ways:
  //  1. every request goes through a fetch wrapper that also listens to the
  //     deadline, so even mid-stream hangs are aborted;
  //  2. each SDK call is raced against the deadline as well.
  const deadline = AbortSignal.timeout(args.timeoutMs);
  const fetchWithDeadline = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signals: AbortSignal[] = [deadline];
    if (init?.signal) signals.push(init.signal);
    return fetch(input, {
      ...init,
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    });
  };

  let client: Client | undefined;
  try {
    client = new Client({ name: 'genwork-connector-probe', version: '1.0.0' }, { capabilities: {} });
    // Both transports accept a custom `fetch` plus `requestInit.headers`, so
    // the caller's (possibly auth-bearing) headers are sent on every request.
    const transportOpts = { fetch: fetchWithDeadline, requestInit: { headers: args.headers } };
    const transport =
      args.transport === 'http'
        ? new StreamableHTTPClientTransport(endpoint, transportOpts)
        : new SSEClientTransport(endpoint, transportOpts);

    // NOTE (SDK 1.30.0): there is no public `client.initialize()` —
    // `client.connect()` itself performs the `initialize` JSON-RPC round-trip
    // (plus `notifications/initialized`), and the server identity is exposed
    // via `getServerVersion()`.
    await raceDeadline(client.connect(transport), deadline, 'connect');
    const version = client.getServerVersion();
    const toolsResult = await raceDeadline(client.listTools(), deadline, 'listTools');

    return {
      ok: true,
      status: 'connected',
      serverInfo: { name: version?.name, version: version?.version },
      tools: toolsResult.tools.map(t => ({ name: t.name, desc: t.description, enabled: true })),
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    return fail(classifyError(err));
  } finally {
    // Always close — success, failure, or timeout — so a hung remote cannot
    // leak the socket/session. The close is raced against the same deadline (and
    // its own rejection swallowed) so even a stalling close() cannot hold the
    // probe open past the budget or turn this finally into a throw.
    const close = client ? client.close().catch(() => undefined) : Promise.resolve();
    await raceDeadline(close, deadline, 'close').catch(() => undefined);
  }
}
