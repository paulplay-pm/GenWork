import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
} from '@shared/htmlShare/constants';
import type { RefObject } from 'react';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

import { ArtifactFileShareIntent } from './artifactFileShareDialogModel';
import ArtifactPreviewIdentity from './ArtifactPreviewIdentity';
import {
  PublishingTrialStatus,
  usePublishingTrialStatus,
} from './PublishingTrialStatus';
import { ShareExpiryPreset, type ShareExpiryPreset as ShareExpiryPresetValue } from './shareExpiry';

const t = (key: string) => i18nService.t(key);

export const ArtifactFileSharePhase = {
  Preparing: 'preparing',
  Ready: 'ready',
  Error: 'error',
} as const;

export type ArtifactFileSharePhase =
  (typeof ArtifactFileSharePhase)[keyof typeof ArtifactFileSharePhase];

export const ArtifactFileShareOperation = {
  Creating: 'creating',
  UpdateFile: 'update_file',
  Stop: 'stop',
} as const;

export type ArtifactFileShareOperation =
  (typeof ArtifactFileShareOperation)[keyof typeof ArtifactFileShareOperation];

export const ArtifactFileShareCopyStatus = {
  Idle: 'idle',
  Copied: 'copied',
  Failed: 'failed',
} as const;

export type ArtifactFileShareCopyStatus =
  (typeof ArtifactFileShareCopyStatus)[keyof typeof ArtifactFileShareCopyStatus];

export const ArtifactFileShareUpdateStatus = {
  Idle: 'idle',
  Updated: 'updated',
} as const;

export type ArtifactFileShareUpdateStatus =
  (typeof ArtifactFileShareUpdateStatus)[keyof typeof ArtifactFileShareUpdateStatus];

interface ArtifactFileShareDialogProps {
  artifact: Artifact;
  phase: ArtifactFileSharePhase;
  operation?: ArtifactFileShareOperation;
  intent?: ArtifactFileShareIntent;
  message?: string;
  error?: string;
  shareUrl?: string;
  accessExpiresAt?: string | null;
  accessMode: HtmlShareAccessModeValue;
  selectedAccessMode: HtmlShareAccessModeValue;
  expiryPreset: ShareExpiryPresetValue;
  expiryCustomIso?: string;
  canRetry: boolean;
  canCreate: boolean;
  canCopy: boolean;
  canUpdateFile: boolean;
  canStop: boolean;
  copyStatus: ArtifactFileShareCopyStatus;
  updateStatus: ArtifactFileShareUpdateStatus;
  closeButtonRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
  onRetry: () => void;
  onCreate: () => void;
  onUpdateFile: () => void;
  onCopy: () => void;
  onStop: () => void;
  onSelectAccessMode: (accessMode: HtmlShareAccessModeValue) => void;
  onSelectExpiryPreset: (preset: ShareExpiryPresetValue) => void;
  onSelectExpiryCustom: (customIso: string) => void;
  onChangeAccessLevel: (accessMode: HtmlShareAccessModeValue) => void;
}

const CloseIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4.5 4.5l7 7" />
    <path d="M11.5 4.5l-7 7" />
  </svg>
);

const LoadingIndicator = () => (
  <span
    className="inline-block h-3.5 w-3.5 rounded-full border-2 border-primary/30 border-t-primary motion-safe:animate-spin"
    aria-hidden="true"
  />
);

