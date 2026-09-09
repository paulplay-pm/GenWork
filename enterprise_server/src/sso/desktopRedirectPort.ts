// enterprise_server/src/sso/desktopRedirectPort.ts
// Single source of truth for the desktop SSO callback port.
//
// Both the public endpoint (`GET /auth/sso/redirect-port`) and the
// desktop authorize handler (`GET /auth/sso/:id/authorize`) build the
// `redirect_uri` from the value the server resolves here. The desktop
// fetches the value from the public endpoint before starting the OAuth
// dance so the server is the only place the port is configured — change
// SSO_DESKTOP_REDIRECT_PORT in `enterprise_server/.env` (or the
// server's launch environment) and every desktop picks up the new
// value after the next login attempt.
//
// Resolved value, in order of precedence:
//   1. process.env.SSO_DESKTOP_REDIRECT_PORT (a shell export or a
//      managed `SSO_DESKTOP_REDIRECT_PORT=... npm run dev` overrides
//      the .env value loaded by tsx's --env-file).
//   2. The SSO_DESKTOP_REDIRECT_PORT_DEFAULT below.
//
// Invalid values (non-integer, out of 1..65535) are treated as unset so
// the server does not silently serve a misconfigured redirect_uri.
export const SSO_DESKTOP_REDIRECT_PORT_DEFAULT = 53231;

export interface ResolvedDesktopRedirectPort {
  /** The port number (1..65535) or null when the value is missing/invalid. */
  port: number | null;
  /** True when process.env.SSO_DESKTOP_REDIRECT_PORT was the source. */
  fromEnv: boolean;
}

export function resolveDesktopRedirectPort(env: NodeJS.ProcessEnv = process.env): ResolvedDesktopRedirectPort {
  const raw = env.SSO_DESKTOP_REDIRECT_PORT;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) {
      return { port: n, fromEnv: true };
    }
  }
  return { port: null, fromEnv: false };
}

/** Returns the effective port: process.env.SSO_DESKTOP_REDIRECT_PORT
 *  when valid, otherwise SSO_DESKTOP_REDIRECT_PORT_DEFAULT. The caller
 *  decides whether to expose the default or fall back to the port-less
 *  URL. */
export function getDesktopRedirectPort(env: NodeJS.ProcessEnv = process.env): number {
  return resolveDesktopRedirectPort(env).port ?? SSO_DESKTOP_REDIRECT_PORT_DEFAULT;
}
