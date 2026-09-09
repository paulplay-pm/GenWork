/**
 * Enterprise LLM error signal store.
 *
 * Holds a short-lived record of the most recent structured error observed on
 * the enterprise (plan) LLM path — a quota-exhaustion signal (code + message)
 * and/or a membership-revocation signal. Part A removed the local token proxy
 * that previously scanned the consumer stream and populated this; this module
 * is the seam that keeps the runtime adapter compiling against a stable
 * consume/remember API. Part D wires it to the enterprise server's structured
 * signals (the `reason` field on the `429` quota response and the distinct
 * `not_member` auth failure), and to the `LlmSse` membership-revocation source.
 */
import { EnterpriseApiErrorCode } from '../../shared/enterpriseAccount/constants';

export type EnterpriseQuotaErrorSignal = {
  message: string;
  code?: string | number;
  capturedAt: number;
};

export type EnterpriseMembershipRevokedSignal = {
  code: number;
  capturedAt: number;
};

// The OpenClaw runtime surfaces provider errors a moment after the enterprise
// server emits them; only the most recent signal is relevant to the error the
// user is now seeing, so a single-slot store with a consume-on-read semantic
// matches how the adapter reads it.
let recentQuotaError: EnterpriseQuotaErrorSignal | null = null;
let recentMembershipRevoked: EnterpriseMembershipRevokedSignal | null = null;

export function rememberEnterpriseQuotaError(
  error: { message: string; code?: string | number },
  now = Date.now(),
): void {
  recentQuotaError = { ...error, capturedAt: now };
}

export function consumeRecentEnterpriseQuotaError(): EnterpriseQuotaErrorSignal | null {
  const error = recentQuotaError;
  recentQuotaError = null;
  return error;
}

export function rememberEnterpriseMembershipRevoked(now = Date.now()): void {
  recentMembershipRevoked = { code: EnterpriseApiErrorCode.NotMember, capturedAt: now };
}

export function consumeRecentEnterpriseMembershipRevoked(): EnterpriseMembershipRevokedSignal | null {
  const event = recentMembershipRevoked;
  recentMembershipRevoked = null;
  return event;
}
