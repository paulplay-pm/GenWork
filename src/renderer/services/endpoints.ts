/**
 * 集中管理所有业务 API 端点。
 *
 * Vendor-hosted URLs (previously pointing at *.youdao.com) have been removed.
 * The desktop no longer auto-opens external update / store / portal URLs —
 * those flows are now console-driven. Functions return empty strings so
 * existing call sites that check for falsy before calling `shell.openExternal`
 * skip the open. Console-relative URLs are added in Task 4.
 */
import { configService } from './config';

export const isTestModeEnabled = (): boolean => configService.getConfig().app?.testMode === true;

// Auto-update — removed. The desktop no longer checks for updates against a
// vendor-hosted endpoint; the console drives update flow.
export const getUpdateCheckUrl = (): string => '';
export const getManualUpdateCheckUrl = (): string => '';

// Fallback download URL — removed.
export const getFallbackDownloadUrl = (): string => '';

// Skill / kit stores — removed. Admins install via the console.
export const getSkillStoreUrl = (): string => '';
export const getKitStoreUrl = (): string => '';

// Login URL provider — removed. The desktop uses its own in-app login form
// (src/renderer/login/LoginPage.tsx) which posts to /auth/login on the
// configured enterprise console.
export const getLoginOvermindUrl = (): string => '';

// Portal URLs — removed. All previously routed to genwork.youdao.com.
// Return '' so existing `shell.openExternal(url || fallback)` call sites
// gracefully skip the open.
export const getPortalLoginUrl = (): string => '';
export const getPortalPricingUrl = (): string => '';
export const getPortalProfileUrl = (): string => '';
export const getPortalCreditsDetailUrl = (): string => '';
export const getPortalRechargeUrl = (): string => '';
export const getPortalInvitationUrl = (): string => '';
export const getPortalCreditsResetActivityUrl = (_campaignCode?: string): string => '';

// Enterprise member / console URLs — placeholder return ''.
// Task 4 replaces these with local-console-relative URLs.
export const getEnterpriseMemberProfileUrl = (_enterpriseId: number): string => '';
export const getEnterpriseOverviewUrl = (_enterpriseId: number): string => '';
export const getEnterpriseUsageUrl = (_enterpriseId: number): string => '';
export const getEnterpriseBillingUrl = (_enterpriseId: number): string => '';
export const getEnterpriseRechargeUrl = (_enterpriseId: number): string => '';

// Re-export the PortalPricingKeyfrom enum for backwards compatibility with
// existing imports in ArtifactPanel.tsx and ArtifactFileShareController.tsx.
// The enum itself is preserved (it's a string discriminator, not a URL).
export const PortalPricingKeyfrom = {
  HtmlShare: 'html_share',
  SiteDeployment: 'site_deployment',
} as const;

export type PortalPricingKeyfrom = (typeof PortalPricingKeyfrom)[keyof typeof PortalPricingKeyfrom];

export interface PortalPricingUrlOptions {
  traceId?: string;
}