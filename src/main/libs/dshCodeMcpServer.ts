// In-process HTTP MCP server exposing `dsh_code_task`: the main agent
// (OpenClaw) delegates a coding task, the handler drives the running dsh web
// host's session RPC and returns the final assistant answer. Registered into
// OpenClaw config as a built-in URL server (same pattern as computer-use, but
// hosted in this process — the handler needs the engine manager directly).
// Stateless streamable-http: each POST gets a fresh Server + transport pair.
// Dependencies are injected so the module stays Electron-free and E2E-testable.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';

import { runDshCodeTask } from './dshSessionClient';

export const DSH_CODE_TOOL_NAME = 'dsh_code_task';
export const DSH_CODE_MCP_SERVER_NAME = 'dsh-code';
const DEFAULT_TASK_TIMEOUT_S = 600;
const MAX_TASK_TIMEOUT_S = 1_800;

export interface DshCodeMcpDeps {
  // Starts the dsh engine when needed and resolves its loopback web URL.
  ensureEngineReady: () => Promise<string>;
  // Working directory when the caller does not pass one (session cwd).
  getDefaultCwd: () => string;
  // Optional model pin for delegated sessions; null lets dsh's default apply.
  getDefaultModel?: () => { provider: string; model: string } | null;
  // Called once every delegated task settles (success, timeout, or failure),
  // after the active-task count has been decremented. Used to run a deferred
  // engine re-spawn that was held off while a task was in flight.
  onTaskSettled?: () => void;
}

const TOOL_DEFINITION = {
  name: DSH_CODE_TOOL_NAME,
  description:
    'Delegate a self-contained coding task (write/fix/refactor/explain code, run builds or tests) to the ' +
    'DeepSeek Harness coding agent. It runs its own agent loop with shell and file tools inside the given ' +
    'working directory and returns a summary when done. Prefer it for multi-step programming work. ' +
    'Provide complete context in the prompt; the delegate cannot ask follow-up questions.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: {
        type: 'string',
        description: 'Complete task description, including relevant paths and acceptance criteria.',
      },
      cwd: {
        type: 'string',
        description: 'Absolute working directory for the task. Defaults to the current session working directory.',
      },
      timeout_s: {
        type: 'number',
        description: `Max seconds to wait (default ${DEFAULT_TASK_TIMEOUT_S}, max ${MAX_TASK_TIMEOUT_S}).`,
      },
    },
    required: ['prompt'],
  },
};

export class DshCodeMcpServer {
  private readonly deps: DshCodeMcpDeps;
  private httpServer: http.Server | null = null;
  private url: string | null = null;
  // How many `dsh_code_task` runs are executing right now. The dsh engine bakes
  // its plan credential at spawn, so it can only be re-spawned to pick up a
  // refreshed JWT while no task is in flight; this counter is the gate.
  private activeTasks = 0;

  constructor(deps: DshCodeMcpDeps) {
    this.deps = deps;
  }

  getUrl(): string | null {
    return this.url;
  }

  // True only when the server is running and no delegated task is executing.
  // Used by the engine manager to decide whether a deferred re-spawn is safe.
  isDshIdle(): boolean {
    return this.activeTasks === 0;
  }

  async start(): Promise<string> {
    if (this.url) return this.url;
    const httpServer = http.createServer((request, response) => {
      if (!request.url || !request.url.startsWith('/mcp')) {
        response.writeHead(404).end();
        return;
      }
      void this.handleMcpRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = httpServer.address();
    if (!address || typeof address !== 'object') {
      httpServer.close();
      throw new Error('dsh-code MCP server failed to bind a loopback port');
    }
    this.httpServer = httpServer;
    this.url = `http://127.0.0.1:${address.port}/mcp`;
    console.log(`[DSH] Code MCP server listening at ${this.url}`);
    return this.url;
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    this.url = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async handleMcpRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const mcpServer = this.buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error('[DSH] Code MCP request failed', error);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'internal error' }));
      }
    }
  }

  private buildMcpServer(): Server {
    const server = new Server(
      { name: DSH_CODE_MCP_SERVER_NAME, version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL_DEFINITION] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== DSH_CODE_TOOL_NAME) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
          isError: true,
        };
      }
      return this.runCodeTask(request.params.arguments ?? {});
    });
    return server;
  }

  private async runCodeTask(args: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) {
      return { content: [{ type: 'text', text: 'dsh_code_task requires a non-empty `prompt`.' }], isError: true };
    }
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd : this.deps.getDefaultCwd();
    const timeoutS = Math.min(
      Math.max(typeof args.timeout_s === 'number' && args.timeout_s > 0 ? args.timeout_s : DEFAULT_TASK_TIMEOUT_S, 30),
      MAX_TASK_TIMEOUT_S
    );

    let baseUrl: string;
    try {
      baseUrl = await this.deps.ensureEngineReady();
    } catch (error) {
      return {
        content: [{ type: 'text', text: `DeepSeek Harness engine is unavailable: ${(error as Error).message}` }],
        isError: true,
      };
    }

    this.activeTasks += 1;
    try {
      const result = await runDshCodeTask({
        baseUrl,
        prompt,
        cwd,
        model: this.deps.getDefaultModel?.() ?? undefined,
        timeoutMs: timeoutS * 1_000,
      });
      const header = result.timedOut
        ? `[dsh_code_task timed out after ${timeoutS}s; the session was cancelled. Partial output below.]`
        : '';
      const body = result.finalText || '(the coding agent produced no final text)';
      const footer = `\n\n[dsh session: ${result.sessionId}; open the DeepSeek Harness workbench to inspect the full run]`;
      return {
        content: [{ type: 'text', text: [header, body].filter(Boolean).join('\n\n') + footer }],
        ...(result.timedOut ? { isError: true } : {}),
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `dsh_code_task failed: ${(error as Error).message}` }],
        isError: true,
      };
    } finally {
      this.activeTasks = Math.max(0, this.activeTasks - 1);
      // Run after the count has dropped so isDshIdle() reflects this task's end.
      void this.deps.onTaskSettled?.();
    }
  }
}
