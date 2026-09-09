import {
  type LibraryCategory,
  type LibraryCloudAvailabilityFilter,
  type LibraryItemKind,
  type LibrarySourceFilter,
  type LibraryViewMode,
} from '@shared/library/constants';

export const LibraryAnalyticsEventVersion = 1;

export const LibraryAnalyticsSurface = {
  MyFiles: 'my_files',
} as const;

export const LibraryAnalyticsActionType = {
  PageExposure: 'page_exposure',
  ListResult: 'list_result',
  SourceChange: 'source_change',
  FilterChange: 'filter_change',
  SearchApplied: 'search_applied',
  SearchCleared: 'search_cleared',
  ViewModeChange: 'view_mode_change',
  ItemPreviewOpen: 'item_preview_open',
  FavoriteChange: 'favorite_change',
  Refresh: 'refresh',
} as const;

export type LibraryAnalyticsActionType =
  typeof LibraryAnalyticsActionType[keyof typeof LibraryAnalyticsActionType];

export const LibraryAnalyticsControl = {
  Source: 'source',
  Category: 'category',
  Availability: 'availability',
  Favorites: 'favorites',
  Search: 'search',
  ViewMode: 'view_mode',
} as const;

export type LibraryAnalyticsControl =
  typeof LibraryAnalyticsControl[keyof typeof LibraryAnalyticsControl];

export const LibraryAnalyticsResult = {
  Success: 'success',
  Failure: 'failure',
  AuthRequired: 'auth_required',
} as const;

export type LibraryAnalyticsResult =
  typeof LibraryAnalyticsResult[keyof typeof LibraryAnalyticsResult];

export interface LibraryAnalyticsContext {
  pageViewId: string;
  librarySource: LibrarySourceFilter;
  category: LibraryCategory;
  availability?: LibraryCloudAvailabilityFilter;
  favoritesOnly: boolean;
  keyword: string;
  viewMode: LibraryViewMode;
  isAuthenticated: boolean;
}

export interface ReportLibraryActionOptions {
  actionType: LibraryAnalyticsActionType;
  control?: LibraryAnalyticsControl;
  targetValue?: string | boolean;
  itemKind?: LibraryItemKind;
  itemCategory?: LibraryCategory;
  favorite?: boolean;
  result?: LibraryAnalyticsResult;
  loadedItemCount?: number;
  hasMore?: boolean;
}

const createId = (): string => (
  globalThis.crypto?.randomUUID?.()
  ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
);

export const createLibraryAnalyticsPageViewId = createId;

export const getLibrarySearchLengthBucket = (keyword: string): string => {
  const length = keyword.trim().length;
  if (length === 0) return '0';
  if (length <= 10) return '1_10';
  if (length <= 30) return '11_30';
  if (length <= 60) return '31_60';
  return '61_plus';
};

export const getLibraryLoadedItemCountBucket = (
  count: number | undefined,
): string | undefined => {
  if (count === undefined || !Number.isFinite(count)) return undefined;
  if (count <= 0) return '0';
  if (count <= 5) return '1_5';
  if (count <= 20) return '6_20';
  if (count <= 50) return '21_50';
  return '51_plus';
};

export const reportLibraryAction = (
  _context: LibraryAnalyticsContext,
  _options: ReportLibraryActionOptions,
): void => {
};
