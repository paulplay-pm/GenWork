import { afterEach, expect, test, vi } from 'vitest';

import { configService } from './config';
import {
  getEnterpriseBillingUrl,
  getEnterpriseMemberProfileUrl,
  getEnterpriseOverviewUrl,
  getEnterpriseRechargeUrl,
  getEnterpriseUsageUrl,
  getFallbackDownloadUrl,
  getKitStoreUrl,
  getLoginOvermindUrl,
  getManualUpdateCheckUrl,
  getPortalCreditsDetailUrl,
  getPortalCreditsResetActivityUrl,
  getPortalInvitationUrl,
  getPortalLoginUrl,
  getPortalPricingUrl,
  getPortalProfileUrl,
  getPortalRechargeUrl,
  getSkillStoreUrl,
  getUpdateCheckUrl,
} from './endpoints';

const mockTestMode = (testMode: boolean) => {
  vi.spyOn(configService, 'getConfig').mockReturnValue({
    app: { testMode },
  } as ReturnType<typeof configService.getConfig>);
};

afterEach(() => {
  vi.restoreAllMocks();
});

test('vendor update URLs return empty strings', () => {
  mockTestMode(false);
  expect(getUpdateCheckUrl()).toBe('');
  expect(getManualUpdateCheckUrl()).toBe('');
  expect(getFallbackDownloadUrl()).toBe('');
});

test('vendor store URLs return empty strings', () => {
  mockTestMode(false);
  expect(getSkillStoreUrl()).toBe('');
  expect(getKitStoreUrl()).toBe('');
  expect(getLoginOvermindUrl()).toBe('');
});

test('portal URLs return empty strings', () => {
  mockTestMode(false);
  expect(getPortalLoginUrl()).toBe('');
  expect(getPortalPricingUrl()).toBe('');
  expect(getPortalProfileUrl()).toBe('');
  expect(getPortalCreditsDetailUrl()).toBe('');
  expect(getPortalRechargeUrl()).toBe('');
  expect(getPortalInvitationUrl()).toBe('');
  expect(getPortalCreditsResetActivityUrl()).toBe('');
  expect(getPortalCreditsResetActivityUrl('any-campaign')).toBe('');
});

test('enterprise member URLs return empty strings (Task 4 will populate)', () => {
  mockTestMode(false);
  expect(getEnterpriseMemberProfileUrl(1001)).toBe('');
  expect(getEnterpriseOverviewUrl(1001)).toBe('');
  expect(getEnterpriseUsageUrl(1001)).toBe('');
  expect(getEnterpriseBillingUrl(1001)).toBe('');
  expect(getEnterpriseRechargeUrl(1001)).toBe('');
});

test('test mode toggle does not change vendor URL emptiness', () => {
  mockTestMode(true);
  expect(getUpdateCheckUrl()).toBe('');
  expect(getSkillStoreUrl()).toBe('');
  expect(getPortalLoginUrl()).toBe('');
});