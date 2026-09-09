import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { LibraryLimits } from '../../shared/library/constants';
import { normalizeLibraryTargetItemIds } from './libraryIpc';

describe('library IPC validation', () => {
  test('normalizes and deduplicates targeted item identifiers', () => {
    expect(normalizeLibraryTargetItemIds({
      itemIds: [' item-1 ', 'item-2', 'item-1'],
    })).toEqual(['item-1', 'item-2']);
  });

  test('rejects empty, oversized, and malformed targeted item batches', () => {
    expect(() => normalizeLibraryTargetItemIds({ itemIds: [] })).toThrow();
    expect(() => normalizeLibraryTargetItemIds({
      itemIds: Array.from(
        { length: LibraryLimits.MaxTargetItemIds + 1 },
        (_, index) => `item-${index}`,
      ),
    })).toThrow();
    expect(() => normalizeLibraryTargetItemIds({ itemIds: ['valid', 1] })).toThrow();
  });
});
