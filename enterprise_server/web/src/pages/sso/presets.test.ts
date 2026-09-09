import { describe, expect, it } from 'vitest';

import { protocolFor } from './presets';

describe('protocolFor', () => {
  it('maps generic-oidc to oidc', () => {
    expect(protocolFor('generic-oidc')).toBe('oidc');
  });

  it('maps generic-oauth2 to oauth2', () => {
    expect(protocolFor('generic-oauth2')).toBe('oauth2');
  });

  it('maps saml2 to saml2', () => {
    expect(protocolFor('saml2')).toBe('saml2');
  });

  it('maps feishu to oidc', () => {
    expect(protocolFor('feishu')).toBe('oidc');
  });

  it('maps azure-ad to oidc', () => {
    expect(protocolFor('azure-ad')).toBe('oidc');
  });
});
