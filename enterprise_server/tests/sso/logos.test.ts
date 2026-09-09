// enterprise_server/tests/sso/logos.test.ts
// Unit tests for the built-in default-logo helper. The helper maps a known
// `provider_type` (azure-ad / feishu / dingtalk / wecom) to a server-relative
// asset path under public/sso-logos/. Generic providers (generic-oidc,
// generic-oauth2) and the SAML2 placeholder return null — those connections
// must either set their own `logo_url` in the admin UI or render with no
// logo. The public `/auth/sso/providers` route resolves the relative path
// to an absolute URL using the request origin; that translation is
// exercised end-to-end by tests/routes/sso.public.test.ts.

import { describe, expect, test } from 'vitest';

import { defaultLogoFor, resolveLogoUrl, resolveProviderLogoUrl } from '../../src/sso/logos';

describe('sso/logos.defaultLogoFor', () => {
  test('azure-ad → /sso-logos/azure-ad.svg', () => {
    expect(defaultLogoFor('azure-ad')).toBe('/sso-logos/azure-ad.svg');
  });

  test('feishu → /sso-logos/feishu.png', () => {
    expect(defaultLogoFor('feishu')).toBe('/sso-logos/feishu.png');
  });

  test('dingtalk → /sso-logos/dingtalk.png', () => {
    expect(defaultLogoFor('dingtalk')).toBe('/sso-logos/dingtalk.png');
  });

  test('wecom → /sso-logos/wecom.png', () => {
    expect(defaultLogoFor('wecom')).toBe('/sso-logos/wecom.png');
  });

  test('generic-oidc → null (no built-in default)', () => {
    expect(defaultLogoFor('generic-oidc')).toBeNull();
  });

  test('generic-oauth2 → null', () => {
    expect(defaultLogoFor('generic-oauth2')).toBeNull();
  });

  test('saml2 → null', () => {
    expect(defaultLogoFor('saml2')).toBeNull();
  });

  test('unknown provider_type → null', () => {
    expect(defaultLogoFor('not-a-real-provider')).toBeNull();
  });
});

describe('sso/logos.resolveLogoUrl', () => {
  test('absolute URL passes through unchanged', () => {
    expect(resolveLogoUrl('https://cdn.example/okta.png', 'https://enterprise.example'))
      .toBe('https://cdn.example/okta.png');
  });

  test('relative path is resolved against the request origin', () => {
    expect(resolveLogoUrl('/sso-logos/feishu.png', 'https://enterprise.example'))
      .toBe('https://enterprise.example/sso-logos/feishu.png');
  });
});

describe('sso/logos.resolveProviderLogoUrl', () => {
  test('per-connection logo_url overrides the built-in default', () => {
    expect(resolveProviderLogoUrl('https://cdn.example/feishu.png', 'feishu', 'https://enterprise.example'))
      .toBe('https://cdn.example/feishu.png');
  });

  test('null logo_url with a known provider → built-in default as absolute URL', () => {
    expect(resolveProviderLogoUrl(null, 'feishu', 'https://enterprise.example'))
      .toBe('https://enterprise.example/sso-logos/feishu.png');
  });

  test('undefined logo_url with a known provider → built-in default as absolute URL', () => {
    expect(resolveProviderLogoUrl(undefined, 'azure-ad', 'https://enterprise.example'))
      .toBe('https://enterprise.example/sso-logos/azure-ad.svg');
  });

  test('null logo_url with a generic provider → null', () => {
    expect(resolveProviderLogoUrl(null, 'generic-oidc', 'https://enterprise.example')).toBeNull();
  });

  test('empty string logo_url with a known provider → built-in default (empty = "no override")', () => {
    expect(resolveProviderLogoUrl('', 'wecom', 'https://enterprise.example'))
      .toBe('https://enterprise.example/sso-logos/wecom.png');
  });
});
