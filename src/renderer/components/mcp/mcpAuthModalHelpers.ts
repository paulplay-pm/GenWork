// Pure helpers extracted from the McpAuthModal flow so the dispatch / mapping
// logic can be unit-tested without a DOM.
//
// This module is pure TS: no React, no DOM, no imports from the renderer store
// or services. It only depends on the shared McpAuthMethod constants and on
// the ProbeResult shape, which mirrors the shape returned by the main-process
// saveCredential / probeAuthorization IPC handlers (see
// `src/main/mcp/mcpAuthProbe.ts`).

import { McpAuthMethod } from '../../../shared/mcp/constants';

export interface SaveCredentialPayloadBearer {
  kind: 'bearer';
  bearer: string;
}

export interface SaveCredentialPayloadApiKey {
  kind: 'apiKey';
  headerName: string;
  value: string;
}

export interface SaveCredentialPayloadOAuth {
  kind: 'oauth';
  providerId: string;
  oauthConfig?: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes?: string[];
  };
}

/**
 * The discriminated union of payloads the modal can submit. Kept in sync with
 * `SaveCredentialPayload` from `src/main/mcp/mcpAuthFlows.ts`. We do not import
 * that type directly because renderer files reach across process boundaries via
 * TypeScript, and the brief prefers keeping these helpers free of main-process
 * imports.
 */
export type McpAuthSaveCredentialPayload =
  | SaveCredentialPayloadBearer
  | SaveCredentialPayloadApiKey
  | SaveCredentialPayloadOAuth;

/**
 * Form-side field values collected from the auth modal. Each auth method only
 * reads the fields it cares about; the rest are ignored.
 */
export interface McpAuthFormFields {
  bearer?: string;
  headerName?: string;
  value?: string;
  /** Registry id of the connector being authorized (informational; ignored). */
  registryId?: string;
  serverKey?: string;
  oauthConfig?: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes?: string[];
  };
}

/**
 * Map the auth modal's `(authMethod, formFields)` to the payload the main
 * process expects, or `null` when the user shouldn't submit (authMethod 'none'
 * or a partially filled oauth form).
 */
export function buildSaveCredentialPayload(
  authMethod: McpAuthMethod,
  formFields: McpAuthFormFields,
): McpAuthSaveCredentialPayload | null {
  if (authMethod === McpAuthMethod.None) {
    return null;
  }
  if (authMethod === McpAuthMethod.Bearer) {
    const bearer = (formFields.bearer ?? '').trim();
    if (!bearer) return null;
    return { kind: 'bearer', bearer };
  }
  if (authMethod === McpAuthMethod.ApiKey) {
    const headerName = (formFields.headerName ?? '').trim();
    const value = formFields.value ?? '';
    if (!headerName || !value.trim()) return null;
    return { kind: 'apiKey', headerName, value };
  }
  if (authMethod === McpAuthMethod.OAuth) {
    const cfg = formFields.oauthConfig;
    const hasEndpoints = Boolean(cfg?.authorizeUrl?.trim()) && Boolean(cfg?.tokenUrl?.trim());
    // Enterprise connector (identified by its serverKey): must have admin
    // endpoints; never silently drive qichacha.
    if (formFields.serverKey) {
      if (!hasEndpoints) return null; // guardrail — see spec §5.4
      return { kind: 'oauth', providerId: `generic:${formFields.serverKey}`, oauthConfig: cfg };
    }
    // Built-in Qichacha bundle (no serverKey): keep the qichacha path.
    return { kind: 'oauth', providerId: 'qichacha' };
  }
  return null;
}

/**
 * Mirrors `ProbeResult` from `src/main/mcp/mcpAuthProbe.ts`.
 *
 * Kept structurally compatible (and loosely typed so the renderer can fall
 * through to a generic `connect-error` when the main process returns something
 * unexpected).
 */
export interface McpAuthProbeResult {
  ok: boolean;
  status: 'authorized' | 'unauthorized' | 'connect-error' | 'missing-credential';
  latencyMs: number;
  serverInfo?: { name: string; version?: string };
  error?: string;
}

/**
 * The discriminated union the modal renders as the result pill.
 * - `success` — green pill, modal auto-closes after a brief delay.
 * - `unauthorized` — red pill ("check your token"), keep modal open with Retry.
 * - `connect-error` — red pill ("connection failed"), keep modal open with Retry.
 * - `missing-credential` — red pill ("missing field"), keep modal open with Retry.
 * - `missing-save` — red pill ("save failed before probe"), keep modal open with Retry.
 */
export type McpAuthUiState =
  | { kind: 'success'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'connect-error'; message: string }
  | { kind: 'missing-credential'; message: string }
  | { kind: 'missing-save'; message: string };

const UNAUTHORIZED_PREFIXES = ['HTTP 401', 'HTTP 403'] as const;
const MISSING_CREDENTIAL_PREFIXES = [
  'Missing credential',
  'OAuth token missing',
  'Missing URL',
  'Missing command',
] as const;

function startsWithAny(text: string, prefixes: ReadonlyArray<string>): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}

/**
 * Decide which UI pill the modal should show.
 *
 * Priority order:
 * 1. `saveError` set → `missing-save` (the probe never ran).
 * 2. probe.status `unauthorized` → `unauthorized`.
 * 3. probe.status `missing-credential` → `missing-credential`.
 * 4. probe.status `connect-error` (or probe.ok === false) → `connect-error`.
 * 5. probe.status `authorized` (or probe.ok === true) → `success`.
 * 6. fall-through → `connect-error`.
 */
export function mapProbeResultToUiState(
  probeResult: McpAuthProbeResult | null | undefined,
  saveError?: string | null,
): McpAuthUiState {
  if (saveError) {
    return { kind: 'missing-save', message: saveError };
  }
  if (!probeResult) {
    return { kind: 'connect-error', message: 'probe returned no result' };
  }
  if (probeResult.status === 'authorized') {
    return { kind: 'success', message: 'authorized' };
  }
  if (probeResult.status === 'unauthorized') {
    return { kind: 'unauthorized', message: probeResult.error ?? 'HTTP 401' };
  }
  if (probeResult.status === 'missing-credential') {
    return { kind: 'missing-credential', message: probeResult.error ?? 'missing credential' };
  }
  // `connect-error` or any unexpected shape falls here.
  const error = probeResult.error ?? 'connect-error';
  if (startsWithAny(error, UNAUTHORIZED_PREFIXES)) {
    return { kind: 'unauthorized', message: error };
  }
  if (startsWithAny(error, MISSING_CREDENTIAL_PREFIXES)) {
    return { kind: 'missing-credential', message: error };
  }
  return { kind: 'connect-error', message: error };
}

/**
 * Compute the Tailwind color class for the auth-status dot on a card. Pure
 * helper so the McpManager renderer doesn't need to inline this branch tree.
 *
 * Returns `null` when no dot should be rendered (e.g. unauthenticated and not
 * enabled, which is the rest state and already reads "off").
 */
export function getAuthDotClass(
  authStatus: 'authenticated' | 'needs-auth' | 'auth-error',
  enabled: boolean,
): string | null {
  if (authStatus === 'authenticated') {
    return enabled ? 'bg-green-500' : 'bg-gray-400';
  }
  if (authStatus === 'auth-error') {
    return 'bg-red-500';
  }
  // needs-auth
  return 'bg-orange-500';
}
