import path from 'path';

import { APP_UPDATE_URL_UNTRUSTED_ERROR } from '../../shared/appUpdate/constants';

export const WindowsInstallerUrlPolicyFailure = {
  InvalidUrl: 'invalid-url',
  InsecureProtocol: 'insecure-protocol',
  CredentialsPresent: 'credentials-present',
  FragmentPresent: 'fragment-present',
  UnapprovedPort: 'unapproved-port',
  InvalidExtension: 'invalid-extension',
} as const;

export type WindowsInstallerUrlPolicyFailure =
  typeof WindowsInstallerUrlPolicyFailure[keyof typeof WindowsInstallerUrlPolicyFailure];

export type WindowsInstallerUrlPolicyResult =
  | { trusted: true; url: URL }
  | { trusted: false; reason: WindowsInstallerUrlPolicyFailure };

export const WINDOWS_INSTALLER_URL_POLICY_VERSION = 3 as const;

export interface WindowsInstallerUrlPolicyReceipt {
  policyVersion: typeof WINDOWS_INSTALLER_URL_POLICY_VERSION;
  /**
   * Transport provenance for a request that disallows HTTP redirects.
   * `finalOrigin` is retained for persisted-record compatibility and must equal
   * `inputOrigin`; neither value proves publisher authenticity.
   */
  inputOrigin: string;
  finalOrigin: string;
}

/**
 * Enforce the transport-level policy that is stable across CDN changes.
 * This deliberately does not authenticate the publisher or pin an origin;
 * signed release metadata and Authenticode verification are separate work.
 */
export function validateWindowsInstallerUrl(
  rawUrl: string,
  options: { trustedOrigins?: string[] } = {},
): WindowsInstallerUrlPolicyResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.InvalidUrl };
  }

  const trustedOrigins = options.trustedOrigins ?? [];
  const isTrustedPrivateOrigin = url.protocol !== 'https:'
    && isTrustedPrivateOriginMatch(url, trustedOrigins);

  if (url.protocol !== 'https:' && !isTrustedPrivateOrigin) {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.InsecureProtocol };
  }
  if (url.username || url.password) {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.CredentialsPresent };
  }
  if (url.hash) {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.FragmentPresent };
  }

  // WHATWG URL normalizes an explicit :443 to the default empty port.
  // Trusted private origins may use non-default ports.
  if (url.port && !isTrustedPrivateOrigin) {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.UnapprovedPort };
  }
  if (path.posix.extname(url.pathname).toLowerCase() !== '.exe') {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.InvalidExtension };
  }

  return { trusted: true, url };
}

function isTrustedPrivateOriginMatch(url: URL, trustedOrigins: string[]): boolean {
  if (!isPrivateHostname(url.hostname)) return false;
  for (const candidate of trustedOrigins) {
    try {
      const candidateUrl = new URL(candidate);
      if (candidateUrl.protocol !== url.protocol) continue;
      if (candidateUrl.hostname !== url.hostname) continue;
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function isPrivateHostname(host: string): boolean {
  if (host === 'localhost') return true;
  // Basic IPv4 check; non-IP hostnames return false.
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [, a, b] = m;
  const o1 = Number(a);
  const o2 = Number(b);
  if (o1 === 127) return true;
  if (o1 === 10) return true;
  if (o1 === 192 && o2 === 168) return true;
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
  return false;
}

/** Validate a canonical origin previously emitted by URL.origin. */
export function isSecureWindowsInstallerOrigin(rawOrigin: string): boolean {
  try {
    const url = new URL(rawOrigin);
    return (
      url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      && url.pathname === '/'
      && url.origin === rawOrigin
    );
  } catch {
    return false;
  }
}

export class AppUpdateUrlUntrustedError extends Error {
  readonly reason: WindowsInstallerUrlPolicyFailure;

  constructor(reason: WindowsInstallerUrlPolicyFailure) {
    super(APP_UPDATE_URL_UNTRUSTED_ERROR);
    this.name = 'AppUpdateUrlUntrustedError';
    this.reason = reason;
  }
}

export function assertTrustedWindowsInstallerUrl(
  rawUrl: string,
): URL {
  const result = validateWindowsInstallerUrl(rawUrl);
  if ('reason' in result) {
    throw new AppUpdateUrlUntrustedError(result.reason);
  }
  return result.url;
}
