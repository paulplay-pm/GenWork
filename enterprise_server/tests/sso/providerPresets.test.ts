// enterprise_server/tests/sso/providerPresets.test.ts
import { describe, expect, test } from 'vitest';
import { PRESETS } from '../../src/sso/providerPresets';

describe('providerPresets', () => {
  test('every preset exposes the six standard keys', () => {
    for (const [type, p] of Object.entries(PRESETS)) {
      expect(typeof p.authorizeUrl, `${type}.authorizeUrl`).toBe('string');
      expect(typeof p.tokenUrl, `${type}.tokenUrl`).toBe('string');
      expect(typeof p.userinfoUrl, `${type}.userinfoUrl`).toBe('string');
      expect(typeof p.scopes, `${type}.scopes`).toBe('string');
      expect(typeof p.identityIdField, `${type}.identityIdField`).toBe('string');
      expect(typeof p.emailField, `${type}.emailField`).toBe('string');
    }
  });

  test('generic-oidc defaults to sub / preferred_username / email', () => {
    expect(PRESETS['generic-oidc'].identityIdField).toBe('sub');
    expect(PRESETS['generic-oidc'].loginNameField).toBe('preferred_username');
    expect(PRESETS['generic-oidc'].emailField).toBe('email');
  });
});
