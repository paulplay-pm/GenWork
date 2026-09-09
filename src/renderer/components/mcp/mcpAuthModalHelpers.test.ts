import { describe, expect, test } from 'vitest';

import { McpAuthMethod } from '../../../shared/mcp/constants';
import {
  buildSaveCredentialPayload,
  getAuthDotClass,
  mapProbeResultToUiState,
  type McpAuthProbeResult,
} from './mcpAuthModalHelpers';

describe('buildSaveCredentialPayload', () => {
  test('bearer maps a trimmed bearer value to { kind: "bearer", bearer }', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.Bearer, { bearer: 'tok-123' })).toEqual({
      kind: 'bearer',
      bearer: 'tok-123',
    });
  });

  test('bearer trims whitespace before validating non-empty', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.Bearer, { bearer: '  tok  ' })).toEqual({
      kind: 'bearer',
      bearer: 'tok',
    });
  });

  test('bearer returns null for an empty value', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.Bearer, { bearer: '   ' })).toBeNull();
  });

  test('api-key maps { headerName, value } to { kind: "apiKey", headerName, value }', () => {
    expect(
      buildSaveCredentialPayload(McpAuthMethod.ApiKey, {
        headerName: 'X-API-Key',
        value: 'k',
      }),
    ).toEqual({ kind: 'apiKey', headerName: 'X-API-Key', value: 'k' });
  });

  test('api-key returns null when headerName is empty', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.ApiKey, { headerName: '', value: 'k' })).toBeNull();
  });

  test('api-key returns null when value is empty', () => {
    expect(
      buildSaveCredentialPayload(McpAuthMethod.ApiKey, { headerName: 'X-API-Key', value: '  ' }),
    ).toBeNull();
  });

  test('oauth maps to qichacha by default', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.OAuth, {})).toEqual({
      kind: 'oauth',
      providerId: 'qichacha',
    });
  });

  test('oauth with a serverKey and complete oauthConfig maps to a generic provider', () => {
    const cfg = { authorizeUrl: 'https://idp/a', tokenUrl: 'https://idp/t', clientId: 'c' };
    expect(
      buildSaveCredentialPayload(McpAuthMethod.OAuth, { serverKey: 'fxsk-mcp', oauthConfig: cfg }),
    ).toEqual({ kind: 'oauth', providerId: 'generic:fxsk-mcp', oauthConfig: cfg });
  });

  test('oauth with a serverKey but no endpoints returns null (guardrail, no qichacha fallback)', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.OAuth, { serverKey: 'fxsk-mcp' })).toBeNull();
    expect(
      buildSaveCredentialPayload(McpAuthMethod.OAuth, {
        serverKey: 'fxsk-mcp',
        oauthConfig: { authorizeUrl: 'https://idp/a', tokenUrl: '', clientId: 'c' },
      }),
    ).toBeNull();
  });

  test('oauth without a serverKey still defaults to qichacha (built-in regression)', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.OAuth, { registryId: 'qichacha' as never })).toEqual({
      kind: 'oauth',
      providerId: 'qichacha',
    });
  });

  test('none returns null', () => {
    expect(buildSaveCredentialPayload(McpAuthMethod.None, {})).toBeNull();
  });
});

describe('mapProbeResultToUiState', () => {
  test('authorized returns success', () => {
    const probe: McpAuthProbeResult = {
      ok: true,
      status: 'authorized',
      latencyMs: 5,
    };
    expect(mapProbeResultToUiState(probe)).toEqual({ kind: 'success', message: 'authorized' });
  });

  test('unauthorized with HTTP 401 returns unauthorized', () => {
    const probe: McpAuthProbeResult = {
      ok: false,
      status: 'unauthorized',
      latencyMs: 5,
      error: 'HTTP 401',
    };
    expect(mapProbeResultToUiState(probe)).toEqual({ kind: 'unauthorized', message: 'HTTP 401' });
  });

  test('missing-credential returns missing-credential', () => {
    const probe: McpAuthProbeResult = {
      ok: false,
      status: 'missing-credential',
      latencyMs: 5,
      error: 'Missing credential: Authorization header',
    };
    expect(mapProbeResultToUiState(probe)).toEqual({
      kind: 'missing-credential',
      message: 'Missing credential: Authorization header',
    });
  });

  test('connect-error returns connect-error', () => {
    const probe: McpAuthProbeResult = {
      ok: false,
      status: 'connect-error',
      latencyMs: 5,
      error: 'timeout after 10000ms',
    };
    expect(mapProbeResultToUiState(probe)).toEqual({
      kind: 'connect-error',
      message: 'timeout after 10000ms',
    });
  });

  test('connect-error with HTTP 401 message is upgraded to unauthorized', () => {
    const probe: McpAuthProbeResult = {
      ok: false,
      status: 'connect-error',
      latencyMs: 5,
      error: 'HTTP 401',
    };
    expect(mapProbeResultToUiState(probe)).toEqual({ kind: 'unauthorized', message: 'HTTP 401' });
  });

  test('null probe with save error returns missing-save', () => {
    expect(mapProbeResultToUiState(null, 'save failed')).toEqual({
      kind: 'missing-save',
      message: 'save failed',
    });
  });

  test('null probe with no save error falls back to connect-error', () => {
    expect(mapProbeResultToUiState(null)).toEqual({
      kind: 'connect-error',
      message: 'probe returned no result',
    });
  });

  test('probe with no error message falls back to a sensible default', () => {
    const probe: McpAuthProbeResult = { ok: false, status: 'unauthorized', latencyMs: 1 };
    expect(mapProbeResultToUiState(probe)).toEqual({ kind: 'unauthorized', message: 'HTTP 401' });
  });
});

describe('getAuthDotClass', () => {
  test('authenticated + enabled → green', () => {
    expect(getAuthDotClass('authenticated', true)).toBe('bg-green-500');
  });

  test('authenticated + disabled → gray', () => {
    expect(getAuthDotClass('authenticated', false)).toBe('bg-gray-400');
  });

  test('auth-error → red regardless of enabled', () => {
    expect(getAuthDotClass('auth-error', true)).toBe('bg-red-500');
    expect(getAuthDotClass('auth-error', false)).toBe('bg-red-500');
  });

  test('needs-auth → orange regardless of enabled', () => {
    expect(getAuthDotClass('needs-auth', true)).toBe('bg-orange-500');
    expect(getAuthDotClass('needs-auth', false)).toBe('bg-orange-500');
  });
});
