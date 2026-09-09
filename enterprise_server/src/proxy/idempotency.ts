const TTL_MS = 24 * 60 * 60 * 1000;
const map = new Map<string, { resultCode: number; ts: number }>();

export const idempotency = {
  seen(key: string): boolean {
    const e = map.get(key);
    if (!e) return false;
    if (Date.now() - e.ts > TTL_MS) {
      map.delete(key);
      return false;
    }
    return true;
  },
  record(key: string, resultCode: number): void {
    map.set(key, { resultCode, ts: Date.now() });
  },
  lookup(key: string): number | undefined {
    const e = map.get(key);
    return e?.resultCode;
  },
  clear(): void {
    map.clear();
  },
};