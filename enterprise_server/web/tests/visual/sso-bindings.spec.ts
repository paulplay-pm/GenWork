import { createHmac } from 'node:crypto';

import { expect, type Page, test } from '@playwright/test';

/**
 * SSO account-binding visual baselines (/account/sso-bindings). All four
 * states are captured against a `page.route()`-mocked API surface so the
 * rendering is deterministic and CI-friendly without a seeded backend:
 *
 *   GET /auth/orgs                  -> { orgs: [{ id: 'o1', name: 'Acme' }] }
 *   GET /me/sso-binding/connections -> per-test fixture (or 500 for error)
 *   GET /me                         -> defensive profile payload
 *   GET /sso-logos/*                -> 404 (the page renders the avatar
 *                                       placeholder when logos are absent)
 *
 * The auth store is seeded with an HS256-shaped JWT carrying `orgId: 'o1'` so
 * `orgName` resolves to 'Acme' and the bind buttons are enabled. The JWT
 * signature is never verified here (the mocks short-circuit the network).
 */
const JWT_SECRET =
  process.env.WEB_JWT_SECRET ??
  '74c0a5f6488345f01952c49164069108ad0a348a981c6fbdaf18f066e487cb6c';
const ORG_ID = 'o1';
const ORG_NAME = 'Acme';
const SUPER_SUB = 'e27ffa97-592b-43d7-9a00-3e7cba6a3973';

interface MockedConnection {
  id: string;
  name: string;
  providerType: string;
  sortOrder: number;
  enabled: boolean;
  logoUrl: string | null;
  bound: boolean;
  externalId: string | null;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signToken(claims: Record<string, unknown>): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', JWT_SECRET).update(data).digest());
  return `${data}.${sig}`;
}

function seedAuth(page: Page): void {
  const token = signToken({
    orgId: ORG_ID,
    roles: ['super_admin'],
    sub: SUPER_SUB,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  void page.addInitScript(
    ({ tok, c }) => {
      const trySeed = (): void => {
        import('/src/auth/store.ts')
          .then((mod) => {
            mod.useAuthStore.setState({ token: tok, claims: c });
          })
          .catch(() => {
            requestAnimationFrame(trySeed);
          });
      };
      requestAnimationFrame(trySeed);
    },
    { tok: token, c: { sub: SUPER_SUB, orgId: ORG_ID, roles: ['super_admin'] } }
  );
}

function installMocks(
  page: Page,
  connections: () => { status: number; body: unknown }
): void {
  void page.route('**/auth/orgs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ orgs: [{ id: ORG_ID, name: ORG_NAME }] }),
    });
  });

  void page.route('**/me/sso-binding/connections', async (route) => {
    const res = connections();
    await route.fulfill({
      status: res.status,
      contentType: 'application/json',
      body: JSON.stringify(res.body),
    });
  });

  void page.route('**/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username: 'alice',
        display_name: 'Alice',
        permissions: [],
        effectiveDataScope: 'all',
      }),
    });
  });

  // Logos are absent in the fixtures; the page's avatar fallback renders the
  // first character of the connection name. Force a 404 so the network layer
  // is consistent (rather than racing the dev proxy).
  void page.route('**/sso-logos/**', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });
}

const POPULATED: MockedConnection[] = [
  {
    id: 'c-feishu',
    name: '飞书',
    providerType: 'feishu',
    sortOrder: 10,
    enabled: true,
    logoUrl: null,
    bound: true,
    externalId: 'kk@example.com',
  },
  {
    id: 'c-dingtalk',
    name: '钉钉',
    providerType: 'dingtalk',
    sortOrder: 20,
    enabled: true,
    logoUrl: null,
    bound: false,
    externalId: null,
  },
  {
    id: 'c-wecom',
    name: '企业微信',
    providerType: 'wecom',
    sortOrder: 30,
    enabled: true,
    logoUrl: null,
    bound: false,
    externalId: null,
  },
  {
    id: 'c-azure-ad',
    name: 'Azure AD',
    providerType: 'azure-ad',
    sortOrder: 40,
    enabled: true,
    logoUrl: null,
    bound: false,
    externalId: null,
  },
  {
    id: 'c-generic-oidc',
    name: '通用 OIDC',
    providerType: 'generic-oidc',
    sortOrder: 50,
    enabled: true,
    logoUrl: null,
    bound: false,
    externalId: null,
  },
  {
    id: 'c-generic-oauth2',
    name: '通用 OAuth 2.0',
    providerType: 'generic-oauth2',
    sortOrder: 60,
    enabled: true,
    logoUrl: null,
    bound: false,
    externalId: null,
  },
  {
    id: 'c-saml2',
    name: 'SAML 2.0',
    providerType: 'saml2',
    sortOrder: 70,
    enabled: true,
    logoUrl: null,
    bound: false,
    externalId: null,
  },
];

test.describe('sso-bindings visual baselines', () => {
  test('sso-bindings-empty', async ({ page }) => {
    seedAuth(page);
    installMocks(page, () => ({ status: 200, body: { connections: [] } }));
    await page.goto('/account/sso-bindings');
    await expect(page.getByText('No SSO connections configured', { exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('sso-bindings-empty.png', { fullPage: true });
  });

  test('sso-bindings-populated', async ({ page }) => {
    seedAuth(page);
    installMocks(page, () => ({ status: 200, body: { connections: POPULATED } }));
    await page.goto('/account/sso-bindings');
    await expect(page.getByText('飞书', { exact: true })).toBeVisible();
    await expect(page.getByText('钉钉', { exact: true })).toBeVisible();
    await expect(page.getByText('企业微信', { exact: true })).toBeVisible();
    await expect(page.getByText('Azure AD', { exact: true })).toBeVisible();
    await expect(page.getByText('通用 OIDC', { exact: true })).toBeVisible();
    await expect(page.getByText('通用 OAuth 2.0', { exact: true })).toBeVisible();
    await expect(page.getByText('SAML 2.0', { exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('sso-bindings-populated.png', { fullPage: true });
  });

  test('sso-bindings-bound-tab', async ({ page }) => {
    seedAuth(page);
    installMocks(page, () => ({ status: 200, body: { connections: POPULATED } }));
    await page.goto('/account/sso-bindings');
    await expect(page.getByText('飞书', { exact: true })).toBeVisible();
    // Click the "Bound" tab (the page renders tabs as role="tab" buttons).
    await page.getByRole('tab', { name: /Bound/ }).click();
    await expect(page.getByText('飞书', { exact: true })).toBeVisible();
    // Unbound rows must NOT be visible.
    await expect(page.getByText('钉钉', { exact: true })).toHaveCount(0);
    await expect(page.getByText('企业微信', { exact: true })).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('sso-bindings-bound-tab.png', { fullPage: true });
  });

  test('sso-bindings-error', async ({ page }) => {
    seedAuth(page);
    installMocks(page, () => ({ status: 500, body: { error: 'internal' } }));
    await page.goto('/account/sso-bindings');
    await expect(page.getByText('Failed to load', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('sso-bindings-error.png', { fullPage: true });
  });
});
