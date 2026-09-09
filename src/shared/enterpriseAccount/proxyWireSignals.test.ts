import { describe, expect, test } from 'vitest';

import {
  EnterpriseProxyQuotaWireReason,
  EnterpriseProxyWireError,
  parseEnterpriseProxyWireSignal,
} from './proxyWireSignals';

describe('parseEnterpriseProxyWireSignal', () => {
  test('parses a full quota-exceeded body with the daily-quota reason', () => {
    const signal = parseEnterpriseProxyWireSignal(
      '429 {"error":"quota_exceeded","reason":"daily_quota_exhausted","used":10,"quota":10,"reset_at":"2026-09-21T00:00:00Z"}',
    );
    expect(signal).toEqual({
      error: EnterpriseProxyWireError.QuotaExceeded,
      quotaReason: EnterpriseProxyQuotaWireReason.DailyQuotaExhausted,
    });
  });

  test('parses a quota-exceeded body without a recognized reason', () => {
    const signal = parseEnterpriseProxyWireSignal(
      '{"error":"quota_exceeded","reason":"monthly","used":1,"quota":2}',
    );
    expect(signal).toEqual({ error: EnterpriseProxyWireError.QuotaExceeded });
  });

  test('parses a not_member body and ignores the http-code prefix', () => {
    const signal = parseEnterpriseProxyWireSignal('401 {"error":"not_member"}');
    expect(signal).toEqual({ error: EnterpriseProxyWireError.NotMember });
  });

  test('recovers a not_member body truncated with no closing brace', () => {
    // OpenClaw caps rawErrorPreview at ~400 chars; the closing brace may be cut
    // off. With no complete object fragment to read, the parser yields null so
    // the caller falls back to its generic classification.
    expect(
      parseEnterpriseProxyWireSignal('401 {"error":"not_m'),
    ).toBeNull();
  });

  test('parses a complete object followed by trailing non-JSON text', () => {
    // A body that is a complete JSON object but carries trailing text (which
    // makes a straight parse fail) is recovered via the slice-to-last-brace
    // fallback.
    const signal = parseEnterpriseProxyWireSignal(
      '401 {"error":"not_member"} some trailing gateway text',
    );
    expect(signal).toEqual({ error: EnterpriseProxyWireError.NotMember });
  });

  test('returns null for an unrecognized error body', () => {
    expect(parseEnterpriseProxyWireSignal('401 {"error":"unauthorized"}')).toBeNull();
  });

  test('returns null for empty or non-JSON input', () => {
    expect(parseEnterpriseProxyWireSignal(undefined)).toBeNull();
    expect(parseEnterpriseProxyWireSignal('')).toBeNull();
    expect(parseEnterpriseProxyWireSignal('LLM request failed.')).toBeNull();
  });
});
