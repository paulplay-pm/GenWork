// enterprise_server/src/sso/oauth.ts
import { TextEncoder } from 'node:util';

import { type JWTPayload,jwtVerify } from 'jose';

import type { SsoConnectionRow } from './types';

export function buildAuthorizeUrl(
  c: SsoConnectionRow,
  state: string,
  codeChallenge?: string,
  redirectUri?: string,
): string {
  const u = new URL(c.authorize_url!);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', c.client_id ?? '');
  u.searchParams.set('redirect_uri', redirectUri ?? 'http://localhost/callback');
  u.searchParams.set('state', state);
  if (c.scopes) u.searchParams.set('scope', c.scopes);
  if (codeChallenge) {
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

export interface ExchangeResult {
  accessToken: string;
  idToken?: string;
  raw: Record<string, unknown>;
}

export async function exchangeCode(
  c: SsoConnectionRow,
  code: string,
  codeVerifier?: string,
  clientSecretDecrypted?: string,
  redirectUri?: string,
): Promise<ExchangeResult> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri ?? 'http://localhost/callback');
  if (c.client_id) body.set('client_id', c.client_id);
  if (codeVerifier) body.set('code_verifier', codeVerifier);

  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (clientSecretDecrypted) {
    headers.authorization = 'Basic ' + Buffer.from(`${c.client_id}:${clientSecretDecrypted}`).toString('base64');
  }

  const r = await fetch(c.token_url!, { method: 'POST', headers, body });
  if (!r.ok) throw new Error(`token_exchange_failed:${r.status}`);
  const json = (await r.json()) as Record<string, unknown>;
  const accessToken = String(json.access_token ?? '');
  if (!accessToken) throw new Error('token_exchange_no_access_token');
  return { accessToken, idToken: typeof json.id_token === 'string' ? json.id_token : undefined, raw: json };
}

export async function fetchUserInfo(
  c: SsoConnectionRow,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const r = await fetch(c.userinfo_url!, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`userinfo_failed:${r.status}`);
  const body = (await r.json()) as Record<string, unknown>;
  // Feishu v2 userinfo wraps the user fields inside a `data`
  // envelope (with `code`/`msg` siblings), not the flat OIDC shape
  // every other IdP returns. Unwrap for Feishu so the caller's
  // `identity[identity_id_field]` lookup lands on the same key
  // the admin set (e.g. `open_id`, `union_id`). The `code === 0`
  // check is what Feishu uses to mean "success" — a non-zero code
  // surfaces as userinfo_failed so the audit trail records it.
  if (c.provider_type === 'feishu') {
    if (body.code !== 0) throw new Error(`userinfo_feishu_code:${body.code ?? 'unknown'}:${body.msg ?? ''}`);
    return (body.data ?? {}) as Record<string, unknown>;
  }
  return body;
}

// Verifies an OIDC ID token. v1 supports HS256 with the IdP-shared `client_secret`
// (rotate to JWKS/RS256 when an IdP requires it). The connection's
// `client_secret_encrypted` is the source for symmetric verification; pass the
// already-decrypted secret as `clientSecretDecrypted`.
export async function verifyIdToken(
  c: SsoConnectionRow,
  idToken: string,
  clientSecretDecrypted?: string,
): Promise<JWTPayload> {
  if (!clientSecretDecrypted) throw new Error('id_token_requires_client_secret_or_jwks');
  const secret = new TextEncoder().encode(clientSecretDecrypted);
  const { payload } = await jwtVerify(idToken, secret, { algorithms: ['HS256'] });
  return payload;
}
