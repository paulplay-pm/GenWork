/**
 * Structured signals the enterprise LLM proxy writes into its JSON error
 * bodies, as seen on the desktop side.
 *
 * The desktop routes plan (genwork-server) models straight at
 * `<enterprise>/proxy/<provider>`. OpenClaw preserves the upstream error body
 * it receives into the adapter's error metadata (`rawErrorPreview` /
 * `providerErrorMessagePreview` / `httpCode`), so the desktop reads these
 * discriminants back out of that body text.
 *
 * These string values mirror the server's `ProviderProxyWireError` /
 * `ProviderProxyQuotaReason` (enterprise_server `shared/enterpriseServerConstants`).
 * They are kept as a shared constant on both sides — not bare string literals —
 * so the two stay in lock-step (CLAUDE.md String Constants rule).
 */

/** `error` discriminants on the enterprise proxy's JSON error bodies. */
export const EnterpriseProxyWireError = {
  QuotaExceeded: 'quota_exceeded',
  NotMember: 'not_member',
} as const;
export type EnterpriseProxyWireError =
  typeof EnterpriseProxyWireError[keyof typeof EnterpriseProxyWireError];

/** `reason` discriminator on the `429` quota-exceeded body. */
export const EnterpriseProxyQuotaWireReason = {
  DailyQuotaExhausted: 'daily_quota_exhausted',
} as const;
export type EnterpriseProxyQuotaWireReason =
  typeof EnterpriseProxyQuotaWireReason[keyof typeof EnterpriseProxyQuotaWireReason];

/** A parsed enterprise-proxy structured signal, if the body carried one. */
export type EnterpriseProxyWireSignal = {
  /** The wire `error` discriminator (e.g. `quota_exceeded`). */
  error: EnterpriseProxyWireError;
  /** The quota `reason`, present only on the quota signal. */
  quotaReason?: EnterpriseProxyQuotaWireReason;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parse a structured proxy signal from a raw error preview / message. The
 * OpenClaw gateway prefixes the preserved upstream body with the HTTP status
 * (e.g. `429 {"error":"quota_exceeded","reason":...}`) and may truncate it,
 * so we scan for a JSON object fragment and read the known discriminants off
 * it. Returns `null` when the text carries no recognizable signal — the caller
 * then falls back to its generic classification.
 */
export function parseEnterpriseProxyWireSignal(
  raw: string | undefined,
): EnterpriseProxyWireSignal | null {
  if (!raw) return null;
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let obj: unknown;
  try {
    // Prefer the full object; if the preview is truncated mid-object, fall
    // back to the leading `{...}` fragment up to the last closing brace.
    obj = JSON.parse(raw.slice(start));
  } catch {
    const lastBrace = raw.lastIndexOf('}');
    if (lastBrace <= start) return null;
    try {
      obj = JSON.parse(raw.slice(start, lastBrace + 1));
    } catch {
      return null;
    }
  }
  if (!isRecord(obj)) return null;

  const error = obj.error;
  if (error === EnterpriseProxyWireError.QuotaExceeded) {
    const reason = obj.reason;
    return {
      error: EnterpriseProxyWireError.QuotaExceeded,
      ...(reason === EnterpriseProxyQuotaWireReason.DailyQuotaExhausted
        ? { quotaReason: reason }
        : {}),
    };
  }
  if (error === EnterpriseProxyWireError.NotMember) {
    return { error: EnterpriseProxyWireError.NotMember };
  }
  return null;
}
