import { describe, expect, test } from 'vitest';

import {
  authQuotaGateStateFromQuota,
  AuthSubscriptionStatus,
  createDefaultAuthQuotaGateState,
  normalizeAuthQuota,
} from './authQuota';

const labels = {
  freePlanName: 'Free',
  standardPlanName: 'Standard',
};

describe('normalizeAuthQuota', () => {
  test('preserves a free quota response without granting paid credits', () => {
    const quota = normalizeAuthQuota({
      planName: 'Free',
      subscriptionStatus: AuthSubscriptionStatus.Free,
      freeCreditsTotal: 300,
      freeCreditsUsed: 100,
      hasPaidCredits: false,
    }, labels);

    expect(quota).toEqual(expect.objectContaining({
      subscriptionStatus: AuthSubscriptionStatus.Free,
      creditsRemaining: 200,
      hasPaidCredits: false,
    }));
    expect(authQuotaGateStateFromQuota(quota)).toEqual({
      subscriptionStatus: AuthSubscriptionStatus.Free,
    });
  });

  test('treats an active subscription as paid', () => {
    const quota = normalizeAuthQuota({
      planName: 'Standard',
      subscriptionStatus: AuthSubscriptionStatus.Active,
      monthlyCreditsLimit: 5000,
      monthlyCreditsUsed: 100,
    }, labels);

    expect(quota).toEqual(expect.objectContaining({
      subscriptionStatus: AuthSubscriptionStatus.Active,
      creditsRemaining: 4900,
      hasPaidCredits: true,
    }));
    expect(authQuotaGateStateFromQuota(quota)).toEqual({
      subscriptionStatus: AuthSubscriptionStatus.Active,
    });
  });

  test('fills hasPaidCredits for already-normalized quota responses', () => {
    const quota = normalizeAuthQuota({
      planName: 'Free',
      subscriptionStatus: AuthSubscriptionStatus.Free,
      creditsLimit: 300,
      creditsUsed: 300,
      hasPaidCredits: true,
    }, labels);

    expect(quota).toEqual(expect.objectContaining({
      creditsRemaining: 0,
      hasPaidCredits: true,
    }));
  });

  test('normalizes enterprise member quota', () => {
    const quota = normalizeAuthQuota({
      planName: '团队版',
      subscriptionStatus: 'enterprise',
      creditsLimit: 8000,
      creditsUsed: 4480,
      creditsRemaining: 3520,
      hasPaidCredits: false,
    }, labels);

    expect(quota).toEqual(expect.objectContaining({
      planName: '团队版',
      subscriptionStatus: 'enterprise',
      creditsLimit: 8000,
      creditsUsed: 4480,
      creditsRemaining: 3520,
    }));
    expect(authQuotaGateStateFromQuota(quota)).toEqual({
      subscriptionStatus: 'enterprise',
    });
  });

  test('uses the Team display name when an enterprise quota omits planName', () => {
    const quota = normalizeAuthQuota({
      subscriptionStatus: 'enterprise',
      creditsLimit: 8000,
      creditsUsed: 0,
    }, labels);

    expect(quota.planName).toBe('Team');
    expect(quota.subscriptionStatus).toBe('enterprise');
  });

  test('honors explicit enterprise hasPaidCredits flag', () => {
    const quota = normalizeAuthQuota({
      planName: '团队版',
      subscriptionStatus: 'enterprise',
      creditsLimit: 8000,
      creditsUsed: 4480,
      hasPaidCredits: true,
    }, labels);

    expect(quota).toEqual(expect.objectContaining({
      subscriptionStatus: 'enterprise',
      hasPaidCredits: true,
    }));
  });

  test('uses a non-entitled free state as the default reset state', () => {
    expect(createDefaultAuthQuotaGateState()).toEqual({
      subscriptionStatus: AuthSubscriptionStatus.Free,
    });
  });
});