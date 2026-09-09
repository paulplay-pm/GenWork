import '../helpers/setupEnv';

import { describe, expect, test } from 'vitest';

import {
  type ConnectorRow,
  mapAdminConnector,
  mapPublicConnector,
  scopeMatches,
  scopeSummary,
} from '../../src/models/connectorView';
import { encrypt } from '../../src/vault/crypto';

describe('scopeMatches', () => {
  test('allCompany grants everyone', () => {
    expect(scopeMatches({ allCompany: true, deptIds: [], userIds: [] }, [], 'u1')).toBe(true);
  });
  test('member exception grants the user', () => {
    expect(scopeMatches({ allCompany: false, deptIds: [], userIds: ['u1'] }, [], 'u1')).toBe(true);
  });
  test('a granted dept grants its member', () => {
    expect(
      scopeMatches({ allCompany: false, deptIds: ['rd'], userIds: [] }, ['rd', 'fe'], 'u1'),
    ).toBe(true);
  });
  test('unmatched member is denied', () => {
    expect(scopeMatches({ allCompany: false, deptIds: ['sales'], userIds: [] }, ['rd'], 'u1')).toBe(
      false,
    );
  });
});

describe('scopeSummary', () => {
  test('allCompany -> all', () => {
    expect(scopeSummary({ allCompany: true, deptIds: [], userIds: [] })).toBe('all');
  });
  test('empty scope -> none', () => {
    expect(scopeSummary({ allCompany: false, deptIds: [], userIds: [] })).toBe('none');
  });
  test('depts only and depts+users', () => {
    expect(scopeSummary({ allCompany: false, deptIds: ['a', 'b'], userIds: [] })).toBe('depts:2');
    expect(scopeSummary({ allCompany: false, deptIds: ['a'], userIds: ['u1', 'u2'] })).toBe(
      'depts:1,users:2',
    );
  });
});

const makeRow = (over: Partial<ConnectorRow> = {}): ConnectorRow => ({
  id: 'c1',
  org_id: 'o1',
  server_key: 'crm-api',
  name_en: 'CRM API',
  name_zh: '客户关系',
  version: '1.0.0',
  category_id: null,
  description: null,
  connector_type: 'mcp',
  url: 'https://crm.example.com/mcp',
  transport: 'http',
  auth_mode: 'shared-key',
  auth_config: {},
  secret_meta: null,
  auth_status: 'configured',
  enabled: true,
  scope: { allCompany: false, deptIds: ['sales'], userIds: ['u9'] },
  tools: [
    { name: 'query', enabled: true },
    { name: 'legacy-tool', enabled: false, removed: true },
  ],
  draft: null,
  last_test_at: null,
  last_test_status: null,
  last_latency_ms: null,
  created_by: null,
  created_at: new Date('2026-09-01T10:00:00Z'),
  updated_at: new Date('2026-09-15T12:30:00Z'),
  ...over,
});

describe('mapPublicConnector', () => {
  test('exposes no authConfig, no secretMeta, no ciphertext', () => {
    const cipher = encrypt('sk-supersecret1234');
    const row = makeRow({ auth_config: { __enc__apiKey: cipher, region: 'cn' } });
    const v = mapPublicConnector(row);
    expect(v).not.toHaveProperty('authConfig');
    expect(v).not.toHaveProperty('secretMeta');
    expect(JSON.stringify(v)).not.toContain(cipher);
    expect(JSON.stringify(v)).not.toContain('sk-supersecret1234');
  });
  test('never leaks ssoClientSecret into the public view', () => {
    const v = mapPublicConnector(makeRow({
      auth_mode: 'sso',
      auth_config: {
        ssoAuthorizeUrl: 'https://a',
        ssoTokenUrl: 'https://t',
        ssoClientId: 'c',
        ssoClientSecret: 'top-secret-sso',
      },
    }));
    expect(JSON.stringify(v)).not.toContain('top-secret-sso');
  });
  test('name prefers zh, then en, then server_key', () => {
    expect(mapPublicConnector(makeRow()).name).toBe('客户关系');
    expect(mapPublicConnector(makeRow({ name_zh: null })).name).toBe('CRM API');
    expect(mapPublicConnector(makeRow({ name_zh: null, name_en: null })).name).toBe('crm-api');
  });
  test('nullable row fields fall back to empty string; toolCount skips removed', () => {
    const v = mapPublicConnector(makeRow());
    expect(v.description).toBe('');
    expect(v.category).toBe('');
    expect(v.toolCount).toBe(1);
    expect(v.hasDraft).toBe(false);
    expect(v.scopeSummary).toBe('depts:1,users:1');
  });
});

