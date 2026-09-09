import {
  LibraryChangeReason,
  LibrarySharedStatusFilter,
  type LibrarySharedStatusFilter as LibrarySharedStatusFilterValue,
} from '../../../shared/library/constants';
import type {
  LibraryChangedPayload,
  LibraryCloudListData,
  LibraryItem,
  LibraryLocalListData,
  LibrarySharedStatusCounts,
  SharedFileItem,
} from '../../../shared/library/types';

const isSameLibraryItem = (
  left: Pick<LibraryItem, 'itemId' | 'itemKind'>,
  right: Pick<LibraryItem, 'itemId' | 'itemKind'>,
): boolean => left.itemId === right.itemId && left.itemKind === right.itemKind;

export const shouldReloadLibraryAfterChange = (
  payload: LibraryChangedPayload,
): boolean => payload.reason !== LibraryChangeReason.Favorite;

export const applyLibraryFavoriteState = <T extends LibraryItem>(
  items: T[],
  target: T,
  favorite: boolean,
  favoritesOnly: boolean,
): T[] => items.flatMap(item => {
  if (!isSameLibraryItem(item, target)) return [item];
  if (favoritesOnly && !favorite) return [];
  return [{ ...item, isFavorite: favorite } as T];
});

export const restoreLibraryFavoriteState = <T extends LibraryItem>(
  items: T[],
  target: T,
): T[] => {
  let found = false;
  const restored = items.map(item => {
    if (!isSameLibraryItem(item, target)) return item;
    found = true;
    return { ...item, isFavorite: target.isFavorite } as T;
  });
  return found ? restored : [...restored, target];
};

type CloudStatusCountData = Pick<LibraryCloudListData, 'counts'> & {
  sharedStatusCounts?: Partial<LibrarySharedStatusCounts>;
};

export const getLibrarySharedStatusCount = (
  data: CloudStatusCountData,
  status: LibrarySharedStatusFilterValue,
): number | undefined => {
  const count = data.sharedStatusCounts?.[status];
  if (typeof count === 'number' && Number.isFinite(count)) return count;

  // Older main-process builds do not return status facets. Keep the page
  // usable during renderer HMR and only show the source total we can trust.
  return status === LibrarySharedStatusFilter.All
    && Number.isFinite(data.counts.sharedFile)
    ? data.counts.sharedFile
    : undefined;
};

export const matchesLibrarySharedStatus = (
  item: Pick<SharedFileItem, 'status'>,
  status: LibrarySharedStatusFilterValue,
): boolean => (
  status === LibrarySharedStatusFilter.All || item.status === status
);

export const hideLibraryLocalItems = (
  data: LibraryLocalListData,
): LibraryLocalListData => ({
  list: [],
  hasMore: false,
  counts: data.counts,
});

export const sanitizeLibraryLocalListData = (
  data: LibraryLocalListData,
): { data: LibraryLocalListData; ignoredCount: number } => {
  const list = data.list.filter(item => (
    Boolean(item.latestSession) && item.relatedSessionCount > 0
  ));
  return {
    data: list.length === data.list.length ? data : { ...data, list },
    ignoredCount: data.list.length - list.length,
  };
};

export const hideLibraryCloudItems = (
  data: LibraryCloudListData,
): LibraryCloudListData => ({
  list: [],
  hasMore: false,
  counts: data.counts,
  sharedStatusCounts: data.sharedStatusCounts,
  ...(data.serverNow === undefined ? {} : { serverNow: data.serverNow }),
});
