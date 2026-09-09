import '../helpers/setupEnv';
import { describe, expect, test } from 'vitest';
import { idempotency } from '../../src/proxy/idempotency';

describe('proxy/idempotency', () => {
  test('首次 seen=true；第二次同 key seen=true（已记）', () => {
    idempotency.clear();
    expect(idempotency.seen('k1')).toBe(false);
    idempotency.record('k1', 200);
    expect(idempotency.seen('k1')).toBe(true);
  });

  test('record 后 lookup 返回 result_code', () => {
    idempotency.clear();
    idempotency.record('k2', 429);
    expect(idempotency.lookup('k2')).toBe(429);
  });
});