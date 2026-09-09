export type TokenProvider = () => string | null;
export type RefreshFn = () => Promise<void>;

/** Thrown when the server rejects a call. `body` carries the parsed JSON
 * error envelope (or null if the server returned a non-JSON response or no
 * body). `status` is the HTTP status code. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: { error?: string; detail?: string; [k: string]: unknown } | null;
  constructor(status: number, body: ApiError['body']) {
    super(`http ${status}${body?.error ? ` ${body.error}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

interface ApiClient {
  baseUrl(): string;
  setBaseUrl(url: string): void;
  setTokenProvider(fn: TokenProvider): void;
  setRefresh(fn: RefreshFn | null): void;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = void>(path: string): Promise<T>;
  getRaw(path: string): Promise<string>;
  postRaw<T = unknown>(path: string, body: BodyInit, headers?: Record<string, string>): Promise<T>;
}

let baseUrl = '';
let tokenProvider: TokenProvider = () => null;
let refresh: RefreshFn = async () => {};

/** Auth endpoints must NEVER trigger the refresh-on-401 flow. If we did,
 * `POST /auth/login` returning 401 (invalid creds) would call
 * `POST /auth/refresh`, which would itself return 401 (no token yet) and
 * recursively re-trigger `/auth/login` style refresh attempts — an infinite
 * 401 storm that wedges the SPA with the submit button stuck at `[disabled]`
 * and the user seeing no error feedback at all. */
function shouldSkipRefresh(path: string): boolean {
  return path === '/auth/login' || path === '/auth/refresh';
}

function buildHeaders(init?: HeadersInit): Headers {
  const h = new Headers(init);
  const tok = tokenProvider();
  if (tok) h.set('authorization', `Bearer ${tok}`);
  h.set('content-type', 'application/json');
  return h;
}

async function readErrorBody(res: Response): Promise<ApiError['body']> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as ApiError['body'];
  } catch {
    return null;
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  retried = false
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: buildHeaders(),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, init);
  } catch (e) {
    throw new ApiError(0, { error: 'network', detail: (e as Error).message });
  }
  if (res.status === 401 && !retried && !shouldSkipRefresh(path)) {
    try {
      await refresh();
    } catch {
      // Refresh itself 401s: surface the ORIGINAL 401 from the first request
      // so the caller can show "session expired" or similar — not the
      // refresh's downstream error.
      throw new ApiError(401, await readErrorBody(res));
    }
    return call<T>(method, path, body, true);
  }
  if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
  const text = await res.text();
  return (text ? JSON.parse(text) : (undefined as T)) as T;
}

export const apiClient: ApiClient = {
  baseUrl: () => baseUrl,
  setBaseUrl: (url) => {
    baseUrl = url.replace(/\/$/, '');
  },
  setTokenProvider: (fn) => {
    tokenProvider = fn;
  },
  setRefresh: (fn) => {
    refresh = fn ?? (async () => {});
  },
  get: <T>(p: string) => call<T>('GET', p),
  post: <T>(p: string, body?: unknown) => call<T>('POST', p, body),
  patch: <T>(p: string, body?: unknown) => call<T>('PATCH', p, body),
  put: <T>(p: string, body?: unknown) => call<T>('PUT', p, body),
  delete: <T = void>(p: string) => call<T>('DELETE', p),
  async getRaw(path: string): Promise<string> {
    const res = await fetch(`${baseUrl}${path}`, { headers: buildHeaders() });
    if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
    return res.text();
  },
  async postRaw<T>(path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<T> {
    const h = buildHeaders(headers);
    // content-type is set by the caller (e.g. application/zip) — do not force JSON.
    h.set('content-type', headers['content-type'] ?? 'application/octet-stream');
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: h, body });
    } catch (e) {
      throw new ApiError(0, { error: 'network', detail: (e as Error).message });
    }
    if (!res.ok) throw new ApiError(res.status, await readErrorBody(res));
    const text = await res.text();
    return (text ? JSON.parse(text) : (undefined as T)) as T;
  },
};