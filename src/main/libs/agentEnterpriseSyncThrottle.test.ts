import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { agentEnterpriseSyncThrottle } from './agentEnterpriseSyncThrottle';

beforeEach(() => { agentEnterpriseSyncThrottle._reset(); });
afterEach(() => { agentEnterpriseSyncThrottle._reset(); });

describe('agentEnterpriseSyncThrottle', () => {
  test('returns cached result within 3s window', async () => {
    const fn = vi.fn().mockResolvedValue({ report: { upserted: 1, removed: 0, skipped: 0 } });
    const r1 = await agentEnterpriseSyncThrottle.throttledSync('acctA', fn);
    const r2 = await agentEnterpriseSyncThrottle.throttledSync('acctA', fn);
    expect(r1.cached).toBe(false);
    expect(r2.cached).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('per-account isolation', async () => {
    const fn = vi.fn().mockResolvedValue({ report: { upserted: 1, removed: 0, skipped: 0 } });
    await agentEnterpriseSyncThrottle.throttledSync('acctA', fn);
    await agentEnterpriseSyncThrottle.throttledSync('acctB', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('3s+1ms → cache miss', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue({ report: { upserted: 1, removed: 0, skipped: 0 } });
    await agentEnterpriseSyncThrottle.throttledSync('acctA', fn);
    vi.advanceTimersByTime(3001);
    await agentEnterpriseSyncThrottle_throughRealTimer('acctA', fn);
    vi.useRealTimers();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('concurrent invocations for the same account coalesce into one in-flight call', async () => {
    let resolveFn!: (value: unknown) => void;
    const fn = vi.fn(() => new Promise((resolve) => { resolveFn = resolve; }));
    const first = agentEnterpriseSyncThrottle.throttledSync('acctA', fn);
    const second = agentEnterpriseSyncThrottle.throttledSync('acctA', fn);
    // fn is invoked synchronously on the first call; the second call finds the
    // in-flight entry and coalesces into it.
    expect(fn).toHaveBeenCalledTimes(1);
    resolveFn({ ok: true });
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual(r2);
    expect(r1.result).toEqual({ ok: true });
    expect(r1.cached).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// helper used by the third test above — flushes the throttledSync microtask queue.
async function agentEnterpriseSyncThrottle_throughRealTimer(key: string, fn: () => Promise<unknown>) {
  return agentEnterpriseSyncThrottle.throttledSync(key, fn);
}
