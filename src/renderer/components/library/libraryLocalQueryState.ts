import {
  LibraryCategory,
  LibraryLimits,
} from '../../../shared/library/constants';
import type {
  LibraryLocalListData,
  LocalArtifactItem,
} from '../../../shared/library/types';

export const LibraryLoadPhase = {
  Initial: 'initial',
  Settled: 'settled',
  Refreshing: 'refreshing',
  Appending: 'appending',
} as const;
export type LibraryLoadPhase = typeof LibraryLoadPhase[keyof typeof LibraryLoadPhase];

export const LibraryLoadIntent = {
  Initial: 'initial',
  Refresh: 'refresh',
  Append: 'append',
} as const;
export type LibraryLoadIntent = typeof LibraryLoadIntent[keyof typeof LibraryLoadIntent];

export interface LibraryLocalQuery {
  category: LibraryCategory;
  keyword: string;
  favoritesOnly: boolean;
}

export interface LibraryLocalItemChanges {
  items: LocalArtifactItem[];
  unavailableItemIds: string[];
}

export interface LibraryLocalItemChangeResult {
  data: LibraryLocalListData;
  requiresAuthoritativeRefresh: boolean;
}

export const compareLibraryLocalItems = (
  left: LocalArtifactItem,
  right: LocalArtifactItem,
): number => (
  right.sortTime - left.sortTime || right.itemId.localeCompare(left.itemId)
);

export const matchesLibraryLocalQuery = (
  item: LocalArtifactItem,
  query: LibraryLocalQuery,
): boolean => {
  if (query.category !== LibraryCategory.All && item.category !== query.category) return false;
  if (query.favoritesOnly && !item.isFavorite) return false;
  const keyword = query.keyword.trim().toLocaleLowerCase();
  if (!keyword) return true;
  return item.title.toLocaleLowerCase().includes(keyword)
    || item.extension.toLocaleLowerCase().includes(keyword);
};

export const applyLibraryLocalItemChanges = (
  current: LibraryLocalListData,
  changes: LibraryLocalItemChanges,
  query: LibraryLocalQuery,
): LibraryLocalItemChangeResult => {
  const unavailable = new Set(changes.unavailableItemIds);
  const nextById = new Map(
    current.list
      .filter(item => !unavailable.has(item.itemId))
      .map(item => [item.itemId, item]),
  );
  const currentItemIds = new Set(current.list.map(item => item.itemId));
  const currentTail = current.list[current.list.length - 1];

  for (const item of changes.items) {
    if (!matchesLibraryLocalQuery(item, query)) {
      nextById.delete(item.itemId);
      continue;
    }
    const isAlreadyLoaded = currentItemIds.has(item.itemId);
    const isInsideLoadedWindow = !current.hasMore
      || !currentTail
      || compareLibraryLocalItems(item, currentTail) <= 0;
    if (isAlreadyLoaded || isInsideLoadedWindow) nextById.set(item.itemId, item);
  }

  const list = [...nextById.values()].sort(compareLibraryLocalItems);
  return {
    data: { ...current, list },
    requiresAuthoritativeRefresh: list.length > LibraryLimits.MaxPageSize,
  };
};

export const shouldShowLibraryInitialSkeleton = (
  phase: LibraryLoadPhase,
  hasResolvedSnapshot: boolean,
): boolean => phase === LibraryLoadPhase.Initial && !hasResolvedSnapshot;
