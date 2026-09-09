// enterprise_server/src/sso/consoleCallback.ts
export interface ConsoleCallbackArgs {
  token: string;
  redirectTo: string;
  errorMessage?: string;
}

// The SPA's auth store reads from localStorage key
// 'genwork.enterprise.auth.token' (see web/src/auth/store.ts:44). Setting it
// here lets the SPA pick up the JWT on its next render. Per Ruling R3.
export function renderConsoleCallbackHtml(args: ConsoleCallbackArgs): string {
  const esc = (s: string): string => s.replace(/[\\'<>]/g, (c) => `\\${c}`);
  // `esc` is for JS string literals inside the <script> block. The error <p>
  // is HTML element content, so it needs HTML escaping instead — otherwise a
  // reflected payload (e.g. an IdP error_description) could inject a tag.
  const htmlEsc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const token = esc(args.token);
  const redirect = esc(args.redirectTo);
  const err = args.errorMessage
    ? `<p style="font-family:sans-serif;color:#b00020">${htmlEsc(args.errorMessage)}</p>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body>${err}<script>
try {
  localStorage.setItem('genwork.enterprise.auth.token', '${token}');
} catch (e) { document.body.textContent = 'Failed to store session: ' + e; }
location.assign('${redirect}');
</script></body></html>`;
}

// Post-bind callback HTML for the enterprise web. The user is already
// logged in and clicked 绑定 from /account/sso-bindings, so the flow is:
//   1. The new JWT goes into localStorage (so the SPA's auth store picks
//      it up on the next page load).
//   2. sessionStorage.ssoBindJustSucceeded='1' signals the page's
//      mount-time useEffect to dispatch the "绑定成功" toast.
//   3. Redirect to /account/sso-bindings so the page refetches and shows
//      the new bound row.
// The redirectTo is always /account/sso-bindings or its ?error= variant —
// no `redirectTo` query parameter is accepted, that would be an open
// redirect. `value` is escaped for JS-string-literal context (the only
// place it lands).
export function renderWebBindCallbackHtml(args: {
  token: string;
  redirectTo: string;
}): string {
  const esc = (s: string): string => s.replace(/[\\'<>]/g, (c) => `\\${c}`);
  const token = esc(args.token);
  const redirect = esc(args.redirectTo);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>SSO bind…</title></head>
<body><script>
try {
  localStorage.setItem('genwork.enterprise.auth.token', '${token}');
  sessionStorage.setItem('ssoBindJustSucceeded', '1');
} catch (e) { document.body.textContent = 'Failed to store session: ' + e; }
location.assign('${redirect}');
</script></body></html>`;
}

// Post-bind error HTML. Writes sessionStorage.ssoBindError so the page's
// mount-time useEffect dispatches the matching error toast, and redirects
// to /account/sso-bindings?error=<code> so a deep-link to the right toast
// also works for non-JS users. No user-controlled redirectTo — same open-
// redirect prevention as renderWebBindCallbackHtml.
export function renderWebBindErrorHtml(args: {
  code: string;
}): string {
  const esc = (s: string): string => s.replace(/[\\'<>]/g, (c) => `\\${c}`);
  const code = esc(args.code);
  const redirect = esc(`/account/sso-bindings?error=${encodeURIComponent(args.code)}`);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>SSO bind…</title></head>
<body><script>
try { sessionStorage.setItem('ssoBindError', '${code}'); } catch (e) {}
location.assign('${redirect}');
</script></body></html>`;
}
