import React from 'react';

import { AppUpdateStatus, type AppUpdateStatus as AppUpdateStatusValue } from '../../../shared/appUpdate/constants';
import { i18nService } from '../../services/i18n';

interface AppUpdateBadgeProps {
  latestVersion: string;
  status: AppUpdateStatusValue;
  /** Download progress in [0, 1]; shown while status is Downloading. */
  progress?: number | null;
  onClick: () => void;
}

const AppUpdateBadge: React.FC<AppUpdateBadgeProps> = ({ latestVersion, status, progress, onClick }) => {
  const isReady = status === AppUpdateStatus.Ready;
  const isDownloading = status === AppUpdateStatus.Downloading;
  const isError = status === AppUpdateStatus.Error;
  const percent = progress != null ? Math.round(progress * 100) : null;

  const label = isReady
    ? i18nService.t('updateReadyPill')
    : isDownloading
      ? `${i18nService.t('updateDownloadingPill')}${percent != null ? ` ${percent}%` : ''}`
      : isError
        ? i18nService.t('updateErrorPill')
        : i18nService.t('updateAvailablePill');

  const tone = isReady
    ? 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-600 hover:bg-emerald-500/[0.14] dark:text-emerald-400'
    : isError
      ? 'border-red-500/30 bg-red-500/[0.07] text-red-500 hover:bg-red-500/[0.12]'
      : 'border-primary/25 bg-primary/[0.08] text-primary hover:bg-primary/[0.14]';
  const dotTone = isReady ? 'bg-emerald-500' : isError ? 'bg-red-500' : 'bg-primary';
  const showVersion = !isDownloading && !isError;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`non-draggable inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border pl-2 pr-2.5 text-xs font-medium transition-colors ${tone}`}
      title={`${label} v${latestVersion}`}
      aria-label={`${label} v${latestVersion}`}
    >
      {isDownloading ? (
        <svg className="h-3 w-3 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${dotTone}`}
            style={{ animationDuration: '2.4s' }}
          />
          <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${dotTone}`} />
        </span>
      )}
      <span>{label}</span>
      {showVersion && <span className="opacity-70">v{latestVersion}</span>}
    </button>
  );
};

export default AppUpdateBadge;
