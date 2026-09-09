import { describe, expect, test } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryItemKind,
  LibraryOrigin,
} from '../../../shared/library/constants';
import type { LibraryLocalListData, LocalArtifactItem } from '../../../shared/library/types';
import {
  applyLibraryLocalItemChanges,
  LibraryLoadPhase,
  matchesLibraryLocalQuery,
  shouldShowLibraryInitialSkeleton,
} from './libraryLocalQueryState';

const makeItem = (
  itemId: string,
  sortTime: number,
  overrides: Partial<LocalArtifactItem> = {},
): LocalArtifactItem => ({
  itemKind: LibraryItemKind.LocalArtifact,
  itemId,
  title: `${itemId}.pdf`,
  category: LibraryCategory.Document,
  sortTime,
  createdAt: sortTime,
  isFavorite: false,
  latestSession: {
    sessionId: `session-${itemId}`,
    title: `Task ${itemId}`,
    agentId: 'main',
    lastRelatedAt: sortTime,
  },
  filePath: `/tmp/${itemId}.pdf`,
  artifactType: LibraryArtifactType.Document,
  extension: '.pdf',
  availability: LibraryAvailability.Available,
  origin: LibraryOrigin.Conversation,
  relatedSessionCount: 1,
  ...overrides,
});

const makeData = (list: LocalArtifactItem[], hasMore = false): LibraryLocalListData => ({
  list,
  hasMore,
  ...(hasMore ? { nextCursor: 'cursor' } : {}),
  counts: { total: list.length, available: list.length, missing: 0 },
});

const allQuery = {
  category: LibraryCategory.All,
  keyword: '',
  favoritesOnly: false,
};

describe('library local query state', () => {
  test('updates, inserts, removes, and sorts targeted items by stable item ID', () => {
    const first = makeItem('first', 100);
    const second = makeItem('second', 90);
    const updatedSecond = makeItem('second', 120, {
      latestSession: { ...second.latestSession, title: 'Updated task' },
    });
    const inserted = makeItem('inserted', 110);

    const result = applyLibraryLocalItemChanges(
      makeData([first, second]),
      { items: [updatedSecond, inserted], unavailableItemIds: ['first'] },
      allQuery,
    );

    expect(result.data.list.map(item => item.itemId)).toEqual(['second', 'inserted']);
    expect(result.data.list[0].latestSession.title).toBe('Updated task');
  });

  test('does not insert an unseen item beyond the loaded cursor boundary', () => {
    const current = makeData([makeItem('newest', 100), makeItem('tail', 50)], true);
    const result = applyLibraryLocalItemChanges(
      current,
      { items: [makeItem('older', 40)], unavailableItemIds: [] },
      allQuery,
    );

    expect(result.data.list.map(item => item.itemId)).toEqual(['newest', 'tail']);
    expect(result.data.nextCursor).toBe('cursor');
  });

  test('uses the same category, favorite, filename, and extension filters as the list', () => {
    const favoriteSheet = makeItem('budget', 1, {
      title: '年度预算.XLSX',
      category: LibraryCategory.Spreadsheet,
      extension: '.xlsx',
      isFavorite: true,
    });

    expect(matchesLibraryLocalQuery(favoriteSheet, {
      category: LibraryCategory.Spreadsheet,
      keyword: '预算',
      favoritesOnly: true,
    })).toBe(true);
    expect(matchesLibraryLocalQuery(favoriteSheet, {
      category: LibraryCategory.All,
      keyword: '.XLSX',
      favoritesOnly: false,
    })).toBe(true);
    expect(matchesLibraryLocalQuery(favoriteSheet, {
      category: LibraryCategory.Document,
      keyword: '',
      favoritesOnly: false,
    })).toBe(false);
  });

  test('never returns resolved content to the initial skeleton', () => {
    expect(shouldShowLibraryInitialSkeleton(LibraryLoadPhase.Initial, false)).toBe(true);
    expect(shouldShowLibraryInitialSkeleton(LibraryLoadPhase.Initial, true)).toBe(false);
    expect(shouldShowLibraryInitialSkeleton(LibraryLoadPhase.Refreshing, true)).toBe(false);
    expect(shouldShowLibraryInitialSkeleton(LibraryLoadPhase.Appending, true)).toBe(false);
  });
});
