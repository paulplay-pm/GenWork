import { createHmac } from 'node:crypto';

import { expect, type Page,test } from '@playwright/test';

/**
 * Roles visual baselines — captured against a REAL, seeded backend (the
 * isolated acceptance server). A properly HS256-signed token (sub = the seeded
 * super-admin user, real orgId) is seeded so the proxied `/admin/roles` + `/me`
 * calls authenticate and the page renders the built-in role cards. Signed with
 * `node:crypto` because web has no `jose` dependency.
 */
const JWT_SECRET =
  process.env.WEB_JWT_SECRET ??
  '74c0a5f6488345f01952c49164069108ad0a348a981c6fbdaf18f066e487cb6c';
const ORG_ID = process.env.WEB_ORG_ID ?? 'org-d3ab7deb';
const SUPER_SUB = 'e27ffa97-592b-43d7-9a00-3e7cba6a3973';

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

test.describe('roles visual baselines', () => {
  test('built-in role card grid', async ({ page }) => {
    seedAuth(page);
    await page.goto('/orgs/roles');
    await expect(page.getByRole('heading', { name: 'Roles' })).toBeVisible();
    // The default segment is "built-in"; the migration seeds these six
    // built-in roles (name = the <code> code, locale-independent).
    for (const code of ['super_admin', 'org_admin', 'dept_admin', 'auditor', 'member', 'dev']) {
      await expect(page.getByText(code, { exact: true })).toBeVisible();
    }
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('roles-grid.png', { fullPage: true });
  });

  test('new-role 3-step drawer is open', async ({ page }) => {
    seedAuth(page);
    await page.goto('/orgs/roles');
    await expect(page.getByText('super_admin', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '+ New role' }).click();
    await expect(page.getByTestId('role-drawer')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('roles-drawer.png', { fullPage: true });
  });
});