describe('mapPublicConnector.oauth (user-oauth whitelist)', () => {
  const base = {
    auth_mode: 'user-oauth' as const,
    auth_config: {
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
      clientId: 'public-client-123',
      scopes: ['openid', 'profile'],
      clientSecret: 'shoud-not-leak-plaintext',
      __enc__clientSecret: 'ENC_CIPHERTEXT_DO_NOT_LEAK',
    },
  };
  test('fills oauth from the whitelist when endpoints are complete', () => {
    const v = mapPublicConnector(makeRow(base));
    expect(v.oauth).toEqual({
      authorizeUrl: 'https://idp.example.com/oauth/authorize',
      tokenUrl: 'https://idp.example.com/oauth/token',
      clientId: 'public-client-123',
      scopes: ['openid', 'profile'],
    });
  });
  test('never leaks clientSecret or __enc__* into the public view', () => {
    const v = mapPublicConnector(makeRow(base));
    expect(v).not.toHaveProperty('clientSecret');
    expect(JSON.stringify(v)).not.toContain('shoud-not-leak-plaintext');
    expect(JSON.stringify(v)).not.toContain('ENC_CIPHERTEXT_DO_NOT_LEAK');
    expect(JSON.stringify(v)).not.toContain('__enc__');
  });
  test('oauth is undefined when an endpoint is missing', () => {
    expect(mapPublicConnector(makeRow({ ...base, auth_config: { clientId: 'c' } })).oauth).toBeUndefined();
    expect(
      mapPublicConnector(makeRow({ ...base, auth_config: { clientId: 'c', authorizeUrl: 'https://a', tokenUrl: '' } })).oauth,
    ).toBeUndefined();
  });
  test('oauth is undefined for non-user-oauth modes even with endpoints set', () => {
    const v = mapPublicConnector(makeRow({ ...base, auth_mode: 'client-creds' }));
    expect(v.oauth).toBeUndefined();
  });
  test('fills oauth for sso from the sso-* field whitelist when endpoints are complete', () => {
    const v = mapPublicConnector(makeRow({
      auth_mode: 'sso',
      auth_config: {
        ssoApp: 'feishu',
        ssoAuthorizeUrl: 'https://idp.example.com/sso/authorize',
        ssoTokenUrl: 'https://idp.example.com/sso/token',
        ssoClientId: 'sso-public-client',
        ssoScopes: ['openid', 'profile'],
        ssoClientSecret: 'shoud-not-leak-plaintext',
      },
    }));
    expect(v.oauth).toEqual({
      authorizeUrl: 'https://idp.example.com/sso/authorize',
      tokenUrl: 'https://idp.example.com/sso/token',
      clientId: 'sso-public-client',
      scopes: ['openid', 'profile'],
    });
    // ssoApp / ssoClientSecret never cross to the desktop.
    expect(JSON.stringify(v)).not.toContain('sso-public-client-secret');
    expect(v).not.toHaveProperty('ssoApp');
  });
  test('sso oauth is undefined when an sso endpoint is missing', () => {
    expect(
      mapPublicConnector(makeRow({
        auth_mode: 'sso',
        auth_config: { ssoApp: 'feishu', ssoAuthorizeUrl: 'https://a', ssoTokenUrl: '', ssoClientId: 'c' },
      })).oauth,
    ).toBeUndefined();
  });
  test('user-key exposes apiKeyHeaderName when set, omits it when unset', () => {
    const withName = mapPublicConnector(makeRow({ auth_mode: 'user-key', auth_config: { apiKeyHeaderName: 'X-My-Key' } }));
    expect(withName.apiKeyHeaderName).toBe('X-My-Key');
    const without = mapPublicConnector(makeRow({ auth_mode: 'user-key', auth_config: {} }));
    expect(without.apiKeyHeaderName).toBeUndefined();
  });
});

describe('mapAdminConnector', () => {
  test('masks the stored secret and strips the ciphertext key', () => {
    const row = makeRow({
      auth_config: { __enc__apiKey: encrypt('sk-supersecret1234'), region: 'cn' },
      secret_meta: { lastUpdatedAt: '2026-09-10T00:00:00.000Z', lastUpdatedBy: 'admin@o1' },
    });
    const v = mapAdminConnector(row);
    expect(v.authConfig.apiKey).toBe('••••1234');
    expect(v.authConfig).not.toHaveProperty('__enc__apiKey');
    expect(v.authConfig.region).toBe('cn');
    expect(JSON.stringify(v)).not.toContain('sk-supersecret1234');
    expect(v.secretMeta).toEqual({
      lastUpdatedAt: '2026-09-10T00:00:00.000Z',
      lastUpdatedBy: 'admin@o1',
    });
  });
  test('no stored secret passes authConfig through unchanged', () => {
    const v = mapAdminConnector(makeRow({ auth_config: { region: 'cn' } }));
    expect(v.authConfig).toEqual({ region: 'cn' });
  });
  test('ISO-strings dates, nulls stay null, toolCount skips removed, hasDraft', () => {
    const v = mapAdminConnector(makeRow());
    expect(v.createdAt).toBe('2026-09-01T10:00:00.000Z');
    expect(v.updatedAt).toBe('2026-09-15T12:30:00.000Z');
    expect(v.lastTestAt).toBeNull();
    expect(v.lastTestStatus).toBeNull();
    expect(v.lastLatencyMs).toBeNull();
    expect(v.toolCount).toBe(1);
    expect(v.hasDraft).toBe(false);
    expect(mapAdminConnector(makeRow({ draft: { url: 'x' } })).hasDraft).toBe(true);
    expect(v.scopeSummary).toBe('depts:1,users:1');
    expect(v.serverKey).toBe('crm-api');
  });
});
