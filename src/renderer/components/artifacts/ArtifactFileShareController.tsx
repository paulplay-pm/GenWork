import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  type HtmlShareDisabledSource as HtmlShareDisabledSourceValue,
  HtmlShareStatus,
  type HtmlShareStatus as HtmlShareStatusValue,
} from '@shared/htmlShare/constants';
import { LibraryNavigationEvent } from '@shared/library/constants';
import {
  type PublishingQuotaErrorData,
  PublishingResourceKind,
} from '@shared/publishing/constants';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useSelector } from 'react-redux';

import { selectIsEnterpriseAccount } from '@/features/enterpriseAccount/selectors';
import { authService } from '@/services/auth';
import { copyTextToClipboard } from '@/services/clipboard';
import { getPortalPricingUrl } from '@/services/endpoints';
import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';
import type { Artifact } from '@/types/artifact';

import Modal from '../common/Modal';
import {
  type ArtifactPreviewActionSource as ArtifactPreviewActionSourceValue,
  type ArtifactPublishEntryPoint as ArtifactPublishEntryPointValue,
  reportArtifactPreviewAction,
} from './artifactAnalytics';
import { buildArtifactFileShareCopyText } from './artifactFileShareCopy';
import {
  ArtifactFileShareCopyStatus,
  ArtifactFileShareOperation,
  ArtifactFileSharePhase,
  ArtifactFileShareUpdateStatus,
} from './ArtifactFileShareDialog';
import ArtifactFileShareDialog from './ArtifactFileShareDialog';
import {
  ArtifactFileShareIntent,
  type ArtifactFileShareIntent as ArtifactFileShareIntentValue,
} from './artifactFileShareDialogModel';
import {
  ArtifactFileSharePermission,
  type ArtifactFileSharePermission as ArtifactFileSharePermissionValue,
  deriveArtifactFileSharePermission,
} from './artifactFileSharePermission';
import {
  type ArtifactFileShareRequest,
  ArtifactFileShareRequestSource,
  buildArtifactFileShareRequest,
  getArtifactFileShareSourceType,
  isArtifactFileShareable,
} from './artifactFileSharePolicy';
import {
  ArtifactSubscriptionFeature,
  type ArtifactSubscriptionPromptState,
  resolveArtifactSubscriptionDecision,
} from './artifactSubscriptionGate';
import ArtifactSubscriptionPromptDialog from './ArtifactSubscriptionPromptDialog';
import { bakeArtifactSharePage } from './bakeArtifactSharePage';
import {
  createPublishingAnalyticsAttempt,
  getPublishingErrorCategory,
  type PublishingAnalyticsAttemptContext,
  PublishingAnalyticsErrorCategory,
  PublishingAnalyticsOperationType,
  PublishingAnalyticsResult,
  reportPublishingEntryAction,
  reportPublishingOperationResult,
  updatePublishingAnalyticsAttempt,
} from './publishingAnalytics';
import PublishingQuotaLimitDialog from './PublishingQuotaLimitDialog';
import PublishingTrialNoticeDialog from './PublishingTrialNoticeDialog';
import { shouldShowPublishingTrialNotice } from './publishingTrialNoticePolicy';
import { computeShareExpiryIso,ShareExpiryPreset, type ShareExpiryPreset as ShareExpiryPresetValue } from './shareExpiry';

const t = (key: string) => i18nService.t(key);

interface ArtifactFileShareRecord {
  shareId: string;
  url: string;
  accessMode: HtmlShareAccessModeValue;
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  status: HtmlShareStatusValue;
  disabledSource?: HtmlShareDisabledSourceValue | null;
  accessExpiresAt?: string | null;
}

interface ArtifactFileShareDialogState {
  artifact: Artifact;
  request?: ArtifactFileShareRequest;
  phase: ArtifactFileSharePhase;
  intent?: ArtifactFileShareIntentValue;
  operation?: ArtifactFileShareOperation;
  share?: ArtifactFileShareRecord;
  selectedPermission?: ArtifactFileSharePermissionValue;
  /** Access level selected in the dialog (public vs org-only). Defaults to public. */
  selectedAccessMode?: HtmlShareAccessModeValue;
  /** Expiry preset selected in the dialog (create only). */
  expiryPreset?: ShareExpiryPreset;
  /** Custom date/time input (datetime-local value) when expiryPreset === 'custom'. */
  expiryCustomIso?: string;
  message?: string;
  error?: string;
}

interface PreparedArtifactFileShare {
  share?: ArtifactFileShareRecord;
}

interface ArtifactFileShareTrialNoticeState {
  artifact: Artifact;
  request: ArtifactFileShareRequest;
  quota: PublishingQuotaErrorData;
}

interface ArtifactFileShareControllerValue {
  isOverlayOpen: boolean;
  openShare: (
    artifact: Artifact,
    context: ArtifactFileShareOpenContext,
  ) => Promise<void>;
}

interface ArtifactFileShareOpenContext {
  source: ArtifactPreviewActionSourceValue;
  entryPoint: ArtifactPublishEntryPointValue;
  surface?: string;
  pageViewId?: string;
}

interface ArtifactFileShareProviderProps {
  sessionId: string;
  children: ReactNode;
}

type HtmlShareApi = NonNullable<typeof window.electron>['htmlShare'];
type HtmlShareResult = Awaited<ReturnType<HtmlShareApi['createFromHtmlFile']>>;

const ArtifactFileShareContext = createContext<ArtifactFileShareControllerValue | null>(null);

class ArtifactFileShareRequestError extends Error {
  readonly code?: number;
  readonly quota?: PublishingQuotaErrorData;

