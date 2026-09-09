import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';

import { AUTH_SESSION_COOKIE_MAX_AGE_SECONDS, AuthSessionCookie } from '../shared/enterpriseServerConstants';

/**
 * Browser session cookie helpers for org-restricted share pages. The cookie
 * carries the same signed JWT the SPA keeps in localStorage, so `verifyToken`
 * re-validates it on every request. HttpOnly keeps it out of JS; SameSite=Lax
 * prevents cross-site leakage; `secure` is set when the request is HTTPS.
 */

/** Establish the browser session cookie on a response (login). */
export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, AuthSessionCookie, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: AUTH_SESSION_COOKIE_MAX_AGE_SECONDS,
    secure,
  });
}

/** Clear the browser session cookie on a response (logout). */
export function clearSessionCookie(c: Context): void {
  setCookie(c, AuthSessionCookie, '', {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 0,
  });
}

/** Read the raw JWT from the session cookie, or null if absent. */
export function readSessionCookie(c: Context): string | null {
  return getCookie(c, AuthSessionCookie) ?? null;
}
