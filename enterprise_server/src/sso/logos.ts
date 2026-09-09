// enterprise_server/src/sso/logos.ts
// Built-in default logos for the SSO login UI.
//
// The login pages (enterprise web + desktop) render SSO entry points as
// circular icon buttons; each button needs an image URL. Admins can pin
// a custom URL on each connection (see sso_connections.logo_url).
// When they do not, the server falls back to a built-in asset for the
// well-known provider types below. Generic providers (generic-oidc,
// generic-oauth2) and the saml2 placeholder have no brand and return
// null — those buttons render with no image.
//
// The URLs are server-relative paths under `public/sso-logos/`. The
// public `/auth/sso/providers` route converts them to absolute URLs
// using the request origin so the desktop (which talks to the
// enterprise server over HTTP) and the web (which serves from the same
// origin) can both fetch them without a separate base-url config.

import type { SsoProviderType } from './types';

const BUILTIN_LOGO: Record<string, string> = {
  'azure-ad': '/sso-logos/azure-ad.svg',
  feishu: '/sso-logos/feishu.png',
  dingtalk: '/sso-logos/dingtalk.png',
  wecom: '/sso-logos/wecom.png',
};

/** Returns the server-relative built-in logo path for a provider type,
 *  or null when the provider has no built-in logo. */
export function defaultLogoFor(providerType: string): string | null {
  return BUILTIN_LOGO[providerType] ?? null;
}

/** Build the absolute URL the desktop and web login pages will use as
 *  `<img src>`. Combines the request origin with the (server-relative)
 *  built-in path. */
export function resolveLogoUrl(logoUrlOrPath: string, requestOrigin: string): string {
  if (/^https?:\/\//i.test(logoUrlOrPath)) return logoUrlOrPath;
  return new URL(logoUrlOrPath, requestOrigin).toString();
}

/** Resolve the public-facing logo URL for a connection row, applying
 *  the per-connection `logo_url` override first and falling back to the
 *  built-in for known provider types. Returns null when neither is set
 *  (generic / saml2 / unknown). */
export function resolveProviderLogoUrl(
  logoUrl: string | null | undefined,
  providerType: string,
  requestOrigin: string,
): string | null {
  if (logoUrl && logoUrl.length > 0) return resolveLogoUrl(logoUrl, requestOrigin);
  const fallback = defaultLogoFor(providerType);
  return fallback ? resolveLogoUrl(fallback, requestOrigin) : null;
}

export type { SsoProviderType };
