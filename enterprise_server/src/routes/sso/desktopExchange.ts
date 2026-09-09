// enterprise_server/src/routes/sso/desktopExchange.ts
// Public endpoint the desktop loopback calls after the IdP redirects the
// browser back to the loopback with `?code=…&state=…`. The loopback has
// no way to do the PKCE code exchange itself — it only owns an HTTP
// request handler and a polling probe. The server is the single source
// of truth for client_id / scopes / client_secret / consumeState. This
// route wires the desktop's code into finishSsoCallback's existing
// logic, which already covers JIT, strict-mode, the pendingBind branch,
// the ready_to_finalize finalize, and self_binding.
//
// Wire shapes:
//   200 { token }                     -> success
//   400 { error }                     -> finishSsoCallback failure (or
//                                        state_invalid / invalid_request)
//   409 { status: 'pending_bind',     -> strict-mode unbound; loopback
//            bindUrl, connectionName,    surfaces "go bind in browser"
//            providerType, externalId }  HTML page and the probe rejects.
//
// Why this route is public (no requireAuth): the desktop has no JWT yet.
// Removing the desktop-side token from the browser-visible redirect_uri
// keeps the secret out of the address bar / browser history.
//
// consumeState is one-shot (DELETE … RETURNING). A second POST with the
// same state returns state_invalid: that is the existing security model
// and matches the rest of the SSO flow.
import { Hono } from 'hono';
import { z } from 'zod';

import { finishSsoCallback } from '../../sso/finishCallback';
import { consumeState } from '../../sso/state';

export const ssoDesktopExchangeRoutes = new Hono();

const bodySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

ssoDesktopExchangeRoutes.post('/auth/sso/desktop/exchange', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const { code, state } = parsed.data;

  // One-shot consume. null means the state row already went away
  // (expired or replayed); surface it as state_invalid so the loopback
  // can 302 with `?error=state_invalid` and the desktop UI can render
  // a clear message instead of crashing on undefined.
  const consumed = await consumeState(state);
  if (!consumed) return c.json({ error: 'state_invalid' }, 400);

  const result = await finishSsoCallback({
    code,
    state: consumed,
    redirectUri: consumed.redirectUri ?? 'http://localhost/callback',
  });

  if ('pendingBind' in result) {
    // HTTP 409: "request understood, action required" — distinct from a
    // 200 token success and a 400 bad-input. The desktop loopback
    // renders a friendly "go bind in your browser" page and does NOT
    // settle waitForArrival(), so openOauthFlow's probe rejects and
    // startSsoMemberLogin throws `sso_login_failed`.
    return c.json({
      status: 'pending_bind',
      bindUrl: `/bind-sso?state=${encodeURIComponent(state)}`,
      connectionName: result.pendingBind.connectionName,
      providerType: result.pendingBind.providerType,
      externalId: result.pendingBind.externalId,
    }, 409);
  }
  if ('error' in result) return c.json({ error: result.error }, 400);
  return c.json({ token: result.token });
});
