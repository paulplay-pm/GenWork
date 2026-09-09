// enterprise_server/tests/routes/sso.bindPage.test.ts
// Verifies the redesigned /bind-sso server-rendered HTML page:
//   - default locale is zh (matches the rest of the product's primary
//     audience and the prototype design); ?lang=en switches to English
//   - both locales render the same layout structure (title chip, provider
//     card with badge, expandable external-id row, two icon-prefixed
//     inputs, primary submit button)
//   - the invalid-state branch also renders the styled layout (so a user
//     who lands on a stale bind-sso link sees a coherent page, not a
//     one-line error)
//   - Accept-Language header is honored when ?lang= is absent
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { Hono } from 'hono';

import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { ssoBindRoutes } from '../../src/routes/auth/ssoBind';
import { ssoLoginContextStore } from '../../src/sso/ssoLoginContext';

function buildApp(): Hono {
  const a = new Hono();
  a.route('/', ssoBindRoutes);
  return a;
}

function ctxReady(state = 'st-pb', externalId = 'on_4e7a5e50254f6196544fed7d9f97ff87'): void {
  ssoLoginContextStore.set(state, {
    kind: 'pending_bind', orgId: 'o1', connectionId: 'c1',
    externalId, email: null, loginName: null,
    returnTarget: 'console',
    redirectUri: 'http://x', codeVerifier: 'v',
    expiresAt: new Date(Date.now() + 60_000),
  });
}

describe('GET /bind-sso redesigned page', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
    await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1','T')`);
    await testPool.query(
      `INSERT INTO sso_connections(id, org_id, name, provider_type, protocol, email_domain_whitelist)
       VALUES ('c1','o1','Feishu','feishu','oidc','[]'::jsonb)`
    );
    ssoLoginContextStore.delete('st-pb');
  });

  test('zh locale (default): renders 绑定 GenWork 账号 title, 待绑定 badge, and both input placeholders', async () => {
    ctxReady();
    const res = await buildApp().request('/bind-sso?state=st-pb');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<html lang="zh">/);
    // Title and the new headline (Big H1 in the prototype).
    expect(html).toMatch(/绑定 GenWork 账号/);
    // The 待绑定 badge in the provider card.
    expect(html).toMatch(/待绑定/);
    // Provider card name uses the connection's actual name (here "Feishu")
    // interpolated into "{provider}账号", so we check the template suffix.
    expect(html).toMatch(/Feishu账号/);
    expect(html).toMatch(/尚未关联 GenWork 身份/);
    // Subtitle and submit. The connection is named "Feishu" (English) in
    // the fixture, so the provider is interpolated verbatim into the
    // template "{provider}账号尚未绑定 GenWork".
    expect(html).toMatch(/Feishu账号尚未绑定 GenWork/);
    expect(html).toMatch(/绑定并登录/);
    // View-account-id expandable row.
    expect(html).toMatch(/查看账号标识/);
    expect(html).toMatch(/复制/);
    // The external_id from the JWT-style format.
    expect(html).toMatch(/on_4e7a5e50254f6196544fed7d9f97ff87/);
    // Inputs (placeholders carry the labels now).
    expect(html).toMatch(/name="username"/);
    expect(html).toMatch(/name="password"/);
    expect(html).toMatch(/name="state"/);
    // Layout markers.
    expect(html).toMatch(/<h1 class="title">/);
    expect(html).toMatch(/class="provider-card"/);
    expect(html).toMatch(/class="submit-btn"/);
  });

  test('en locale (?lang=en): renders English title and badge', async () => {
    ctxReady();
    const res = await buildApp().request('/bind-sso?state=st-pb&lang=en');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/Bind GenWork account/);
    expect(html).toMatch(/Pending bind/);
    expect(html).toMatch(/Feishu account/);
    expect(html).toMatch(/Not linked to a GenWork identity/);
    expect(html).toMatch(/Bind and sign in/);
    expect(html).toMatch(/View account ID/);
    expect(html).toMatch(/Copy/);
  });

  test('Accept-Language: zh-CN without ?lang= renders Chinese', async () => {
    ctxReady();
    const res = await buildApp().request('/bind-sso?state=st-pb', {
      headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<html lang="zh">/);
  });

  test('Accept-Language: en-US without ?lang= renders English', async () => {
    ctxReady();
    const res = await buildApp().request('/bind-sso?state=st-pb', {
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<html lang="en">/);
  });

  test('?lang= overrides Accept-Language', async () => {
    ctxReady();
    const res = await buildApp().request('/bind-sso?state=st-pb&lang=zh', {
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<html lang="zh">/);
  });

  test('invalid state: also renders the styled layout (not a one-liner)', async () => {
    const res = await buildApp().request('/bind-sso?state=missing&lang=en');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/Session expired/);
    expect(html).toMatch(/class="title"/);
    expect(html).toMatch(/class="card"/);
    // No form (the user has nothing to do on this page).
    expect(html).not.toMatch(/<form/);
  });

  test('XSS: hostile external_id is entity-escaped (regression for the IdP-derived value)', async () => {
    ssoLoginContextStore.set('st-xss', {
      kind: 'pending_bind', orgId: 'o1', connectionId: 'c1',
      externalId: '<img src=x onerror=alert(1)>', email: null, loginName: null,
      returnTarget: 'console',
      redirectUri: 'http://x', codeVerifier: 'v',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await buildApp().request('/bind-sso?state=st-xss&lang=en');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toMatch(/<img src=x onerror/);
    expect(html).toMatch(/&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});
