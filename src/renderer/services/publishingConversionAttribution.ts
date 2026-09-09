import { AuthSubscriptionStatus } from '@shared/auth/constants';
import { PublishingIdentityType } from '@shared/publishing/constants';

import { configService } from './config';

export const PublishingConversionAttributionVersion = 1;

export const PublishingConversionAttributionModel = {
  LastTouch: 'last_touch',
} as const;

export const PublishingSubscriptionObservationConfidence = {
  KnownFree: 'known_free',
  UnknownBeforeLogin: 'unknown_before_login',
} as const;

const PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEY =
  'genwork_publishing_conversion_attribution_v1';
const PUBLISHING_CONVERSION_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export interface PublishingConversionAttributionInput {
  attemptId: string;
  feature: string;
  resourceKind: string;
  operationType: string;
  source: string;
  entryPoint: string;
  surface?: string;
  pageViewId?: string;
  hasExistingResource?: boolean;
  dialogType: string;
  exposureId: string;
  identityType?: string;
  countMode?: string;
  quotaUsed?: number;
  quotaLimit?: number;
  canReleaseByClosing?: boolean;
  trialAccessTtlSeconds?: number;
  ctaId: string;
  target: string;
  dialogVisibleMs: number;
}

interface StoredPublishingConversionAttribution
  extends PublishingConversionAttributionInput {
  attributionVersion: number;
  clickedAt: number;
  expiresAt: number;
}

let memoryAttribution: StoredPublishingConversionAttribution | null = null;
let pendingReport: Promise<boolean> | null = null;

const getLocalStorage = (): Storage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

const isStoredAttribution = (
  value: unknown,
): value is StoredPublishingConversionAttribution => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredPublishingConversionAttribution>;
  return candidate.attributionVersion === PublishingConversionAttributionVersion
    && typeof candidate.attemptId === 'string'
    && candidate.attemptId.length > 0
    && typeof candidate.exposureId === 'string'
    && candidate.exposureId.length > 0
    && typeof candidate.clickedAt === 'number'
    && Number.isFinite(candidate.clickedAt)
    && typeof candidate.expiresAt === 'number'
    && Number.isFinite(candidate.expiresAt);
};

const persistAttribution = (value: StoredPublishingConversionAttribution): void => {
  memoryAttribution = value;
  try {
    getLocalStorage()?.setItem(
      PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEY,
      JSON.stringify(value),
    );
  } catch {
    // In-memory attribution still covers the normal external-browser return flow.
  }
};

const readAttribution = (): StoredPublishingConversionAttribution | null => {
  try {
    const raw = getLocalStorage()?.getItem(PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isStoredAttribution(parsed)) {
        memoryAttribution = parsed;
        return parsed;
      }
      getLocalStorage()?.removeItem(PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEY);
    }
  } catch {
    // Fall back to the in-memory copy when storage is unavailable or corrupt.
  }
  return memoryAttribution;
};

export const clearPendingPublishingConversionAttribution = (): void => {
  memoryAttribution = null;
  try {
    getLocalStorage()?.removeItem(PUBLISHING_CONVERSION_ATTRIBUTION_STORAGE_KEY);
  } catch {
    // Best-effort cleanup only.
  }
};

export const rememberPublishingConversionAttribution = (
  input: PublishingConversionAttributionInput,
  now = Date.now(),
): void => {
  if (configService.getConfig().usageAnalyticsEnabled === false) {
    clearPendingPublishingConversionAttribution();
    return;
  }
  persistAttribution({
    ...input,
    attributionVersion: PublishingConversionAttributionVersion,
    clickedAt: now,
    expiresAt: now + PUBLISHING_CONVERSION_ATTRIBUTION_WINDOW_MS,
  });
};

const isPaidSubscriptionStatus = (subscriptionStatus: string | null | undefined): boolean => (
  subscriptionStatus === AuthSubscriptionStatus.Active
  || subscriptionStatus === AuthSubscriptionStatus.Enterprise
);

/**
 * Reports that the client observed a paid subscription after a publishing CTA.
 * This deliberately does not claim payment success: the authoritative order
 * conversion still belongs to the portal/order analytics pipeline.
 */
export const reportPendingPublishingSubscriptionObserved = async (
  subscriptionStatus: string | null | undefined,
  now = Date.now(),
): Promise<boolean> => {
  if (!isPaidSubscriptionStatus(subscriptionStatus)) return false;
  if (pendingReport) return pendingReport;

  const attribution = readAttribution();
  if (!attribution) return false;
  if (attribution.expiresAt <= now) {
    clearPendingPublishingConversionAttribution();
    return false;
  }
  if (configService.getConfig().usageAnalyticsEnabled === false) {
    clearPendingPublishingConversionAttribution();
    return false;
  }

  const confidence = attribution.identityType === PublishingIdentityType.Free
    ? PublishingSubscriptionObservationConfidence.KnownFree
    : PublishingSubscriptionObservationConfidence.UnknownBeforeLogin;

  // Telemetry removed; this function now no-ops. Kept as a stable export for callers.
  void confidence;
  return false;
};
