import { describe, expect, test } from 'vitest';

import { HtmlShareStatus } from '../../../shared/htmlShare/constants';
import {
  LibraryChangeReason,
  LibraryItemKind,
  LibrarySharedStatusFilter,
} from '../../../shared/library/constants';
import type { LocalArtifactItem } from '../../../shared/library/types';
import {
  applyLibraryFavoriteState,
  getLibrarySharedStatusCount,
  hideLibraryCloudItems,
  hideLibraryLocalItems,
  matchesLibrarySharedStatus,
  restoreLibraryFavoriteState,
  sanitizeLibraryLocalListData,
  shouldReloadLibraryAfterChange,
} from './libraryListState';

const makeLocalItem = (itemId: string, isFavorite: boolean): LocalArtifactItem => ({
  itemKind: LibraryItemKind.LocalArtifact,
  itemId,
  title: `${itemId}.pdf`,
  category: 'document',
  sortTime: 1,
  createdAt: 1,
  isFavorite,
  latestSession: {
    sessionId: 'session-1',
    title: 'Task',
    agentId: 'main',
    lastRelatedAt: 1,
  },
  filePath: `/tmp/${itemId}.pdf`,
  artifactType: 'document',
  extension: '.pdf',
  availability: 'available',
  origin: 'conversation',
  relatedSessionCount: 1,
});

describe('library list state', () => {
  test('does not reload the list for an optimistically applied favorite event', () => {
    expect(shouldReloadLibraryAfterChange({
      reason: LibraryChangeReason.Favorite,
      itemIds: ['item-1'],
    })).toBe(false);
    expect(shouldReloadLibraryAfterChange({
      reason: LibraryChangeReason.FileChanged,
      itemIds: ['item-1'],
    })).toBe(true);
  });

  test('updates favorite state in place and removes an unfavorited filtered item', () => {
    const first = makeLocalItem('first', false);
    const second = makeLocalItem('second', true);

    expect(applyLibraryFavoriteState([first, second], first, true, false)).toEqual([
      { ...first, isFavorite: true },
      second,
    ]);
    expect(applyLibraryFavoriteState([first, second], second, false, true)).toEqual([first]);
  });

  test('restores a filtered item when persisting its favorite state fails', () => {
    const item = makeLocalItem('item-1', true);
    expect(restoreLibraryFavoriteState([], item)).toEqual([item]);
  });

  test('hides local items without clearing the source count', () => {
    expect(hideLibraryLocalItems({
      list: [],
      nextCursor: 'local-next',
      hasMore: true,
      counts: { total: 12, available: 10, missing: 2 },
    })).toEqual({
      list: [],
      hasMore: false,
      counts: { total: 12, available: 10, missing: 2 },
    });
  });

  test('defensively ignores malformed local items without a valid task relation', () => {
    const valid = makeLocalItem('valid', false);
    const missingTask = {
      ...makeLocalItem('missing-task', false),
      latestSession: undefined,
      relatedSessionCount: 0,
    } as unknown as LocalArtifactItem;
    const result = sanitizeLibraryLocalListData({
      list: [valid, missingTask],
      hasMore: false,
      counts: { total: 2, available: 2, missing: 0 },
    });

    expect(result.ignoredCount).toBe(1);
    expect(result.data.list).toEqual([valid]);
    expect(result.data.counts.total).toBe(2);
  });

  test('hides cloud items without clearing share and site counts', () => {
    expect(hideLibraryCloudItems({
      list: [],
      nextCursor: 'cloud-next',
      hasMore: true,
      counts: { sharedFile: 83, deployedSite: 14 },
      sharedStatusCounts: { all: 83, live: 70, disabled: 13 },
      serverNow: 1_000,
    })).toEqual({
      list: [],
      hasMore: false,
      counts: { sharedFile: 83, deployedSite: 14 },
      sharedStatusCounts: { all: 83, live: 70, disabled: 13 },
      serverNow: 1_000,
    });
  });

  test('reads exact shared status facets when provided', () => {
    const data = {
      counts: { sharedFile: 83, deployedSite: 14 },
      sharedStatusCounts: { all: 83, live: 70, disabled: 13 },
    };

    expect(getLibrarySharedStatusCount(data, LibrarySharedStatusFilter.All)).toBe(83);
    expect(getLibrarySharedStatusCount(data, LibrarySharedStatusFilter.Live)).toBe(70);
    expect(getLibrarySharedStatusCount(data, LibrarySharedStatusFilter.Disabled)).toBe(13);
  });

  test('keeps legacy cloud responses renderable without status facets', () => {
    const legacyData = {
      counts: { sharedFile: 83, deployedSite: 14 },
    };

    expect(getLibrarySharedStatusCount(legacyData, LibrarySharedStatusFilter.All)).toBe(83);
    expect(getLibrarySharedStatusCount(legacyData, LibrarySharedStatusFilter.Live)).toBeUndefined();
    expect(
      getLibrarySharedStatusCount(legacyData, LibrarySharedStatusFilter.Disabled),
    ).toBeUndefined();
  });

  test('filters mixed legacy results by the selected shared status', () => {
    const liveItem = { status: HtmlShareStatus.Live };
    const disabledItem = { status: HtmlShareStatus.Disabled };

    expect(matchesLibrarySharedStatus(liveItem, LibrarySharedStatusFilter.All)).toBe(true);
    expect(matchesLibrarySharedStatus(disabledItem, LibrarySharedStatusFilter.All)).toBe(true);
    expect(matchesLibrarySharedStatus(liveItem, LibrarySharedStatusFilter.Live)).toBe(true);
    expect(matchesLibrarySharedStatus(disabledItem, LibrarySharedStatusFilter.Live)).toBe(false);
    expect(matchesLibrarySharedStatus(liveItem, LibrarySharedStatusFilter.Disabled)).toBe(false);
    expect(matchesLibrarySharedStatus(disabledItem, LibrarySharedStatusFilter.Disabled)).toBe(true);
  });
});
