import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'node:net';
import type { BrowserWindow } from 'electron';

import { openOauthFlow } from './oauthBrowserFlow';

export interface GenericOauthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
}

export function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(64));
  return {
    verifier,
    // RFC 7636 §4.2: the IdP computes BASE64URL(SHA256(code_verifier)) over the
    // verifier STRING it receives — so hash the base64url string, not the raw bytes.
    challenge: base64UrlEncode(crypto.createHash('sha256').update(verifier).digest()),
    state: base64UrlEncode(crypto.randomBytes(32)),
  };
}

export function buildGenericAuthorizeUrl(args: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  state: string;
  challenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    code_challenge: args.challenge,
    code_challenge_method: 'S256',
  });
  if (args.scopes && args.scopes.length > 0) params.set('scope', args.scopes.join(' '));
  const base = args.authorizeUrl.includes('?')
    ? `${args.authorizeUrl}&${params.toString()}`
    : `${args.authorizeUrl}?${params.toString()}`;
  return base;
}

export function buildTokenExchangeBody(args: {
  code: string;
  codeVerifier: string;
  clientId: string;
}): string {
  // Public client (PKCE): token_endpoint_auth_method=none — no client secret.
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
  });
  return params.toString();
}

export function parseTokenResponse(text: string): string {
  let data: { access_token?: string; error?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('oauth token exchange: non-JSON response');
  }
  if (data.error) throw new Error(`oauth token exchange failed: ${data.error}`);
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('oauth token exchange: missing access_token');
  }
  return data.access_token;
}

/** One-shot localhost callback server that captures the authorization `code`
 * (validating `state`) exactly once. Returns `{ redirectUri, wait, close }` —
 * `wait` resolves to the captured code (or null if the window closes first). */
function startCodeCallback(expectedState: string): Promise<{
  redirectUri: string;
  wait: () => Promise<string | null>;
  close: () => void;
}> {
  let resolveCode: ((c: string | null) => void) | null = null;
  const codePromise = new Promise<string | null>((r) => {
    resolveCode = r;
  });
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url || '/', 'http://localhost');
      if (parsed.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const state = parsed.searchParams.get('state');
      const code = parsed.searchParams.get('code');
      if (state !== expectedState || !code) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Invalid callback');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Authorization complete</h1><p>You can return to GenWork.</p>');
      resolveCode?.(code); // resolve-once; later polls get the same settlement
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to allocate OAuth callback port'));
        return;
      }
      resolve({
        redirectUri: `http://localhost:${(addr as AddressInfo).port}/callback`,
        wait: () => codePromise,
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore close races */
          }
        },
      });
    });
  });
}

/** Drive the full generic authorization-code + PKCE flow for one connector's
 * own endpoints and return the access token. The pure pieces above are unit
 * tested; this orchestration uses Electron + `openOauthFlow`. */
export async function runGenericOauthFlow(
  oauthConfig: GenericOauthConfig,
  parentWindow: BrowserWindow | null,
): Promise<string> {
  const { verifier, challenge, state } = createPkce();
  const cb = await startCodeCallback(state);
  let exchangeError: Error | null = null;
  try {
    const authorizeUrl = buildGenericAuthorizeUrl({
      authorizeUrl: oauthConfig.authorizeUrl,
      clientId: oauthConfig.clientId,
      redirectUri: cb.redirectUri,
      scopes: oauthConfig.scopes,
      state,
      challenge,
    });
    try {
      const token = await openOauthFlow({
        parentWindow,
        title: 'MCP OAuth Authorization',
        authorizeUrl,
        probe: async (win) => {
          const code = await cb.wait();
          if (!code) return null;
          try {
            const res = await fetch(oauthConfig.tokenUrl, {
              method: 'POST',
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'application/json',
              },
              body: buildTokenExchangeBody({ code, codeVerifier: verifier, clientId: oauthConfig.clientId }),
            });
            const text = await res.text();
            if (!res.ok) {
              const err = new Error(`oauth token exchange failed: HTTP ${res.status}`);
              exchangeError = err;
              try {
                win.close();
              } catch {
                /* window may already be gone */
              }
              throw err;
            }
            return parseTokenResponse(text);
          } catch (e) {
            exchangeError = e instanceof Error ? e : new Error(String(e));
            try {
              win.close();
            } catch {
              /* window may already be gone */
            }
            throw e;
          }
        },
      });
      if (!token) throw new Error('oauth flow returned empty credential');
      return token;
    } catch (e) {
      // openOauthFlow swallows probe throws and settles via the window-close
      // handler with a generic message — re-surface the specific exchange error
      // (HTTP status / IdP error) when it is the actual cause.
      if (exchangeError) throw exchangeError;
      throw e;
    }
  } finally {
    cb.close();
  }
}
