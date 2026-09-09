// web/src/pages/auth/BindSsoPage.tsx
// Thin React shell for the public, server-rendered `/bind-sso` form. The
// backend (src/routes/auth/ssoBind.ts) renders the actual form HTML; the
// embedded JS in that HTML calls `POST /auth/sso/bind` with the user's
// password and, on success, navigates the top-level window to `returnTo`
// (which lands on `/auth/sso/callback?state=…` and finalizes the binding).
//
// This page exists so that a profile-menu "Bind SSO" flow can navigate the
// SPA to `/bind-sso?state=…` (e.g. when re-binding the same connection from
// the profile menu after a server-side bounce) without leaving the console
// UX. In the typical "first-time bind after OAuth" path the user is bounced
// to `/bind-sso` by the backend's strict-mode gate (`finishCallback.ts`) and
// this route is never entered — the browser hits the server-rendered HTML
// directly because `/bind-sso` is mounted on the backend before the SPA
// wildcard fallback (src/server.ts).

import type { JSX } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Mounts an iframe pointing at the server-rendered `/bind-sso?state=…` HTML.
 * The iframe submits the form in-place; its embedded JS does
 * `location.assign(returnTo)` on success which navigates the **top-level**
 * browser window away from the SPA to finalize the binding via
 * `/auth/sso/callback`. No client-side React state lives here on purpose —
 * anything the SPA draws inside would be re-replaced by the iframe's
 * navigation, and adding it would only race the redirect.
 */
export function BindSsoPage(): JSX.Element {
  const [params] = useSearchParams();
  const state = params.get('state') ?? '';
  const src = `/bind-sso?state=${encodeURIComponent(state)}`;
  return (
    <iframe
      src={src}
      title="Bind SSO account"
      style={{ border: 0, width: '100%', height: '100vh', display: 'block' }}
    />
  );
}