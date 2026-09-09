/**
 * Enterprise server base URL + derived path helpers.
 *
 * ENTERPRISE_SERVER_URL is REQUIRED at startup. The desktop no longer
 * falls back to a publisher host, and `getServerApiBaseUrl` throws
 * a clear error when the env var is unset. The `genwork-server.{inner,prod}.youdao.com`
 * fallback has been removed; the desktop routes every server call
 * through the configured enterprise server.
 */
import { HtmlSharePublicRoute } from '../../shared/htmlShare/constants';

/**
 * Read ENTERPRISE_SERVER_URL. Throws if unset. Trailing slash is trimmed.
 */
export const getEnterpriseServerUrl = (): string => {
  const raw = process.env.ENTERPRISE_SERVER_URL;
  if (!raw || !raw.trim()) {
    throw new Error(
      'ENTERPRISE_SERVER_URL is not set. Refusing to start without an enterprise server URL.'
    );
  }
  return raw.trim().replace(/\/+$/, '');
};

/**
 * Alias kept for the 30+ existing callers in main.ts. Now resolves to
 * the enterprise server (the publisher fallback has been removed).
 */
export const getServerApiBaseUrl = getEnterpriseServerUrl;

/**
 * Public html-share base URL. Appended by routes that build a public
 * link for the user. After Task 11, the html-share public pages are
 * served at `${ENTERPRISE_SERVER_URL}/api/pages/...` — but historical
 * code builds URLs against `/s/<shareId>/` for back-compat with
 * previously-published shares. Keep the alias for now.
 */
export const getHtmlSharePublicBaseUrl = (): string =>
  `${getEnterpriseServerUrl()}${HtmlSharePublicRoute.Root}`;

/**
 * Update check URL. Always hits the enterprise `/updates/latest`.
 * The api-overmind.youdao.com fallback has been removed.
 */
export const getUpdateCheckUrl = (): string => `${getEnterpriseServerUrl()}/updates/latest`;
export const getManualUpdateCheckUrl = (): string => `${getEnterpriseServerUrl()}/updates/latest`;

/**
 * `isEnterpriseUpdateMode` is now a tautology (enterprise is the only mode).
 * Kept as a no-op for the callers in appUpdateCoordinator that may still reference it.
 */
export const isEnterpriseUpdateMode = (): boolean => true;

/**
 * Fallback download URL — removed. Admins distribute via the enterprise
 * console, not via a public URL. Returns empty string so existing call
 * sites that check for falsy skip the open.
 */
export const getFallbackDownloadUrl = (): string => '';

/**
 * Skill / kit stores — removed. Returns empty string for the same
 * reason as `getFallbackDownloadUrl`.
 */
export const getSkillStoreUrl = (): string => '';
export const getKitStoreUrl = (): string => '';

/**
 * Portal URLs — removed. Returns empty string.
 */
export const getPortalTasksUrl = (): string => '';

/**
 * `refreshEndpointsTestMode` and `isTestModeEnabled` are removed.
 * Test mode no longer selects between publisher and enterprise base URLs;
 * the env var is the single source of truth.
 */