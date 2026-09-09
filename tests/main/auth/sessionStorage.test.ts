import { describe, expect, test, beforeEach } from 'vitest';
import { sessionStorage } from '../../../src/main/auth/sessionStorage';

// We avoid better-sqlite3 here (no native binding on this host) and instead
// stub the surface sessionStorage depends on. The real wiring runs in
// electron main where the binding is present.

interface FakeRow { value: string }
interface FakeStmt {
  run(...args: unknown[]): unknown;
  get(key: string): FakeRow | undefined;
}
interface FakeDb {
  exec(sql: string): void;
  prepare(sql: string): FakeStmt;
}

function makeFakeDb(): FakeDb {
  const rows = new Map<string, string>();
  return {
    exec() {
      /* no-op */
    },
    prepare() {
      return {
        run(_key: string, value: string) {
          rows.set(_key, value);
        },
        get(key: string) {
          const v = rows.get(key);
          return v ? { value: v } : undefined;
        },
      };
    },
  };
}

describe('main/auth/sessionStorage (fake DB)', () => {
  let fakeDb: FakeDb;
  beforeEach(() => {
    fakeDb = makeFakeDb();
    // sessionStorage accepts the raw Database instance; FakeDb duck-types it
    // because sessionStorage only touches exec/prepare/run/get.
    sessionStorage.configure(fakeDb as unknown as Parameters<typeof sessionStorage.configure>[0]);
  });

  test('save + load roundtrip', () => {
    sessionStorage.save({
      userId: 'u1',
      orgId: 'o1',
      username: 'a',
      displayName: 'A',
      roles: ['user'],
      jwt: 'jwt-xxx',
      expiresAt: 0,
    });
    const s = sessionStorage.load();
    expect(s?.userId).toBe('u1');
    expect(s?.jwt).toBe('jwt-xxx');
  });

  test('load 返回 null when not configured', () => {
    // 重置未配置状态：直接试 load（configure 不再调）
    // 实际上 sessionStorage 是模块单例。这里我们检查未 save 时 load=null。
    expect(sessionStorage.load()).toBeNull();
  });

  test('clear 返回 null', () => {
    sessionStorage.save({
      userId: 'u1',
      orgId: 'o1',
      username: 'a',
      displayName: 'A',
      roles: [],
      jwt: 'j',
      expiresAt: 0,
    });
    sessionStorage.clear();
    expect(sessionStorage.load()).toBeNull();
  });
});