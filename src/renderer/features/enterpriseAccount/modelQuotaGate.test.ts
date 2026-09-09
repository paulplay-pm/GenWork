import { ProviderName } from '@shared/providers/constants';
import { describe, expect, test } from 'vitest';

import { EnterpriseQuotaReason } from '../../../shared/enterpriseAccount/constants';
import {
  resolveBlockingEnterpriseQuotaReason,
  usesGenWorkServerQuota,
} from './modelQuotaGate';

const quotaReason = EnterpriseQuotaReason.MemberMonthlyQuotaExhausted;

describe('usesGenWorkServerQuota', () => {
  test('identifies server models by flag or provider key', () => {
    expect(usesGenWorkServerQuota({
      providerKey: ProviderName.OpenAI,
      isServerModel: true,
    })).toBe(true);
    expect(usesGenWorkServerQuota({
      providerKey: ProviderName.GenworkServer,
    })).toBe(true);
  });

  test('identifies a user-configured model as independent from server quota', () => {
    expect(usesGenWorkServerQuota({
      providerKey: ProviderName.Qwen,
      isServerModel: false,
    })).toBe(false);
  });
});

describe('resolveBlockingEnterpriseQuotaReason', () => {
  test('keeps the quota gate for GenWork server models', () => {
    expect(resolveBlockingEnterpriseQuotaReason(quotaReason, {
      providerKey: ProviderName.GenworkServer,
      isServerModel: true,
    })).toBe(quotaReason);
  });

  test('bypasses the quota gate for user-configured models', () => {
    expect(resolveBlockingEnterpriseQuotaReason(quotaReason, {
      providerKey: ProviderName.Qwen,
      isServerModel: false,
    })).toBeNull();
  });

  test('fails closed while model resolution is unavailable', () => {
    expect(resolveBlockingEnterpriseQuotaReason(quotaReason, null)).toBe(quotaReason);
  });

  test('does not gate any model when enterprise quota is available', () => {
    expect(resolveBlockingEnterpriseQuotaReason(null, {
      providerKey: ProviderName.GenworkServer,
      isServerModel: true,
    })).toBeNull();
  });
});
