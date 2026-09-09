import { describe, expect, test } from 'vitest';

import { McpAuthMethod } from '../../../shared/mcp/constants';
import { mapEnterpriseAuthModeToMcpAuthMethod } from './enterpriseAuthMode';

describe('mapEnterpriseAuthModeToMcpAuthMethod', () => {
  test('none → None (direct connect)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('none')).toBe(McpAuthMethod.None);
  });
  test('user-key → ApiKey (user fills their own key)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('user-key')).toBe(McpAuthMethod.ApiKey);
  });
  test('user-oauth → OAuth (existing browser flow)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('user-oauth')).toBe(McpAuthMethod.OAuth);
  });
  test('shared-key → Bearer placeholder (org-credential, parked in needs-auth)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('shared-key')).toBe(McpAuthMethod.Bearer);
  });
  test('client-creds → Bearer placeholder', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('client-creds')).toBe(McpAuthMethod.Bearer);
  });
  test('sso → OAuth (user-credential direct-link, reuses the generic OAuth driver)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('sso')).toBe(McpAuthMethod.OAuth);
  });
  test('unknown value falls back to None (safe default, matches prior behavior)', () => {
    expect(mapEnterpriseAuthModeToMcpAuthMethod('nonsense' as never)).toBe(McpAuthMethod.None);
  });
});