  constructor(message: string, code?: number, quota?: PublishingQuotaErrorData) {
    super(message);
    this.name = 'ArtifactFileShareRequestError';
    this.code = code;
    this.quota = quota;
  }
}

function getFailureMessage(result: { code?: number; error?: string } | null | undefined): string {
  return result?.error || t('htmlShareFailed');
}

function getShareRecord(
  value:
    | {
        success?: boolean;
        shareId?: string;
        url?: string;
        accessMode?: HtmlShareAccessModeValue;
        shareCode?: string | null;
        shareCodeUnavailable?: boolean;
        status?: HtmlShareStatusValue;
        disabledSource?: HtmlShareDisabledSourceValue | null;
        accessExpiresAt?: string | null;
      }
    | null
    | undefined,
  previous?: ArtifactFileShareRecord,
): ArtifactFileShareRecord | null {
  const shareId = value?.shareId || previous?.shareId;
  const url = value?.url || previous?.url;
  if (!shareId || !url) return null;

  // The enterprise page server serves `public` and `code` shares identically
  // (it only gates `org`) and never returns a share code, so a link-backed
  // share is treated as public unless the server reports it as org-only.
  const accessMode: HtmlShareAccessModeValue =
    value?.accessMode === HtmlShareAccessMode.Org
      ? HtmlShareAccessMode.Org
      : previous?.accessMode === HtmlShareAccessMode.Org
        ? HtmlShareAccessMode.Org
        : HtmlShareAccessMode.Public;
  const status = value?.status ?? previous?.status ?? HtmlShareStatus.Live;

  return {
    shareId,
    url,
    accessMode,
    status,
    disabledSource:
      status === HtmlShareStatus.Disabled
        ? (value?.disabledSource ?? previous?.disabledSource)
        : undefined,
    accessExpiresAt: value?.accessExpiresAt ?? previous?.accessExpiresAt,
  };
}

function requireShareRecord(
  result: HtmlShareResult,
  previous?: ArtifactFileShareRecord,
): ArtifactFileShareRecord {
  if (!result?.success) {
    throw new ArtifactFileShareRequestError(
      getFailureMessage(result),
      result?.code,
      result?.quota,
    );
  }
  const share = getShareRecord(result, previous);
  if (!share) {
    throw new ArtifactFileShareRequestError(getFailureMessage(result), result?.code);
  }
  return share;
}

async function createShare(
  api: HtmlShareApi,
  artifact: Artifact,
  request: ArtifactFileShareRequest,
  options: { expiresAt?: string; accessMode?: HtmlShareAccessModeValue },
): Promise<HtmlShareResult> {
  if (request.source === ArtifactFileShareRequestSource.HtmlFile) {
    return api.createFromHtmlFile({
      sessionId: request.sessionId,
      artifactId: request.artifactId,
      filePath: request.filePath || '',
      title: request.title,
      clientSourceKey: request.lookupKey,
      expiresAt: options.expiresAt,
      accessMode: options.accessMode,
    });
  }
  const html = await bakeArtifactSharePage({
    artifact,
    request,
  });
  return api.createFromBakedHtml({
    html,
    sourceType: request.sourceType,
    clientSourceKey: request.lookupKey,
    title: request.title,
    expiresAt: options.expiresAt,
    accessMode: options.accessMode,
  });
}

async function updateShareFile(
  api: HtmlShareApi,
  artifact: Artifact,
  request: ArtifactFileShareRequest,
  previousShare?: ArtifactFileShareRecord,
): Promise<HtmlShareResult> {
  // The enterprise server has no content-update endpoint; updating a share
  // publishes a fresh bake under the same clientSourceKey (by-source lookup
  // then resolves to the newest), while the prior link keeps serving the old
  // content. This is the same path create takes, so carry the prior share's
  // expiry deadline and access level across to the new row — otherwise a
  // re-bake of an org-only share would reset to public.
  return createShare(api, artifact, request, {
    expiresAt: previousShare?.accessExpiresAt || undefined,
    accessMode: previousShare?.accessMode ?? HtmlShareAccessMode.Public,
  });
}

function logShare(level: 'debug' | 'warn', message: string): void {
  const boundedMessage = message.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (level === 'warn') {
    console.warn(`[ArtifactFileShare] ${boundedMessage}`);
  } else {
    console.debug(`[ArtifactFileShare] ${boundedMessage}`);
  }
  try {
    window.electron?.log?.fromRenderer?.(level, 'ArtifactFileShare', boundedMessage);
  } catch {
    // Diagnostics must never change the result of a share operation.
  }
}

