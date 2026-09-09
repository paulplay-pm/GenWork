import {
  PublishingIdentityType,
  type PublishingQuotaErrorData,
  PublishingResourceKind,
} from '@shared/publishing/constants';

import { rememberPublishingConversionAttribution } from '@/services/publishingConversionAttribution';

import {
  type ArtifactPreviewActionSource,
  type ArtifactPublishEntryPoint,
} from './artifactAnalytics';
import {
  ArtifactSubscriptionBlockReason,
  ArtifactSubscriptionFeature,
  type ArtifactSubscriptionFeature as ArtifactSubscriptionFeatureValue,
} from './artifactSubscriptionGate';

export const PublishingAnalyticsEventVersion = 1;
export const PublishingAnalyticsDialogVersion = 1;

export const PublishingAnalyticsOperationType = {
  Create: 'create',
  Manage: 'manage',
  UpdateContent: 'update_content',
  UpdatePermission: 'update_permission',
  Redeploy: 'redeploy',
  Unknown: 'unknown',
} as const;

export type PublishingAnalyticsOperationType =
  typeof PublishingAnalyticsOperationType[keyof typeof PublishingAnalyticsOperationType];

export const PublishingAnalyticsDialogType = {
  LoginRequired: 'login_required',
  TrialNotice: 'trial_notice',
  FreeQuotaExhausted: 'free_quota_exhausted',
  SubscriptionRequired: 'subscription_required',
  ActiveQuotaLimit: 'active_quota_limit',
  EnterpriseUnavailable: 'enterprise_unavailable',
} as const;

export type PublishingAnalyticsDialogType =
  typeof PublishingAnalyticsDialogType[keyof typeof PublishingAnalyticsDialogType];

export const PublishingAnalyticsActionType = {
  Click: 'click',
  Close: 'close',
} as const;

export type PublishingAnalyticsActionType =
  typeof PublishingAnalyticsActionType[keyof typeof PublishingAnalyticsActionType];

export const PublishingAnalyticsCtaId = {
  Primary: 'primary',
  Secondary: 'secondary',
  Close: 'close',
} as const;

export type PublishingAnalyticsCtaId =
  typeof PublishingAnalyticsCtaId[keyof typeof PublishingAnalyticsCtaId];

export const PublishingAnalyticsTarget = {
  Login: 'login',
  Continue: 'continue',
  Pricing: 'pricing',
  LearnBenefits: 'learn_benefits',
  ManageCloud: 'manage_cloud',
  Dismiss: 'dismiss',
} as const;

export type PublishingAnalyticsTarget =
  typeof PublishingAnalyticsTarget[keyof typeof PublishingAnalyticsTarget];

export const PublishingAnalyticsResult = {
  Success: 'success',
  Failure: 'failure',
} as const;

export type PublishingAnalyticsResult =
  typeof PublishingAnalyticsResult[keyof typeof PublishingAnalyticsResult];

export const PublishingAnalyticsErrorCategory = {
  ApiUnavailable: 'api_unavailable',
  InvalidSource: 'invalid_source',
  NetworkOrServer: 'network_or_server',
  Quota: 'quota',
  Subscription: 'subscription',
  Unknown: 'unknown',
} as const;

export type PublishingAnalyticsErrorCategory =
  typeof PublishingAnalyticsErrorCategory[keyof typeof PublishingAnalyticsErrorCategory];

export interface PublishingAnalyticsAttemptContext {
  attemptId: string;
  feature: ArtifactSubscriptionFeatureValue;
  resourceKind: typeof PublishingResourceKind.File | typeof PublishingResourceKind.Site;
  operationType: PublishingAnalyticsOperationType;
  source: ArtifactPreviewActionSource;
  entryPoint: ArtifactPublishEntryPoint;
  surface?: string;
  pageViewId?: string;
  hasExistingResource?: boolean;
}

export interface PublishingAnalyticsDialogContext {
  attempt: PublishingAnalyticsAttemptContext;
  dialogType: PublishingAnalyticsDialogType;
  exposureId: string;
  openedAt: number;
  quota?: PublishingQuotaErrorData;
  trialAccessTtlSeconds?: number;
}

const createId = (): string => (
  globalThis.crypto?.randomUUID?.()
  ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
);

export const createPublishingAnalyticsAttempt = (
  input: Omit<PublishingAnalyticsAttemptContext, 'attemptId'>,
): PublishingAnalyticsAttemptContext => ({
  ...input,
  attemptId: createId(),
});

export const updatePublishingAnalyticsAttempt = (
  attempt: PublishingAnalyticsAttemptContext,
  update: Partial<Pick<
    PublishingAnalyticsAttemptContext,
    'operationType' | 'hasExistingResource'
  >>,
): PublishingAnalyticsAttemptContext => ({ ...attempt, ...update });

