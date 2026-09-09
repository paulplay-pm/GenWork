import { afterEach, describe, expect, test, vi } from 'vitest';

import { LibraryChangeReason } from '../../../shared/library/constants';
import { LibraryRefreshCoordinator } from './libraryRefreshCoordinator';

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('LibraryRefreshCoordinator', () => {
  test('coalesces an event storm into one quiet-window refresh', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => { batches.push(batch.itemIds); },
    });
    coordinator.setActive(true);

    for (let index = 0; index < 100; index += 1) {
      coordinator.enqueue({
        reason: LibraryChangeReason.Recorded,
        itemIds: [`item-${index}`],
      });
    }
    await vi.advanceTimersByTimeAsync(299);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(100);
  });

  test('flushes at the maximum wait while events continue arriving', async () => {
    vi.useFakeTimers();
    const batches: number[] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => { batches.push(batch.eventCount); },
    });
    coordinator.setActive(true);

    coordinator.enqueue({ reason: LibraryChangeReason.FileChanged, itemIds: ['first'] });
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(250);
      if (index < 3) {
        coordinator.enqueue({
          reason: LibraryChangeReason.FileChanged,
          itemIds: [`next-${index}`],
        });
      }
    }

    expect(batches).toEqual([4]);
  });

  test('allows only one in-flight refresh and one aggregated trailing refresh', async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>(resolve => { resolveFirst = resolve; });
    const batches: string[][] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => {
        batches.push(batch.itemIds);
        if (batches.length === 1) await first;
      },
    });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['first'] });
    await vi.advanceTimersByTimeAsync(300);

    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['second'] });
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['third'] });
    await vi.advanceTimersByTimeAsync(300);
    expect(batches).toEqual([['first']]);

    resolveFirst?.();
    await flushPromises();
    expect(batches).toEqual([['first'], ['second', 'third']]);
  });

  test('keeps a hidden page dirty and flushes once when it becomes active', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => { batches.push(batch.itemIds); },
    });
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['hidden'] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(batches).toEqual([]);

    coordinator.setActive(true);
    await flushPromises();
    expect(batches).toEqual([['hidden']]);
  });

  test('marks repair and legacy ID-less changes for authoritative refresh', async () => {
    vi.useFakeTimers();
    const authoritative: boolean[] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => { authoritative.push(batch.requiresAuthoritativeRefresh); },
    });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Repair, itemIds: ['known'] });
    coordinator.enqueue({ reason: LibraryChangeReason.SessionDeleted });
    await vi.advanceTimersByTimeAsync(300);

    expect(authoritative).toEqual([true]);
  });

  test('flushes an explicit refresh immediately without waiting for the quiet window', async () => {
    vi.useFakeTimers();
    const batches: string[][] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => { batches.push(batch.itemIds); },
    });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Repair, itemIds: ['manual'] });

    coordinator.flushNow();
    await flushPromises();

    expect(batches).toEqual([['manual']]);
  });

  test('cancels scheduled work after disposal', async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const coordinator = new LibraryRefreshCoordinator({ onFlush });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['disposed'] });

    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onFlush).not.toHaveBeenCalled();
  });

  test('drops trailing work when an in-flight refresh settles after disposal', async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>(resolve => { resolveFirst = resolve; });
    const batches: string[][] = [];
    const coordinator = new LibraryRefreshCoordinator({
      onFlush: async batch => {
        batches.push(batch.itemIds);
        await first;
      },
    });
    coordinator.setActive(true);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['first'] });
    await vi.advanceTimersByTimeAsync(300);
    coordinator.enqueue({ reason: LibraryChangeReason.Recorded, itemIds: ['trailing'] });

    coordinator.dispose();
    resolveFirst?.();
    await flushPromises();

    expect(batches).toEqual([['first']]);
  });
});
