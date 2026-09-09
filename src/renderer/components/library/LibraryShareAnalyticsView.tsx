import { ChartBarIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '../../services/i18n';
import {
  MANAGEMENT_BODY_TEXT,
  MANAGEMENT_TITLE_TEXT,
} from '../common/managementTypography';

const LibraryShareAnalyticsRange = {
  SevenDays: 7,
  ThirtyDays: 30,
} as const;

type LibraryShareAnalyticsRange =
  (typeof LibraryShareAnalyticsRange)[keyof typeof LibraryShareAnalyticsRange];

const toLocalDateValue = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const libraryShareAnalyticsDateValues = (
  range: LibraryShareAnalyticsRange,
  today = new Date(),
): { from: string; to: string } => {
  const to = new Date(today);
  const from = new Date(today);
  from.setDate(from.getDate() - (range - 1));
  return { from: toLocalDateValue(from), to: toLocalDateValue(to) };
};

interface LibraryShareAnalyticsViewProps {
  shareId: string;
}

// The enterprise html-share runtime does not expose a share analytics endpoint yet,
// so this surface renders an unavailable state instead of querying for metrics.
const LibraryShareAnalyticsView: React.FC<LibraryShareAnalyticsViewProps> = () => (
  <div className="mt-5 space-y-3">
    <div className="flex min-h-9 items-center px-0.5">
      <h2 className={`${MANAGEMENT_TITLE_TEXT} font-semibold text-foreground`}>
        {i18nService.t('librarySharePerformance')}
      </h2>
    </div>
    <div className="rounded-xl border border-dashed border-border bg-surface px-4 py-12 text-center">
      <ChartBarIcon className="mx-auto h-6 w-6 text-tertiary" aria-hidden="true" />
      <p className={`${MANAGEMENT_BODY_TEXT} mt-3 text-secondary`}>
        {i18nService.t('libraryShareAnalyticsLoadFailed')}
      </p>
    </div>
  </div>
);

export default LibraryShareAnalyticsView;
