import { spawn } from 'node:child_process';

import { McpAuthStatus } from '../../shared/mcp/constants';
import type { McpServerRecord } from './mcpStore';
import { McpStore } from './mcpStore';

export interface ProbeResult {
  ok: boolean;
  status: 'authorized' | 'unauthorized' | 'connect-error' | 'missing-credential';
  latencyMs: number;
  serverInfo?: { name: string; version?: string };
  /** User-safe message: never includes credential values. May mention header / env-key NAMES the user controls. */
  error?: string;
}

const HTTP_TIMEOUT_MS = 10_000;
const STDIO_TIMEOUT_MS = 8_000;

/** Generic client identity; MCP servers log this. */
const CLIENT_INFO = { name: 'genwork-auth-probe', version: '1.0.0' } as const;

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: CLIENT_INFO,
  },
});

/**
 * Single entry point. Walks the transport, sends initialize, classifies the outcome, writes back.
 *
 * @param record The MCP server record whose auth we want to verify.
 * @param store Optional McpStore for DB writeback. When omitted, the probe is purely transient
 *   and does not persist `last_probe_at` / `last_probe_status` / `auth_status`. Tests pass a
 *   `:memory:` store; production callers inject the singleton from `mcpRuntime.getStore()`.
 */
export async function probeAuthorization(
  record: McpServerRecord,
  store?: McpStore,
): Promise<ProbeResult> {
  const start = Date.now();
  let result: ProbeResult;

  try {
    if (record.authMethod !== 'none') {
      const missing = checkMissingCredential(record);
      if (missing) {
        result = { ok: false, status: 'missing-credential', latencyMs: Date.now() - start, error: missing };
      } else if (record.transportType === 'http' || record.transportType === 'sse') {
        result = await probeHttp(record, start);
      } else {
        result = await probeStdio(record, start);
      }
    } else {
      // authMethod === 'none' — still verify the URL/command actually answers initialize.
      if (record.transportType === 'stdio') {
        result = await probeStdio(record, start);
      } else {
        result = await probeHttp(record, start);
      }
    }
  } catch (err) {
    result = { ok: false, status: 'connect-error', latencyMs: Date.now() - start, error: errMsg(err) };
  }

  // Persist probe outcome — best-effort, never throws to caller.
  if (store) {
    try {
      const authStatus =
        result.status === 'authorized' ? McpAuthStatus.Authenticated :
        result.status === 'unauthorized' ? McpAuthStatus.AuthError :
        McpAuthStatus.NeedsAuth;
      store.updateAuthStatus(record.id, authStatus, result.status, Date.now());
    } catch (err) {
      console.warn('[mcpAuthProbe] failed to persist probe outcome', err);
    }
  }

  return result;
}

/** Returns a user-safe error string naming the missing field, or null. */
function checkMissingCredential(record: McpServerRecord): string | null {
  const method = record.authMethod;
  if (method === 'none') return null;
  if (method === 'oauth') {
    // The OAuth branch reads from config_json via the public shape — record.oauth
    // is not on the McpServerRecord type. We rely on the caller (Task 4) to ensure
    // a token is in config_json before calling. We do a quick header-presence check:
    // if oauth authMethod is set and Authorization is empty, mark missing.
    // (Task 4 will populate Authorization from the oauth token before calling.)
    if (!record.headers?.Authorization) return 'OAuth token missing — please re-authorize';
    return null;
  }
  if (method === 'bearer') {
    if (!record.headers?.Authorization) return 'Missing credential: Authorization header';
    return null;
  }
  // api-key: any non-Authorization header is acceptable.
  const hasKey = Object.entries(record.headers ?? {}).some(
    ([k, v]) => k !== 'Authorization' && typeof v === 'string' && v.length > 0,
  );
  return hasKey ? null : 'Missing credential: an api-key header (e.g. X-API-Key)';
}

async function probeHttp(record: McpServerRecord, start: number): Promise<ProbeResult> {
  const url = record.url;
  if (!url) {
    return { ok: false, status: 'missing-credential', latencyMs: Date.now() - start, error: 'Missing URL' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(record.headers ?? {}),
      },
      body: INITIALIZE_BODY,
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: 'unauthorized', latencyMs: Date.now() - start, error: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, status: 'connect-error', latencyMs: Date.now() - start, error: `HTTP ${res.status}` };
    }
    // Look for a JSON-RPC `result` with non-empty serverInfo or capabilities.
    const info = extractServerInfo(text);
    if (!info) {
      return { ok: false, status: 'connect-error', latencyMs: Date.now() - start, error: 'initialize returned no result' };
    }
    return { ok: true, status: 'authorized', latencyMs: Date.now() - start, serverInfo: info };
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      return { ok: false, status: 'connect-error', latencyMs: Date.now() - start, error: `timeout after ${HTTP_TIMEOUT_MS}ms` };
    }
    return { ok: false, status: 'connect-error', latencyMs: Date.now() - start, error: errMsg(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeStdio(record: McpServerRecord, start: number): Promise<ProbeResult> {
  const cmd = record.command;
  if (!cmd) {
    return { ok: false, status: 'missing-credential', latencyMs: Date.now() - start, error: 'Missing command' };
  }
  // The configured env may carry tokens (e.g. API_KEY=...). Merge process.env so the child can find PATH, etc.
  const env = { ...process.env, ...(record.env ?? {}) };

  return await new Promise<ProbeResult>((resolve) => {
    const child = spawn(cmd, record.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, status: 'connect-error', latencyMs: Date.now() - start, error: `timeout after ${STDIO_TIMEOUT_MS}ms` });
    }, STDIO_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      // MCP stdio uses newline-delimited JSON.
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length > 0) {
          const info = tryParseInitializeResult(line);
          if (info) {
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            resolve({ ok: true, status: 'authorized', latencyMs: Date.now() - start, serverInfo: info });
            return;
          }
        }
        nl = buf.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, status: 'connect-error', latencyMs: Date.now() - start, error: errMsg(err) });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      // If we got here without resolving, the child exited before answering.
      resolve({
        ok: false,
        status: 'connect-error',
        latencyMs: Date.now() - start,
        error: `stdio child exited (code=${code ?? 'null'}) before responding`,
      });
    });

    child.stdin.write(INITIALIZE_BODY + '\n');
  });
}

/** Tolerant extractor: parses either a JSON object or a `data: {…}` SSE line. */
function extractServerInfo(text: string): { name: string; version?: string } | null {
  // Try a direct JSON parse first.
  try {
    const obj = JSON.parse(text) as { result?: { serverInfo?: { name?: string; version?: string } } };
    if (obj?.result?.serverInfo?.name) return { name: obj.result.serverInfo.name, version: obj.result.serverInfo.version };
  } catch { /* fall through */ }
  // SSE: split into events on `\n\n`, then look for `data: ` lines within each event.
  for (const part of text.split('\n\n')) {
    for (const rawLine of part.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const obj = JSON.parse(payload) as { result?: { serverInfo?: { name?: string; version?: string } } };
        if (obj?.result?.serverInfo?.name) return { name: obj.result.serverInfo.name, version: obj.result.serverInfo.version };
      } catch { /* keep looking */ }
    }
  }
  return null;
}

function tryParseInitializeResult(line: string): { name: string; version?: string } | null {
  try {
    const obj = JSON.parse(line) as { result?: { serverInfo?: { name?: string; version?: string } } };
    if (obj?.result?.serverInfo?.name) return { name: obj.result.serverInfo.name, version: obj.result.serverInfo.version };
  } catch { /* not JSON */ }
  return null;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
