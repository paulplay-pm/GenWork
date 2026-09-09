// Thin client for the dsh web host's unary RPC API (POST /api/<method> with
// the client-request envelope), plus the delegated code-task loop used by the
// dsh_code_task MCP tool: create session -> select model -> prompt -> poll for
// turn completion -> extract the final assistant text. Loopback only, no auth
// (the dsh web server has none); the engine manager owns the base URL. No
// Electron imports so the whole flow is exercised by scripts/e2e-dsh-*.

export class DshRpcError extends Error {
  readonly method: string;
  readonly code: string | null;

  constructor(method: string, message: string, code: string | null) {
    super(`${method}: ${message}`);
    this.method = method;
    this.code = code;
  }
}

let rpcCounter = 0;

export async function dshRpcCall<T = unknown>(baseUrl: string, method: string, payload: unknown = {}): Promise<T> {
  rpcCounter += 1;
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `genwork-${Date.now()}-${rpcCounter}`, method, payload }),
  });
  if (!response.ok) {
    throw new DshRpcError(method, `HTTP ${response.status}`, null);
  }
  const envelope = (await response.json()) as {
    result?: { ok?: boolean; value?: T; error?: { code?: string; message?: string } };
  };
  if (!envelope.result || envelope.result.ok !== true) {
    const error = envelope.result?.error;
    throw new DshRpcError(method, error?.message ?? 'rejected', error?.code ?? null);
  }
  return envelope.result.value as T;
}

interface SessionListValue {
  items: Array<{ sessionId: string; running: boolean }>;
}

interface SessionHistoryValue {
  events: Array<{ event: Record<string, unknown> }>;
}

// The session log is typed upstream; here we only need "did a turn end" and
// "what text did the assistant produce", extracted defensively so payload
// shape drift degrades to a weaker answer instead of a crash.
function eventType(event: Record<string, unknown>): string {
  return typeof event.type === 'string' ? event.type : '';
}

export function extractTextBlocks(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextBlocks(item, depth + 1));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      return [record.text];
    }
    const nested: string[] = [];
    // Session events wrap their payload under `data` (e.g. assistant/message
    // is { type, seq, data: { message: { content: [...] } } }).
    for (const key of ['data', 'message', 'content', 'blocks', 'parts']) {
      if (key in record) nested.push(...extractTextBlocks(record[key], depth + 1));
    }
    return nested;
  }
  return [];
}

function countTurnEnds(events: Array<{ event: Record<string, unknown> }>): number {
  return events.filter((entry) => eventType(entry.event) === 'turn/end').length;
}

function lastAssistantText(events: Array<{ event: Record<string, unknown> }>): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const { event } = events[index];
    if (eventType(event) === 'assistant/message') {
      const text = extractTextBlocks(event).join('\n').trim();
      if (text) return text;
    }
  }
  return '';
}

export interface DshCodeTaskOptions {
  baseUrl: string;
  prompt: string;
  cwd: string;
  model?: { provider: string; model: string };
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface DshCodeTaskResult {
  sessionId: string;
  finalText: string;
  timedOut: boolean;
  turnEnds: number;
}

export async function runDshCodeTask(options: DshCodeTaskOptions): Promise<DshCodeTaskResult> {
  const { baseUrl, prompt, cwd, model, timeoutMs = 10 * 60_000, pollIntervalMs = 1_000 } = options;

  const created = await dshRpcCall<{ sessionId: string }>(baseUrl, 'session.create', { cwd });
  const sessionId = created.sessionId;
  if (model) {
    await dshRpcCall(baseUrl, 'session.selectModel', { sessionId, provider: model.provider, model: model.model });
  }

  const baselineTurnEnds = countTurnEnds(await fetchHistory(baseUrl, sessionId));
  await dshRpcCall(baseUrl, 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
  });

  const deadline = Date.now() + timeoutMs;
  let sawRunning = false;
  for (;;) {
    if (Date.now() > deadline) {
      try {
        await dshRpcCall(baseUrl, 'session.cancel', { sessionId });
      } catch {
        // Best effort; the turn may have ended between the check and cancel.
      }
      const events = await fetchHistory(baseUrl, sessionId);
      return { sessionId, finalText: lastAssistantText(events), timedOut: true, turnEnds: countTurnEnds(events) };
    }
    await delay(pollIntervalMs);

    const events = await fetchHistory(baseUrl, sessionId);
    const turnEnds = countTurnEnds(events);
    if (turnEnds > baselineTurnEnds) {
      // The turn our prompt opened has closed; the agent may immediately open
      // another for queued work, but a delegated task sends exactly one prompt.
      const running = await isSessionRunning(baseUrl, sessionId);
      if (!running) {
        return { sessionId, finalText: lastAssistantText(events), timedOut: false, turnEnds };
      }
    }
    if (!sawRunning) {
      sawRunning = await isSessionRunning(baseUrl, sessionId);
    }
  }
}

async function fetchHistory(baseUrl: string, sessionId: string): Promise<Array<{ event: Record<string, unknown> }>> {
  const value = await dshRpcCall<SessionHistoryValue>(baseUrl, 'session.history', { sessionId, maxMessages: 200 });
  return Array.isArray(value.events) ? value.events : [];
}

async function isSessionRunning(baseUrl: string, sessionId: string): Promise<boolean> {
  const value = await dshRpcCall<SessionListValue>(baseUrl, 'session.list', {});
  const entry = (value.items ?? []).find((item) => item.sessionId === sessionId);
  return entry?.running === true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