export function ArtifactFileShareProvider({ sessionId, children }: ArtifactFileShareProviderProps) {
  const authState = useSelector((state: RootState) => state.auth);
  const isEnterpriseAccount = useSelector(selectIsEnterpriseAccount);
  const [dialog, setDialog] = useState<ArtifactFileShareDialogState | null>(null);
  const [subscriptionPrompt, setSubscriptionPrompt] =
    useState<ArtifactSubscriptionPromptState | null>(null);
  const [publishingQuota, setPublishingQuota] =
    useState<PublishingQuotaErrorData | null>(null);
  const [trialNotice, setTrialNotice] =
    useState<ArtifactFileShareTrialNoticeState | null>(null);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [copyStatus, setCopyStatus] = useState<ArtifactFileShareCopyStatus>(
    ArtifactFileShareCopyStatus.Idle,
  );
  const [updateStatus, setUpdateStatus] = useState<ArtifactFileShareUpdateStatus>(
    ArtifactFileShareUpdateStatus.Idle,
  );
  const generationRef = useRef(0);
  const mutationBarriersRef = useRef(new Map<string, Promise<void>>());
  const preparationPromisesRef = useRef(new Map<string, Promise<PreparedArtifactFileShare>>());
  const feedbackTimerRef = useRef<number | undefined>(undefined);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const analyticsAttemptRef = useRef<PublishingAnalyticsAttemptContext | null>(null);

  const clearFeedbackTimer = useCallback(() => {
    if (feedbackTimerRef.current !== undefined) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = undefined;
    }
  }, []);

  const resetFeedback = useCallback(() => {
    clearFeedbackTimer();
    setCopyStatus(ArtifactFileShareCopyStatus.Idle);
    setUpdateStatus(ArtifactFileShareUpdateStatus.Idle);
  }, [clearFeedbackTimer]);

  useEffect(() => {
    generationRef.current += 1;
    mutationBarriersRef.current.clear();
    preparationPromisesRef.current.clear();
    setDialog(null);
    setSubscriptionPrompt(null);
    setPublishingQuota(null);
    setTrialNotice(null);
    resetFeedback();
  }, [
    authState.accountGeneration,
    authState.ownerAccountKey,
    resetFeedback,
    sessionId,
  ]);

  useEffect(() => () => clearFeedbackTimer(), [clearFeedbackTimer]);

  const closeDialog = useCallback(() => {
    generationRef.current += 1;
    setDialog(null);
    setStopConfirm(false);
    resetFeedback();
  }, [resetFeedback]);

  const closeSubscriptionPrompt = useCallback(() => {
    generationRef.current += 1;
    setSubscriptionPrompt(null);
  }, []);

  const closeTrialNotice = useCallback(() => {
    generationRef.current += 1;
    setTrialNotice(null);
  }, []);

  const showPublishingQuota = useCallback((error: unknown): boolean => {
    if (!(error instanceof ArtifactFileShareRequestError) || !error.quota) return false;
    setDialog(null);
    setPublishingQuota(error.quota);
    return true;
  }, []);

  const isDialogOpen = Boolean(dialog);
  const isDialogBusy = Boolean(dialog?.operation);
  const dialogFocusKey = dialog ? `${dialog.artifact.id}:${dialog.phase}` : '';

  useEffect(() => {
    if (!isDialogOpen) return undefined;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isDialogOpen]);

  useEffect(() => {
    if (!dialogFocusKey) return undefined;
    const frameId = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (isDialogBusy) return;
        closeDialog();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialogElement = closeButtonRef.current?.closest<HTMLElement>('[role="dialog"]');
      if (!dialogElement) return;
      const focusableElements = Array.from(
        dialogElement.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      if (!dialogElement.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastElement : firstElement).focus();
      } else if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frameId);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeDialog, dialogFocusKey, isDialogBusy]);

  const showTimedCopyStatus = useCallback(
    (status: ArtifactFileShareCopyStatus) => {
      clearFeedbackTimer();
      setCopyStatus(status);
      feedbackTimerRef.current = window.setTimeout(() => {
        setCopyStatus(ArtifactFileShareCopyStatus.Idle);
        feedbackTimerRef.current = undefined;
      }, 2200);
    },
    [clearFeedbackTimer],
  );

  const showTimedUpdateSuccess = useCallback(() => {
    clearFeedbackTimer();
    setUpdateStatus(ArtifactFileShareUpdateStatus.Updated);
    feedbackTimerRef.current = window.setTimeout(() => {
      setUpdateStatus(ArtifactFileShareUpdateStatus.Idle);
      feedbackTimerRef.current = undefined;
    }, 2200);
  }, [clearFeedbackTimer]);

  const getSubscriptionDecision = useCallback(async () => {
    return resolveArtifactSubscriptionDecision({
      isLoggedIn: authState.isLoggedIn,
      isEnterpriseAccount,
      subscriptionStatus: authState.quota?.subscriptionStatus,
      accountMode: authState.quota?.accountMode ?? authState.user?.accountMode,
      shareEntitled: authState.quota?.shareEntitled,
      deploymentEntitled: authState.quota?.deploymentEntitled,
    }, async () => {
      const refreshed = await authService.refreshAuthState();
      return {
        isLoggedIn: refreshed.isLoggedIn,
        isEnterpriseAccount,
        subscriptionStatus: refreshed.quota?.subscriptionStatus,
        accountMode: refreshed.quota?.accountMode ?? refreshed.user?.accountMode,
        shareEntitled: refreshed.quota?.shareEntitled,
        deploymentEntitled: refreshed.quota?.deploymentEntitled,
      };
    }, ArtifactSubscriptionFeature.Share);
  }, [authState.isLoggedIn, isEnterpriseAccount, authState.quota, authState.user?.accountMode]);

  const lookupShare = useCallback(async (api: HtmlShareApi, request: ArtifactFileShareRequest) => {
    return api.getBySource({
      sourceType: request.sourceType,
      clientSourceKey: request.lookupKey,
    });
  }, []);

  const refreshShare = useCallback(
    async (
      api: HtmlShareApi,
      request: ArtifactFileShareRequest,
      fallback: ArtifactFileShareRecord,
    ): Promise<ArtifactFileShareRecord> => {
      try {
        const lookup = await lookupShare(api, request);
        if (lookup?.success) return getShareRecord(lookup.share, fallback) ?? fallback;
      } catch {
        // Keep the last confirmed response when the follow-up lookup is unavailable.
      }
      return fallback;
    },
    [lookupShare],
  );

  const loadShare = useCallback(
    (api: HtmlShareApi, request: ArtifactFileShareRequest): Promise<PreparedArtifactFileShare> => {
      const key = request.lookupKey;
      const pending = preparationPromisesRef.current.get(key);
      if (pending) return pending;

      const preparation = (async (): Promise<PreparedArtifactFileShare> => {
        const lookup = await lookupShare(api, request);
        if (!lookup?.success) {
          throw new ArtifactFileShareRequestError(getFailureMessage(lookup), lookup?.code);
        }

        const existingShare = getShareRecord(lookup.share);
        if (existingShare) {
          return { share: existingShare };
        }
        return {};
      })().finally(() => {
        if (preparationPromisesRef.current.get(key) === preparation) {
          preparationPromisesRef.current.delete(key);
        }
      });

      preparationPromisesRef.current.set(key, preparation);
      return preparation;
    },
    [lookupShare],
  );

  const initializeShare = useCallback(
    async (artifact: Artifact, request: ArtifactFileShareRequest): Promise<void> => {
      const api = window.electron?.htmlShare;
      const runId = generationRef.current + 1;
      generationRef.current = runId;
      resetFeedback();
      setDialog(null);
      setSubscriptionPrompt(null);
      setPublishingQuota(null);
      setTrialNotice(null);

      try {
        const subscriptionDecision = await getSubscriptionDecision();
        if (generationRef.current !== runId) return;
        if (!subscriptionDecision.allowed) {
          setSubscriptionPrompt({
            feature: ArtifactSubscriptionFeature.Share,
            reason: subscriptionDecision.reason,
          });
          return;
        }
        setDialog({
          artifact,
          request,
          phase: ArtifactFileSharePhase.Preparing,
          selectedPermission: ArtifactFileSharePermission.Code,
          selectedAccessMode: HtmlShareAccessMode.Public,
          expiryPreset: ShareExpiryPreset.Forever,
          message: t('artifactFileShareChecking'),
        });
        if (!api) throw new Error(t('htmlShareUnavailableInProduction'));

        const mutationBarrier = mutationBarriersRef.current.get(request.lookupKey);
        if (mutationBarrier) await mutationBarrier;
        if (generationRef.current !== runId) return;

        const prepared = await loadShare(api, request);
        if (generationRef.current !== runId) return;
        if (analyticsAttemptRef.current) {
          analyticsAttemptRef.current = updatePublishingAnalyticsAttempt(
            analyticsAttemptRef.current,
            {
              operationType: prepared.share
                ? PublishingAnalyticsOperationType.Manage
                : PublishingAnalyticsOperationType.Create,
              hasExistingResource: Boolean(prepared.share),
            },
          );
        }
        if (!prepared.share) {
          const quotaResult = await api.getQuota();
          if (generationRef.current !== runId) return;
          if (!quotaResult?.success || !quotaResult.data) {
            throw new ArtifactFileShareRequestError(
              quotaResult?.error || t('htmlShareQuotaLoadFailed'),
              quotaResult?.code,
            );
          }
          if (!quotaResult.data.allowed) {
            setDialog(null);
            setPublishingQuota(quotaResult.data);
            return;
          }
          if (shouldShowPublishingTrialNotice({
            allowed: quotaResult.data.allowed,
            identityType: quotaResult.data.identityType,
            hasExistingResource: false,
          })) {
            setDialog(null);
            setTrialNotice({
              artifact,
              request,
              quota: quotaResult.data,
            });
            return;
          }
        }
        const intent = prepared.share
          ? ArtifactFileShareIntent.Manage
          : ArtifactFileShareIntent.Create;
        const selectedPermission = prepared.share
          ? deriveArtifactFileSharePermission(prepared.share)
          : ArtifactFileSharePermission.Code;
        const selectedAccessMode: HtmlShareAccessModeValue = prepared.share
          ? (prepared.share.accessMode === HtmlShareAccessMode.Org
              ? HtmlShareAccessMode.Org
              : HtmlShareAccessMode.Public)
          : HtmlShareAccessMode.Public;
        setDialog({
          artifact,
          request,
          phase: ArtifactFileSharePhase.Ready,
          intent,
          share: prepared.share,
          selectedPermission,
          selectedAccessMode,
          expiryPreset: ShareExpiryPreset.Forever,
        });
      } catch (error) {
        if (generationRef.current !== runId) return;
        if (analyticsAttemptRef.current) {
          reportPublishingOperationResult(analyticsAttemptRef.current, {
            result: PublishingAnalyticsResult.Failure,
            errorCategory: getPublishingErrorCategory(error),
          });
        }
        const message = error instanceof Error ? error.message : t('htmlShareFailed');
        logShare('warn', `Failed to prepare share for artifact ${request.artifactId}: ${message}`);
        setDialog({
          artifact,
          request,
          phase: ArtifactFileSharePhase.Error,
          selectedPermission: ArtifactFileSharePermission.Code,
          error: message,
        });
      }
    },
    [getSubscriptionDecision, loadShare, resetFeedback],
  );

  const continueTrialShare = useCallback(() => {
    const pending = trialNotice;
    if (!pending) return;
    setTrialNotice(null);
    setDialog({
      artifact: pending.artifact,
      request: pending.request,
      phase: ArtifactFileSharePhase.Ready,
      intent: ArtifactFileShareIntent.Create,
      selectedPermission: ArtifactFileSharePermission.Code,
    });
  }, [trialNotice]);

  const openShare = useCallback(
    async (
      artifact: Artifact,
      context: ArtifactFileShareOpenContext,
    ): Promise<void> => {
      const sourceType = getArtifactFileShareSourceType(artifact);
      const analyticsAttempt = createPublishingAnalyticsAttempt({
        feature: ArtifactSubscriptionFeature.Share,
        resourceKind: PublishingResourceKind.File,
        operationType: PublishingAnalyticsOperationType.Unknown,
        source: context.source,
        entryPoint: context.entryPoint,
        surface: context.surface,
        pageViewId: context.pageViewId,
      });
      analyticsAttemptRef.current = analyticsAttempt;
      reportPublishingEntryAction(analyticsAttempt);
      reportArtifactPreviewAction({
        actionType: 'share_html_click',
        source: context.source,
        artifact,
        params: {
          entryPoint: context.entryPoint,
          shareSourceType: sourceType ?? undefined,
        },
      });

      const request = isArtifactFileShareable(artifact)
        ? buildArtifactFileShareRequest(artifact, sessionId, t('htmlShare'))
        : null;
      if (!request) {
        reportPublishingOperationResult(analyticsAttempt, {
          result: PublishingAnalyticsResult.Failure,
          errorCategory: PublishingAnalyticsErrorCategory.InvalidSource,
        });
        generationRef.current += 1;
        setDialog({
          artifact,
          phase: ArtifactFileSharePhase.Error,
          error: t('artifactShareSourceUnavailable'),
        });
        return;
      }
      await initializeShare(artifact, request);
    },
    [initializeShare, sessionId],
  );

  const retryShare = useCallback(() => {
    if (!dialog?.request) return;
    void initializeShare(dialog.artifact, dialog.request);
  }, [dialog, initializeShare]);

  const submitCreateShare = useCallback(async (): Promise<void> => {
    const snapshot = dialog;
    if (
      !snapshot?.request ||
      snapshot.phase !== ArtifactFileSharePhase.Ready ||
      snapshot.intent !== ArtifactFileShareIntent.Create ||
      snapshot.share ||
      snapshot.operation ||
      mutationBarriersRef.current.has(snapshot.request.lookupKey)
    ) {
      return;
    }
    const api = window.electron?.htmlShare;
    if (!api) return;
    const runId = generationRef.current + 1;
    generationRef.current = runId;
    let releaseMutationBarrier: (() => void) | undefined;
    const mutationBarrier = new Promise<void>(resolve => {
      releaseMutationBarrier = resolve;
    });
    const mutationKey = snapshot.request.lookupKey;
    mutationBarriersRef.current.set(mutationKey, mutationBarrier);
    resetFeedback();
    setDialog(previous =>
      previous && previous.artifact.id === snapshot.artifact.id
        ? {
            ...previous,
            operation: ArtifactFileShareOperation.Creating,
            error: undefined,
            message: undefined,
          }
        : previous,
    );

    try {
      const expiresAt = computeShareExpiryIso(
        snapshot.expiryPreset ?? ShareExpiryPreset.Forever,
        snapshot.expiryCustomIso,
        Date.now(),
      );
      const accessMode =
        snapshot.selectedAccessMode === HtmlShareAccessMode.Org
          ? HtmlShareAccessMode.Org
          : HtmlShareAccessMode.Public;
      const result = await createShare(api, snapshot.artifact, snapshot.request, {
        expiresAt,
        accessMode,
      });
      let share = requireShareRecord(result);
      if (generationRef.current !== runId) return;
      share = await refreshShare(api, snapshot.request, share);
      if (generationRef.current !== runId) return;
      // access_mode is stored atomically at create, so no post-create PATCH is
      // needed. The refresh above re-reads the server's authoritative mode.
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? {
              ...previous,
              intent: ArtifactFileShareIntent.Manage,
              share,
              selectedAccessMode: accessMode,
              selectedPermission: deriveArtifactFileSharePermission(share),
              operation: undefined,
              message: result.warnings?.length
                ? result.warnings.slice(0, 3).join('\n')
                : t('htmlShareSuccessMessage'),
              error: undefined,
            }
          : previous,
      );
      logShare(
        'debug',
        `Created ${snapshot.request.sourceType} share for artifact ${snapshot.request.artifactId}.`,
      );
      if (analyticsAttemptRef.current) {
        reportPublishingOperationResult(analyticsAttemptRef.current, {
          result: PublishingAnalyticsResult.Success,
          operationType: PublishingAnalyticsOperationType.Create,
        });
        analyticsAttemptRef.current = updatePublishingAnalyticsAttempt(
          analyticsAttemptRef.current,
          {
            operationType: PublishingAnalyticsOperationType.Manage,
            hasExistingResource: true,
          },
        );
      }
    } catch (error) {
      if (generationRef.current !== runId) return;
      if (analyticsAttemptRef.current) {
        reportPublishingOperationResult(analyticsAttemptRef.current, {
          result: PublishingAnalyticsResult.Failure,
          operationType: PublishingAnalyticsOperationType.Create,
          errorCategory: getPublishingErrorCategory(error),
        });
      }
      if (showPublishingQuota(error)) return;
      const message = error instanceof Error ? error.message : t('htmlShareFailed');
      logShare(
        'warn',
        `Failed to create share for artifact ${snapshot.request.artifactId}: ${message}`,
      );
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? { ...previous, operation: undefined, error: message }
          : previous,
      );
    } finally {
      if (mutationBarriersRef.current.get(mutationKey) === mutationBarrier) {
        mutationBarriersRef.current.delete(mutationKey);
      }
      releaseMutationBarrier?.();
    }
  }, [dialog, refreshShare, resetFeedback, showPublishingQuota]);

  const requestStop = useCallback(() => {
    const snapshot = dialog;
    if (
      !snapshot?.request ||
      snapshot.phase !== ArtifactFileSharePhase.Ready ||
      snapshot.intent !== ArtifactFileShareIntent.Manage ||
      !snapshot.share ||
      snapshot.operation
    ) {
      return;
    }
    setStopConfirm(true);
  }, [dialog]);

  const confirmStop = useCallback(async (): Promise<void> => {
    const snapshot = dialog;
    if (
      !snapshot?.request ||
      snapshot.phase !== ArtifactFileSharePhase.Ready ||
      snapshot.intent !== ArtifactFileShareIntent.Manage ||
      !snapshot.share ||
      snapshot.operation ||
      mutationBarriersRef.current.has(snapshot.request.lookupKey)
    ) {
      return;
    }
    const api = window.electron?.htmlShare;
    if (!api) return;
    const shareId = snapshot.share.shareId;
    setStopConfirm(false);
    const runId = generationRef.current + 1;
    generationRef.current = runId;
    let releaseMutationBarrier: (() => void) | undefined;
    const mutationBarrier = new Promise<void>(resolve => {
      releaseMutationBarrier = resolve;
    });
    const mutationKey = snapshot.request.lookupKey;
    mutationBarriersRef.current.set(mutationKey, mutationBarrier);
    setDialog(previous =>
      previous && previous.artifact.id === snapshot.artifact.id
        ? {
            ...previous,
            operation: ArtifactFileShareOperation.Stop,
            error: undefined,
            message: undefined,
          }
        : previous,
    );

    try {
      const result = await api.delete(shareId);
      if (generationRef.current !== runId) return;
      if (!result?.success) {
        throw new ArtifactFileShareRequestError(result?.error || t('htmlShareFailed'));
      }
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? {
              ...previous,
              intent: ArtifactFileShareIntent.Create,
              share: undefined,
              operation: undefined,
              message: t('artifactFileShareStoppedMessage'),
              error: undefined,
            }
          : previous,
      );
      if (analyticsAttemptRef.current) {
        reportPublishingOperationResult(analyticsAttemptRef.current, {
          result: PublishingAnalyticsResult.Success,
          operationType: PublishingAnalyticsOperationType.Manage,
        });
      }
    } catch (error) {
      if (generationRef.current !== runId) return;
      if (analyticsAttemptRef.current) {
        reportPublishingOperationResult(analyticsAttemptRef.current, {
          result: PublishingAnalyticsResult.Failure,
          operationType: PublishingAnalyticsOperationType.Manage,
          errorCategory: getPublishingErrorCategory(error),
        });
      }
      const message = error instanceof Error ? error.message : t('htmlShareFailed');
      logShare('warn', `Failed to delete share ${shareId}: ${message}`);
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? { ...previous, operation: undefined, error: message }
          : previous,
      );
    } finally {
      if (mutationBarriersRef.current.get(mutationKey) === mutationBarrier) {
        mutationBarriersRef.current.delete(mutationKey);
      }
      releaseMutationBarrier?.();
    }
  }, [dialog]);

  const updateFile = useCallback(async (): Promise<void> => {
    const snapshot = dialog;
    if (
      !snapshot?.request ||
      snapshot.phase !== ArtifactFileSharePhase.Ready ||
      snapshot.intent !== ArtifactFileShareIntent.Manage ||
      !snapshot.share ||
      snapshot.operation ||
      snapshot.share.status === HtmlShareStatus.Disabled ||
      snapshot.share.status === HtmlShareStatus.Failed ||
      mutationBarriersRef.current.has(snapshot.request.lookupKey)
    ) {
      return;
    }
    const api = window.electron?.htmlShare;
    if (!api) return;
    const runId = generationRef.current + 1;
    generationRef.current = runId;
    let releaseMutationBarrier: (() => void) | undefined;
    const mutationBarrier = new Promise<void>(resolve => {
      releaseMutationBarrier = resolve;
    });
    const mutationKey = snapshot.request.lookupKey;
    mutationBarriersRef.current.set(mutationKey, mutationBarrier);
    resetFeedback();
    setDialog(previous =>
      previous
        ? {
            ...previous,
            operation: ArtifactFileShareOperation.UpdateFile,
            error: undefined,
            message: undefined,
          }
        : previous,
    );

    try {
      let share = requireShareRecord(
        await updateShareFile(api, snapshot.artifact, snapshot.request, snapshot.share),
        snapshot.share,
      );
      if (generationRef.current !== runId) return;
      share = await refreshShare(api, snapshot.request, share);
      if (generationRef.current !== runId) return;
      // The access level is carried across at re-bake (see updateShareFile), so
      // no post-create access-mode PATCH is needed.
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? {
              ...previous,
              share,
              selectedPermission: deriveArtifactFileSharePermission(share),
              operation: undefined,
              message: undefined,
            }
          : previous,
      );
      showTimedUpdateSuccess();
      if (analyticsAttemptRef.current) {
        reportPublishingOperationResult(analyticsAttemptRef.current, {
          result: PublishingAnalyticsResult.Success,
          operationType: PublishingAnalyticsOperationType.UpdateContent,
        });
      }
    } catch (error) {
      if (generationRef.current !== runId) return;
      if (analyticsAttemptRef.current) {
        reportPublishingOperationResult(analyticsAttemptRef.current, {
          result: PublishingAnalyticsResult.Failure,
          operationType: PublishingAnalyticsOperationType.UpdateContent,
          errorCategory: getPublishingErrorCategory(error),
        });
      }
      if (showPublishingQuota(error)) return;
      const message = error instanceof Error ? error.message : t('htmlShareFailed');
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? { ...previous, operation: undefined, error: message }
          : previous,
      );
    } finally {
      if (mutationBarriersRef.current.get(mutationKey) === mutationBarrier) {
        mutationBarriersRef.current.delete(mutationKey);
      }
      releaseMutationBarrier?.();
    }
  }, [dialog, refreshShare, resetFeedback, showPublishingQuota, showTimedUpdateSuccess]);

  const copyShare = useCallback(async (): Promise<void> => {
    const share = dialog?.share;
    if (
      !share ||
      dialog?.intent !== ArtifactFileShareIntent.Manage ||
      dialog.operation
    ) {
      return;
    }
    const copyResult = buildArtifactFileShareCopyText({
      accessMode: share.accessMode,
      status:
        share.status === HtmlShareStatus.Disabled ? HtmlShareStatus.Disabled : HtmlShareStatus.Live,
      url: share.url,
      shareCode: share.shareCode,
      labels: {
        link: t('htmlShareClipboardLinkLabel'),
        shareCode: t('htmlShareCode'),
      },
    });
    if (!copyResult.copyable) {
      showTimedCopyStatus(ArtifactFileShareCopyStatus.Failed);
      return;
    }
    const runId = generationRef.current;
    const copied = await copyTextToClipboard(copyResult.text);
    if (generationRef.current !== runId) return;
    showTimedCopyStatus(
      copied ? ArtifactFileShareCopyStatus.Copied : ArtifactFileShareCopyStatus.Failed,
    );
  }, [dialog, showTimedCopyStatus]);

  const selectAccessMode = useCallback((accessMode: HtmlShareAccessModeValue): void => {
    setDialog(previous =>
      previous
        && previous.phase === ArtifactFileSharePhase.Ready
        && previous.intent === ArtifactFileShareIntent.Create
        && !previous.operation
        ? { ...previous, selectedAccessMode: accessMode }
        : previous,
    );
  }, []);

  const selectExpiryPreset = useCallback((preset: ShareExpiryPresetValue): void => {
    setDialog(previous =>
      previous
        && previous.phase === ArtifactFileSharePhase.Ready
        && previous.intent === ArtifactFileShareIntent.Create
        && !previous.operation
        ? { ...previous, expiryPreset: preset }
        : previous,
    );
  }, []);

  const selectExpiryCustom = useCallback((customIso: string): void => {
    setDialog(previous =>
      previous
        && previous.phase === ArtifactFileSharePhase.Ready
        && previous.intent === ArtifactFileShareIntent.Create
        && !previous.operation
        ? { ...previous, expiryCustomIso: customIso }
        : previous,
    );
  }, []);

  /**
   * Manage-mode: switch an existing share between public and org-only by
   * calling the server's access-mode PATCH. A no-op (same value) is skipped.
   */
  const changeAccessLevel = useCallback(async (accessMode: HtmlShareAccessModeValue): Promise<void> => {
    const snapshot = dialog;
    const share = snapshot?.share;
    if (
      !snapshot ||
      snapshot.intent !== ArtifactFileShareIntent.Manage ||
      !share ||
      snapshot.operation ||
      share.accessMode === accessMode
    ) {
      return;
    }
    const api = window.electron?.htmlShare;
    if (!api) return;
    const runId = generationRef.current + 1;
    generationRef.current = runId;
    setDialog(previous =>
      previous && previous.artifact.id === snapshot.artifact.id
        ? { ...previous, operation: ArtifactFileShareOperation.Creating, error: undefined }
        : previous,
    );
    try {
      const result = await api.updateAccessMode({
        shareId: share.shareId,
        accessMode,
      });
      if (generationRef.current !== runId) return;
      if (!result?.success) {
        throw new ArtifactFileShareRequestError(result?.error || t('htmlShareFailed'));
      }
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id && previous.share
          ? {
              ...previous,
              share: { ...previous.share, accessMode },
              selectedAccessMode: accessMode,
              operation: undefined,
              error: undefined,
            }
          : previous,
      );
    } catch (error) {
      if (generationRef.current !== runId) return;
      const message = error instanceof Error ? error.message : t('htmlShareFailed');
      setDialog(previous =>
        previous && previous.artifact.id === snapshot.artifact.id
          ? { ...previous, operation: undefined, error: message }
          : previous,
      );
    }
  }, [dialog]);

  const openSubscriptionPage = useCallback(() => {
    void window.electron?.shell?.openExternal(getPortalPricingUrl());
    closeSubscriptionPrompt();
  }, [closeSubscriptionPrompt]);

  const openLoginPage = useCallback(() => {
    closeSubscriptionPrompt();
    void Promise.resolve();
  }, [closeSubscriptionPrompt]);

  const openTrialSubscriptionPage = useCallback(() => {
    void window.electron?.shell?.openExternal(getPortalPricingUrl());
    closeTrialNotice();
  }, [closeTrialNotice]);

  const contextValue = useMemo<ArtifactFileShareControllerValue>(
    () => ({
      isOverlayOpen:
        isDialogOpen ||
        Boolean(subscriptionPrompt) ||
        Boolean(publishingQuota) ||
        Boolean(trialNotice),
      openShare,
    }),
    [isDialogOpen, openShare, publishingQuota, subscriptionPrompt, trialNotice],
  );

  const share = dialog?.share;
  const dialogMessage =
    dialog?.message ??
    (share?.status === HtmlShareStatus.Failed ? t('htmlShareResultStatusFailed') : undefined);
  const canCreate = Boolean(
    dialog?.phase === ArtifactFileSharePhase.Ready &&
    dialog.intent === ArtifactFileShareIntent.Create &&
    !dialog.operation,
  );
  const canCopy = Boolean(
    dialog?.phase === ArtifactFileSharePhase.Ready &&
    dialog.intent === ArtifactFileShareIntent.Manage &&
    !dialog.operation &&
    share &&
    Boolean(share.url),
  );
  const canUpdateFile = Boolean(
    dialog?.phase === ArtifactFileSharePhase.Ready &&
    dialog.intent === ArtifactFileShareIntent.Manage &&
    !dialog.operation &&
    share &&
    share.status !== HtmlShareStatus.Disabled &&
    share.status !== HtmlShareStatus.Failed,
  );
  const canStop = Boolean(
    dialog?.phase === ArtifactFileSharePhase.Ready &&
    dialog.intent === ArtifactFileShareIntent.Manage &&
    !dialog.operation &&
    share &&
    !stopConfirm,
  );

  const dialogPortal =
    dialog && typeof document !== 'undefined'
      ? createPortal(
          <ArtifactFileShareDialog
            artifact={dialog.artifact}
            phase={dialog.phase}
            operation={dialog.operation}
            intent={dialog.intent}
            message={dialogMessage}
            error={dialog.error}
            shareUrl={share?.url}
            accessExpiresAt={share?.accessExpiresAt}
            accessMode={share?.accessMode ?? HtmlShareAccessMode.Public}
            selectedAccessMode={dialog.selectedAccessMode ?? HtmlShareAccessMode.Public}
            expiryPreset={dialog.expiryPreset ?? ShareExpiryPreset.Forever}
            expiryCustomIso={dialog.expiryCustomIso}
            canRetry={Boolean(dialog.request)}
            canCreate={canCreate}
            canCopy={canCopy}
            canUpdateFile={canUpdateFile}
            canStop={canStop}
            copyStatus={copyStatus}
            updateStatus={updateStatus}
            closeButtonRef={closeButtonRef}
            onClose={closeDialog}
            onRetry={retryShare}
            onCreate={() => void submitCreateShare()}
            onUpdateFile={() => void updateFile()}
            onCopy={() => void copyShare()}
            onStop={() => requestStop()}
            onSelectAccessMode={selectAccessMode}
            onSelectExpiryPreset={selectExpiryPreset}
            onSelectExpiryCustom={selectExpiryCustom}
            onChangeAccessLevel={(mode) => void changeAccessLevel(mode)}
          />,
          document.body,
        )
      : null;

  const stopConfirmPortal =
    stopConfirm && typeof document !== 'undefined'
      ? createPortal(
          <Modal
            isOpen
            onClose={() => setStopConfirm(false)}
            overlayClassName="fixed inset-0 z-[10001] flex items-center justify-center bg-black/40 px-4"
            className="w-full max-w-sm rounded-2xl bg-background p-5 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-500">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12.9 3.4A9 9 0 1 0 16 10h-6z" />
                  <path d="M10 7v4" />
                  <path d="M10 13.5v.5" />
                </svg>
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-foreground">
                  {t('artifactFileShareStopSharingAction')}
                </h2>
                <p className="mt-1.5 text-sm leading-5 text-secondary">
                  {t('artifactFileShareStopSharingConfirm')}
                </p>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setStopConfirm(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface transition-colors"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void confirmStop()}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 text-white hover:bg-red-500/90 transition-colors"
              >
                {t('artifactFileShareStopSharingAction')}
              </button>
            </div>
          </Modal>,
          document.body,
        )
      : null;

  const subscriptionPromptPortal = subscriptionPrompt ? (
    <ArtifactSubscriptionPromptDialog
      feature={subscriptionPrompt.feature}
      reason={subscriptionPrompt.reason}
      onCancel={closeSubscriptionPrompt}
      onLogin={openLoginPage}
      onSubscribe={openSubscriptionPage}
      onLearnBenefits={openSubscriptionPage}
      analyticsAttempt={analyticsAttemptRef.current}
    />
  ) : null;

  const publishingQuotaPortal = publishingQuota ? (
    <PublishingQuotaLimitDialog
      quota={publishingQuota}
      onClose={() => setPublishingQuota(null)}
      onSubscribe={openSubscriptionPage}
      onLearnBenefits={openSubscriptionPage}
      analyticsAttempt={analyticsAttemptRef.current}
      onManage={() => {
        setPublishingQuota(null);
        window.dispatchEvent(new Event(LibraryNavigationEvent.OpenCloud));
      }}
    />
  ) : null;

  const trialNoticePortal = trialNotice ? (
    <PublishingTrialNoticeDialog
      feature={ArtifactSubscriptionFeature.Share}
      quota={trialNotice.quota}
      onCancel={closeTrialNotice}
      onContinue={continueTrialShare}
      onSubscribe={openTrialSubscriptionPage}
      analyticsAttempt={analyticsAttemptRef.current}
    />
  ) : null;

  return (
    <ArtifactFileShareContext.Provider value={contextValue}>
      {children}
      {dialogPortal}
      {stopConfirmPortal}
      {subscriptionPromptPortal}
      {publishingQuotaPortal}
      {trialNoticePortal}
    </ArtifactFileShareContext.Provider>
  );
}

export function useOptionalArtifactFileShare(): ArtifactFileShareControllerValue | null {
  return useContext(ArtifactFileShareContext);
}
