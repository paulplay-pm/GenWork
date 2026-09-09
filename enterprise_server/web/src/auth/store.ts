import { create } from 'zustand';

import type { Claims } from '../api/types';

interface AuthState {
  token: string | null;
  claims: Claims | null;
  login: (token: string) => void;
  logout: () => void;
  hasCapability: (role: string) => boolean;
}

/**
 * Decode the payload of a JWT (base64url-encoded JSON) in a browser-safe way.
 *
 * Must NOT use `Buffer` — it is a Node-only global that is `undefined` in the
 * browser, so `Buffer.from(..., 'base64url')` threw a `ReferenceError` on every
 * login (masked as "Sign-in failed" by LoginPage's try/catch even though the
 * POST returned 200). `atob` + `TextDecoder` work in both the browser and the
 * jsdom test environment.
 */
function base64UrlDecode(b64url: string): string {
  // base64url -> base64 (RFC 4648 §5: swap alphabet, re-add padding)
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function decode(token: string): Claims {
  // A malformed token must not crash the login flow: the token is still valid
  // for API calls (the server re-validates it), so fall back to empty claims
  // and let the app degrade gracefully rather than refusing to sign in.
  try {
    return JSON.parse(base64UrlDecode(token.split('.')[1])) as Claims;
  } catch {
    return { sub: '', orgId: '', roles: [] };
  }
}

/** localStorage key for the session JWT. */
const TOKEN_KEY = 'genwork.enterprise.auth.token';

/**
 * True when the JWT's `exp` claim (seconds, per RFC 7519) is in the past. A
 * token with no readable `exp` is treated as non-expiring: the server
 * re-validates every request, so we never proactively drop a token we can't
 * parse — we just keep it until the server says 401.
 */
export function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(base64UrlDecode(token.split('.')[1])) as { exp?: number };
    return typeof payload.exp === 'number' && Date.now() / 1000 >= payload.exp;
  } catch {
    return false;
  }
}

/**
 * Restore the session from localStorage on a full page load (a browser refresh
 * wipes in-memory JS state, so without this the app would bounce every reload
 * back to /login). Returns an empty session if nothing is stored or the stored
 * token is expired. An expired token is also removed so it doesn't linger.
 */
export function readStoredSession(): { token: string | null; claims: Claims | null } {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(TOKEN_KEY);
  } catch {
    return { token: null, claims: null }; // localStorage unavailable
  }
  if (!stored) return { token: null, claims: null };
  if (isTokenExpired(stored)) {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    return { token: null, claims: null };
  }
  return { token: stored, claims: decode(stored) };
}

const initialSession = readStoredSession();

export const useAuthStore = create<AuthState>((set, get) => ({
  token: initialSession.token,
  claims: initialSession.claims,
  login: (token) => {
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* localStorage unavailable */ }
    set({ token, claims: decode(token) });
  },
  logout: () => {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* localStorage unavailable */ }
    set({ token: null, claims: null });
  },
  hasCapability: (role) => {
    const { claims } = get();
    if (!claims) return false;
    return claims.roles.includes('super_admin') || claims.roles.includes(role);
  },
}));