export const createPublishingAnalyticsDialog = (
  attempt: PublishingAnalyticsAttemptContext,
  dialogType: PublishingAnalyticsDialogType,
  quota?: PublishingQuotaErrorData,
  trialAccessTtlSeconds?: number,
): PublishingAnalyticsDialogContext => ({
  attempt,
  dialogType,
  exposureId: createId(),
  openedAt: Date.now(),
  quota,
  trialAccessTtlSeconds,
});

export const getPublishingDialogTypeForSubscriptionReason = (
  reason: ArtifactSubscriptionBlockReason,
): PublishingAnalyticsDialogType => {
  if (reason === ArtifactSubscriptionBlockReason.LoginRequired) {
    return PublishingAnalyticsDialogType.LoginRequired;
  }
  if (reason === ArtifactSubscriptionBlockReason.EnterpriseUnavailable) {
    return PublishingAnalyticsDialogType.EnterpriseUnavailable;
  }
  return PublishingAnalyticsDialogType.SubscriptionRequired;
};

export const getPublishingDialogTypeForQuota = (
  quota: PublishingQuotaErrorData,
): PublishingAnalyticsDialogType => (
  quota.identityType === PublishingIdentityType.Free
    ? PublishingAnalyticsDialogType.FreeQuotaExhausted
    : PublishingAnalyticsDialogType.ActiveQuotaLimit
);

export const reportPublishingEntryAction = (
  _attempt: PublishingAnalyticsAttemptContext,
): void => {
};

export const reportPublishingDialogExposure = (
  _context: PublishingAnalyticsDialogContext,
): void => {
};

export interface ReportPublishingDialogActionOptions {
  actionType: PublishingAnalyticsActionType;
  ctaId: PublishingAnalyticsCtaId;
  target: PublishingAnalyticsTarget;
}

export const reportPublishingDialogAction = (
  context: PublishingAnalyticsDialogContext,
  options: ReportPublishingDialogActionOptions,
): void => {
  const dialogVisibleMs = Math.max(0, Date.now() - context.openedAt);
  if (
    options.actionType === PublishingAnalyticsActionType.Click
    && (
      options.target === PublishingAnalyticsTarget.Login
      || options.target === PublishingAnalyticsTarget.Pricing
      || options.target === PublishingAnalyticsTarget.LearnBenefits
    )
  ) {
    rememberPublishingConversionAttribution({
      attemptId: context.attempt.attemptId,
      feature: context.attempt.feature,
      resourceKind: context.attempt.resourceKind,
      operationType: context.attempt.operationType,
      source: context.attempt.source,
      entryPoint: context.attempt.entryPoint,
      surface: context.attempt.surface,
      pageViewId: context.attempt.pageViewId,
      hasExistingResource: context.attempt.hasExistingResource,
      dialogType: context.dialogType,
      exposureId: context.exposureId,
      identityType: context.quota?.identityType,
      countMode: context.quota?.countMode,
      quotaUsed: context.quota?.used,
      quotaLimit: context.quota?.limit,
      canReleaseByClosing: context.quota?.canReleaseByClosing,
      trialAccessTtlSeconds: context.trialAccessTtlSeconds,
      ctaId: options.ctaId,
      target: options.target,
      dialogVisibleMs,
    });
  }
};

export interface ReportPublishingOperationResultOptions {
  result: PublishingAnalyticsResult;
  operationType?: PublishingAnalyticsOperationType;
  errorCategory?: PublishingAnalyticsErrorCategory;
}

export const reportPublishingOperationResult = (
  _attempt: PublishingAnalyticsAttemptContext,
  _options: ReportPublishingOperationResultOptions,
): void => {
};

export const getPublishingFeatureResourceKind = (
  feature: ArtifactSubscriptionFeatureValue,
): typeof PublishingResourceKind.File | typeof PublishingResourceKind.Site => (
  feature === ArtifactSubscriptionFeature.Share
    ? PublishingResourceKind.File
    : PublishingResourceKind.Site
);

export const getPublishingErrorCategory = (error: unknown): PublishingAnalyticsErrorCategory => {
  if (!error) return PublishingAnalyticsErrorCategory.Unknown;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '').toLowerCase()
    : '';
  if (code.includes('quota') || code.includes('limit')) {
    return PublishingAnalyticsErrorCategory.Quota;
  }
  if (code.includes('subscription')) {
    return PublishingAnalyticsErrorCategory.Subscription;
  }
  return PublishingAnalyticsErrorCategory.NetworkOrServer;
};