const ArtifactFileShareDialog = ({
  artifact,
  phase,
  operation,
  intent,
  message,
  error,
  shareUrl,
  accessExpiresAt,
  accessMode,
  selectedAccessMode,
  expiryPreset,
  expiryCustomIso,
  canRetry,
  canCreate,
  canCopy,
  canUpdateFile,
  canStop,
  copyStatus,
  updateStatus,
  closeButtonRef,
  onClose,
  onRetry,
  onCreate,
  onUpdateFile,
  onCopy,
  onStop,
  onSelectAccessMode,
  onSelectExpiryPreset,
  onSelectExpiryCustom,
  onChangeAccessLevel,
}: ArtifactFileShareDialogProps) => {
  const trialStatus = usePublishingTrialStatus(accessExpiresAt);
  const isPreparing = phase === ArtifactFileSharePhase.Preparing;
  const isReady = phase === ArtifactFileSharePhase.Ready;
  const isCreate = intent === ArtifactFileShareIntent.Create;
  const isManage = intent === ArtifactFileShareIntent.Manage;
  const isCreating = operation === ArtifactFileShareOperation.Creating;
  const isStopping = operation === ArtifactFileShareOperation.Stop;
  const isUpdatingFile = operation === ArtifactFileShareOperation.UpdateFile;
  const isBusy = Boolean(operation);
  const isOrgAccess = accessMode === HtmlShareAccessMode.Org;
  const copyButtonLabel =
    copyStatus === ArtifactFileShareCopyStatus.Copied
      ? t('copied')
      : copyStatus === ArtifactFileShareCopyStatus.Failed
        ? t('copyFailed')
        : t('htmlShareCopyLink');
  const updateButtonLabel = isUpdatingFile
    ? t('htmlShareUpdatingFile')
    : updateStatus === ArtifactFileShareUpdateStatus.Updated
      ? t('htmlShareUpdateComplete')
      : t('htmlShareUpdateFile');
  const expiryOptions: Array<{ value: ShareExpiryPresetValue; labelKey: string }> = [
    { value: ShareExpiryPreset.Forever, labelKey: 'artifactFileShareExpiryForever' },
    { value: ShareExpiryPreset.OneDay, labelKey: 'artifactFileShareExpiry1d' },
    { value: ShareExpiryPreset.SevenDays, labelKey: 'artifactFileShareExpiry7d' },
    { value: ShareExpiryPreset.ThirtyDays, labelKey: 'artifactFileShareExpiry30d' },
    { value: ShareExpiryPreset.NinetyDays, labelKey: 'artifactFileShareExpiry90d' },
    { value: ShareExpiryPreset.Custom, labelKey: 'artifactFileShareExpiryCustom' },
  ];

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-busy={isPreparing || isBusy}
        aria-labelledby="artifact-file-share-dialog-title"
        aria-describedby="artifact-file-share-dialog-description"
        className="relative w-full max-w-[440px] rounded-2xl bg-background p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h2
              id="artifact-file-share-dialog-title"
              className="text-lg font-semibold leading-7 text-foreground"
            >
              {t('htmlShare')}
            </h2>
            <PublishingTrialStatus status={trialStatus} />
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('close')}
            title={t('close')}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="mt-3 rounded-xl bg-surface px-3 py-3">
          <ArtifactPreviewIdentity artifact={artifact} />
        </div>

        <div className="mt-5">
          <div className="flex min-h-5 items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {t('artifactFileShareAccessPermission')}
            </h3>
            {trialStatus.isExpired && (
              <span className="text-xs font-medium text-red-500" role="status">
                {t('htmlShareStoppedNotice')}
              </span>
            )}
          </div>

          {isReady && !isBusy && (isCreate || isManage) && (
            <div className="mt-3 space-y-3">
              {/* Access level: 公开 / 仅本组织 */}
              <div>
                <div className="mb-1.5 text-xs font-medium text-secondary">
                  {t('artifactFileShareAccessLevel')}
                </div>
                <div className="inline-flex rounded-lg border border-border bg-background p-0.5">
                  {([
                    { value: HtmlShareAccessMode.Public, labelKey: 'artifactFileShareLevelPublic' },
                    { value: HtmlShareAccessMode.Org, labelKey: 'artifactFileShareLevelOrg' },
                  ] as Array<{ value: HtmlShareAccessModeValue; labelKey: string }>).map((opt) => {
                    const active =
                      (isCreate && selectedAccessMode === opt.value)
                      || (isManage && accessMode === opt.value);
                    const onClick = isCreate
                      ? () => onSelectAccessMode(opt.value)
                      : () => onChangeAccessLevel(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={onClick}
                        disabled={isManage && accessMode === opt.value}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                          active
                            ? 'bg-primary text-primary-foreground'
                            : 'text-secondary hover:bg-surface'
                        } disabled:cursor-default disabled:opacity-60`}
                      >
                        {t(opt.labelKey)}
                      </button>
                    );
                  })}
                </div>
                {isOrgAccess && (
                  <p className="mt-1.5 text-xs leading-5 text-muted">
                    {t('artifactFileShareOrgAccessHint')}
                  </p>
                )}
              </div>

              {/* Expiry: create-only selection; manage shows the applied value read-only. */}
              {isCreate && (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-secondary">
                    {t('artifactFileShareExpiryLabel')}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={expiryPreset}
                      onChange={(event) => onSelectExpiryPreset(event.target.value as ShareExpiryPresetValue)}
                      className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                      aria-label={t('artifactFileShareExpiryLabel')}
                    >
                      {expiryOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </option>
                      ))}
                    </select>
                    {expiryPreset === ShareExpiryPreset.Custom && (
                      <input
                        type="datetime-local"
                        value={expiryCustomIso ?? ''}
                        onChange={(event) => onSelectExpiryCustom(event.target.value)}
                        className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                        aria-label={t('artifactFileShareExpiryCustom')}
                      />
                    )}
                  </div>
                </div>
              )}
              {isManage && accessExpiresAt && (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-secondary">
                    {t('artifactFileShareExpiryLabel')}
                  </div>
                  <p className="text-xs leading-5 text-muted">
                    {t('artifactFileShareExpiresAt').replace(
                      '{date}',
                      new Date(accessExpiresAt).toLocaleString(),
                    )}
                  </p>
                </div>
              )}
            </div>
          )}

          {isReady && intent === ArtifactFileShareIntent.Manage && shareUrl && (
            <div className="mt-3 break-all rounded-lg bg-surface px-3 py-2.5 text-sm text-secondary">
              <span className="block truncate font-medium text-foreground">{shareUrl}</span>
              <span className="mt-1 block text-xs leading-5 text-muted">
                {t('artifactFileSharePublicLinkHint')}
              </span>
            </div>
          )}

          <div
            id="artifact-file-share-dialog-description"
            className="mt-3 min-h-5 text-xs leading-5 text-muted"
          >
            {isPreparing && (
              <span className="inline-flex items-center gap-2" role="status">
                <LoadingIndicator />
                {message || t('artifactFileSharePreparing')}
              </span>
            )}
            {!isPreparing && isCreating && !error && (
              <span role="status">{t('artifactFileShareCreating')}</span>
            )}
            {!isPreparing && isStopping && !error && (
              <span role="status">{t('artifactFileShareStopping')}</span>
            )}
            {!isPreparing && isUpdatingFile && !error && (
              <span role="status">{t('htmlShareUpdatingFile')}</span>
            )}
            {!isPreparing && error && (
              <span className="text-red-500" role="alert">
                {error}
              </span>
            )}
            {!isPreparing && !error && !isCreating && !isStopping && !isUpdatingFile && message && (
              <span role="status">{message}</span>
            )}
          </div>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
          {phase === ArtifactFileSharePhase.Error && canRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex h-10 min-w-[88px] items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
            >
              {t('artifactFileShareRetry')}
            </button>
          )}
          {isReady && intent === ArtifactFileShareIntent.Manage && (
            <button
              type="button"
              onClick={onUpdateFile}
              disabled={!canUpdateFile || isBusy}
              className="inline-flex h-10 min-w-[96px] items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {updateButtonLabel}
            </button>
          )}
          {isReady && intent === ArtifactFileShareIntent.Manage && (
            <button
              type="button"
              onClick={onStop}
              disabled={!canStop || isBusy}
              className="inline-flex h-10 min-w-[104px] items-center justify-center rounded-lg border border-red-200 bg-background px-4 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isStopping ? t('artifactFileShareStopping') : t('artifactFileShareStopSharingAction')}
            </button>
          )}
          {intent === ArtifactFileShareIntent.Create && (
            <button
              type="button"
              onClick={onCreate}
              disabled={!canCreate || isBusy}
              className="inline-flex h-10 min-w-[104px] items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreating ? t('artifactFileShareCreating') : t('artifactFileShareCreateAction')}
            </button>
          )}
          {isReady && intent === ArtifactFileShareIntent.Manage && (
            <button
              type="button"
              onClick={onCopy}
              disabled={!canCopy || isBusy}
              className={`inline-flex h-10 min-w-[104px] items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                copyStatus === ArtifactFileShareCopyStatus.Failed
                  ? 'bg-red-500 text-white hover:bg-red-500/90'
                  : 'bg-primary text-primary-foreground hover:bg-primary-hover'
              }`}
            >
              {copyButtonLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ArtifactFileShareDialog;
