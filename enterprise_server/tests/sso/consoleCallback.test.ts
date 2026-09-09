// enterprise_server/tests/sso/consoleCallback.test.ts
import { describe, expect, test } from 'vitest';

import {
  renderConsoleCallbackHtml,
  renderWebBindCallbackHtml,
  renderWebBindErrorHtml,
} from '../../src/sso/consoleCallback';

describe('renderConsoleCallbackHtml', () => {
  test('embeds the JWT in localStorage and redirects', () => {
    const html = renderConsoleCallbackHtml({ token: 'ey.xxx.yyy', redirectTo: '/' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain("localStorage.setItem('genwork.enterprise.auth.token', 'ey.xxx.yyy')");
    expect(html).toContain("location.assign('/')");
  });

  test('escapes single quotes in token (defensive)', () => {
    const html = renderConsoleCallbackHtml({ token: "ab'cd", redirectTo: '/' });
    expect(html).not.toMatch(/setItem\('genwork[^']*', 'ab'cd'\)/);
    expect(html).toMatch(/setItem\('genwork[^']*', 'ab\\'cd'\)/);
  });

  test('HTML-escapes errorMessage so it cannot inject a tag (reflected XSS)', () => {
    const html = renderConsoleCallbackHtml({
      token: 'ey.xxx.yyy',
      redirectTo: '/',
      errorMessage: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('renderWebBindCallbackHtml', () => {
  test('writes the new JWT to localStorage, sets ssoBindJustSucceeded, and redirects to /account/sso-bindings', () => {
    const html = renderWebBindCallbackHtml({ token: 'ey.xxx.yyy', redirectTo: '/account/sso-bindings' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain("localStorage.setItem('genwork.enterprise.auth.token', 'ey.xxx.yyy')");
    expect(html).toContain("sessionStorage.setItem('ssoBindJustSucceeded', '1')");
    expect(html).toContain("location.assign('/account/sso-bindings')");
    // Must NOT redirect to the dashboard — that would drop the user on '/'
    // with no toast feedback.
    expect(html).not.toContain("location.assign('/')");
  });

  test('escapes single quotes in token (defensive)', () => {
    const html = renderWebBindCallbackHtml({ token: "ab'cd", redirectTo: '/account/sso-bindings' });
    expect(html).not.toMatch(/setItem\('genwork[^']*', 'ab'cd'\)/);
    expect(html).toMatch(/setItem\('genwork[^']*', 'ab\\'cd'\)/);
  });
});

describe('renderWebBindErrorHtml', () => {
  test('writes ssoBindError to sessionStorage and redirects to /account/sso-bindings?error=<code>', () => {
    const html = renderWebBindErrorHtml({ code: 'bind_external_id_exists' });
    expect(html).toContain("sessionStorage.setItem('ssoBindError', 'bind_external_id_exists')");
    expect(html).toContain("location.assign('/account/sso-bindings?error=bind_external_id_exists')");
  });

  test('escapes single quotes in code (defensive)', () => {
    const html = renderWebBindErrorHtml({ code: "bind_'evil" });
    // The value lands in a JS string literal — the single quote must be escaped.
    expect(html).not.toMatch(/setItem\('ssoBindError', 'bind_'evil'\)/);
    expect(html).toMatch(/setItem\('ssoBindError', 'bind_\\'evil'\)/);
    // And in the URL it must be encodeURIComponent'd so a quote can't break
    // out of the ?error= value.
    expect(html).toMatch(/location\.assign\('\/account\/sso-bindings\?error=bind_\\'evil'\)/);
  });
});
