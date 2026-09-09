import { describe, expect, test } from 'vitest';

import { DefaultKeyfrom, type KeyfromAttribution, KeyfromStoreKey } from '../../shared/keyfrom';
import {
  initializeKeyfromAttribution,
  normalizeKeyfrom,
  readKeyfromAttribution,
} from './keyfromAttribution';

class MemoryStore {
  values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }
}

describe('keyfrom attribution', () => {
  test('normalizes valid keyfrom values', () => {
    expect(normalizeKeyfrom('bilibili')).toBe('bilibili');
    expect(normalizeKeyfrom(' Partner_A ')).toBe('partner_a');
    expect(normalizeKeyfrom('channel-01')).toBe('channel-01');
  });

  test('falls back to official for invalid values', () => {
    expect(normalizeKeyfrom('')).toBe(DefaultKeyfrom.Official);
    expect(normalizeKeyfrom('../../bad')).toBe(DefaultKeyfrom.Official);
    expect(normalizeKeyfrom('中文')).toBe(DefaultKeyfrom.Official);
    expect(normalizeKeyfrom(null)).toBe(DefaultKeyfrom.Official);
  });

  test('writes first and latest keyfrom on first initialization', () => {
    const store = new MemoryStore();
    const attribution = initializeKeyfromAttribution(store, {
      currentKeyfrom: 'bilibili',
      now: 1000,
    });

    expect(attribution).toEqual({
      firstKeyfrom: 'bilibili',
      latestKeyfrom: 'bilibili',
      updatedAt: 1000,
    });
    expect(store.get(KeyfromStoreKey.Attribution)).toEqual(attribution);
  });

  test('does not overwrite first keyfrom and updates latest keyfrom', () => {
    const store = new MemoryStore();
    store.set<KeyfromAttribution>(KeyfromStoreKey.Attribution, {
      firstKeyfrom: 'bilibili',
      latestKeyfrom: 'bilibili',
      updatedAt: 1000,
    });

    const attribution = initializeKeyfromAttribution(store, {
      currentKeyfrom: 'partner_a',
      now: 2000,
    });

    expect(attribution).toEqual({
      firstKeyfrom: 'bilibili',
      latestKeyfrom: 'partner_a',
      updatedAt: 2000,
    });
  });

  test('ignores invalid stored attribution', () => {
    const store = new MemoryStore();
    store.set(KeyfromStoreKey.Attribution, {
      firstKeyfrom: '../../bad',
      latestKeyfrom: 'bilibili',
      updatedAt: 1000,
    });

    expect(readKeyfromAttribution(store)).toBeNull();
  });
});
