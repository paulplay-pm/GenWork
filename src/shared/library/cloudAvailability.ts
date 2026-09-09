import { HtmlShareStatus } from '../htmlShare/constants';
import { SiteStatus } from '../site/constants';
import {
  LibraryCloudAvailabilityFilter,
  type LibraryCloudAvailabilityFilter as LibraryCloudAvailabilityFilterValue,
  LibraryCloudUnavailableReason,
  LibraryItemKind,
} from './constants';
import type { LibraryCloudItem } from './types';

export type LibraryCloudAvailability = Exclude<
  LibraryCloudAvailabilityFilterValue,
  typeof LibraryCloudAvailabilityFilter.All
>;

export const getLibraryCloudAvailability = (
  item: LibraryCloudItem,
  now = Date.now(),
): LibraryCloudAvailability => {
  if (
    (item.accessExpiresAt !== undefined && item.accessExpiresAt <= now)
    || (item.effectiveExpiresAt !== undefined && item.effectiveExpiresAt <= now)
  ) {
    return LibraryCloudAvailabilityFilter.Unavailable;
  }
  if (item.itemKind === LibraryItemKind.SharedFile) {
    return item.status === HtmlShareStatus.Live && item.effectiveAvailable !== false
      ? LibraryCloudAvailabilityFilter.Available
      : LibraryCloudAvailabilityFilter.Unavailable;
  }
  return item.siteStatus === SiteStatus.Online
    && item.shareStatus === HtmlShareStatus.Live
    && item.effectiveAvailable !== false
    ? LibraryCloudAvailabilityFilter.Available
    : LibraryCloudAvailabilityFilter.Unavailable;
};

export const isLibraryCloudAccessExpired = (
  item: LibraryCloudItem,
  now = Date.now(),
): boolean => (
  (item.accessExpiresAt !== undefined && item.accessExpiresAt <= now)
  || (item.effectiveExpiresAt !== undefined && item.effectiveExpiresAt <= now)
  || item.effectiveUnavailableReason === LibraryCloudUnavailableReason.FreeAccessExpired
  || item.effectiveUnavailableReason
    === LibraryCloudUnavailableReason.EntitlementGraceExpired
);

export const matchesLibraryCloudAvailability = (
  item: LibraryCloudItem,
  availability: LibraryCloudAvailabilityFilterValue,
  now = Date.now(),
): boolean => (
  availability === LibraryCloudAvailabilityFilter.All
  || getLibraryCloudAvailability(item, now) === availability
);
