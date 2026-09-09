import React, { useEffect } from 'react';

import { type AppUpdateRuntimeState, AppUpdateStatus } from '../../../shared/appUpdate/constants';
import { i18nService } from '../../services/i18n';

interface AppUpdateBlockingPanelProps {
  updateState: AppUpdateRuntimeState;
  onCancelDownload: () => Promise<void> | void;
}

const Spinner: React.FC = () => (
  <svg
    className="h-5 w-5 animate-spin"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
    <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V1C5.925 1 1 5.925 1 12h3z" />
  </svg>
);

const logBlockingPanelStatus = (status: string, version: string): void => {
  const message = `blocking panel rendered status=${status} version=${version}`;
  console.debug(`[AppUpdatePanel] ${message}`);
  try {
    window.electron?.log?.fromRenderer?.('debug', 'AppUpdatePanel', message);
  } catch {
    // Best-effort diagnostic only.
  }
};

const AppUpdateBlockingPanel: React.FC<AppUpdateBlockingPanelProps> = ({
  updateState,
  onCancelDownload,
}) => {
  const updateInfo = updateState.info;
  const isDownloading = updateState.status === AppUpdateStatus.Downloading;
  const isInstalling = updateState.status === AppUpdateStatus.Installing;
  const title = isDownloading
    ? i18nService.t('updateDownloading')
    : isInstalling
      ? i18nService.t('updateInstalling')
      : i18nService.t('updateReadyCardTitle');
  const rawPercent = updateState.progress?.percent;
  const percent = typeof rawPercent === 'number' && Number.isFinite(rawPercent)
    ? Math.min(100, Math.max(0, Math.round(rawPercent * 100)))
    : null;
  const currentLog = updateInfo?.changeLog?.[i18nService.getLanguage()];
  const releaseNotes = (currentLog?.content ?? []).filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
  const version = updateInfo?.latestVersion ?? 'unknown';

  useEffect(() => {
    logBlockingPanelStatus(updateState.status, version);
  }, [updateState.status, version]);

  return (
    <section
      className="flex max-h-full min-h-0 w-full animate-fade-in-up flex-col overflow-hidden rounded-2xl border border-border bg-surface px-6 py-5 shadow-elevated"
      aria-label={updateInfo ? `${title} v${updateInfo.latestVersion}` : title}
      aria-busy="true"
      aria-modal="true"
      role="dialog"
    >
      <div className="flex shrink-0 items-center gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
          aria-hidden="true"
        >
          <Spinner />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {updateInfo && (
            <p className="mt-0.5 text-xs text-secondary">
              v{updateInfo.latestVersion}{updateInfo.date ? ` · ${updateInfo.date}` : ''}
            </p>
          )}
        </div>
      </div>

      {(currentLog?.title || releaseNotes.length > 0) && (
        <div className="mt-5 flex min-h-0 flex-1 flex-col border-t border-border-subtle pt-4">
          {currentLog?.title && (
            <p className="shrink-0 text-sm font-medium text-foreground">{currentLog.title}</p>
          )}
          {releaseNotes.length > 0 && (
            <ul className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-2">
              {releaseNotes.map((item, index) => (
                <li key={index} className="flex items-start gap-2.5 text-sm leading-5 text-secondary">
                  <span
                    className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary/60"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 break-words">{item}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isDownloading && (
        <div className="mt-5 shrink-0 border-t border-border-subtle pt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-primary/15">
            {percent != null ? (
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            ) : (
              <div className="h-full w-full animate-pulse rounded-full bg-primary/60" />
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-4 text-xs text-secondary">
            <span>{percent != null ? `${percent}%` : i18nService.t('updateDownloadingPill')}</span>
            <button
              type="button"
              onClick={() => void onCancelDownload()}
              className="shrink-0 rounded-md px-2 py-1 transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
            >
              {i18nService.t('updateDownloadCancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

export default AppUpdateBlockingPanel;
