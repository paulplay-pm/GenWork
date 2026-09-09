import { createHmac } from 'node:crypto';

import { expect, type Page,test } from '@playwright/test';

/**
 * Users visual baselines — captured against a REAL, seeded backend (the
 * isolated acceptance server). A properly HS256-signed token (sub = the seeded
 * super-admin user, real orgId) is seeded so the proxied `/admin/users` + `/me`
 * calls authenticate and the page renders the seeded users. Signed with
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

test.describe('users visual baselines', () => {
  test('user table lists the seeded users', async ({ page }) => {
    seedAuth(page);
    await page.goto('/orgs/users');
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    // The seeded users (super-admin is org_wide, so it sees all four).
    for (const username of ['alice', 'bob', 'carol', 'dave']) {
      await expect(page.getByText(username, { exact: true })).toBeVisible();
    }
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('users-list.png', { fullPage: true });
  });

  test('selecting a row shows the batch bar; create drawer opens', async ({ page }) => {
    seedAuth(page);
    await page.goto('/orgs/users');
    await expect(page.getByText('alice', { exact: true })).toBeVisible();
    // Row checkboxes are labeled with the username.
    await page.getByRole('checkbox', { name: 'alice' }).check();
    await expect(page.getByText('1 selected')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('users-batch-bar.png', { fullPage: true });

    // The create drawer (user:edit-gated, enabled for super-admin).
    await page.getByRole('button', { name: '+ New user' }).click();
    await expect(page.getByTestId('user-drawer')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('users-drawer.png', { fullPage: true });
  });
});
