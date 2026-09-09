const WINDOW_MS = 3000;

interface CacheEntry {
  result: unknown;
  ts: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<{ result: unknown; cached: boolean }>>();

export const agentEnterpriseSyncThrottle = {
  async throttledSync<T>(accountKey: string, fn: () => Promise<T>): Promise<{ result: T; cached: boolean }> {
    const now = Date.now();
    const hit = cache.get(accountKey);
    if (hit && now - hit.ts < WINDOW_MS) {
      return { result: hit.result as T, cached: true };
    }
    const existing = inFlight.get(accountKey);
    if (existing) return existing as Promise<{ result: T; cached: boolean }>;
    const pending = (async () => {
      const result = await fn();
      cache.set(accountKey, { result, ts: Date.now() });
      return { result, cached: false };
    })();
    inFlight.set(accountKey, pending as Promise<{ result: unknown; cached: boolean }>);
    try {
      return await pending;
    } finally {
      inFlight.delete(accountKey);
    }
  },
  _reset(): void { cache.clear(); inFlight.clear(); },
};
