import { createHmac } from 'node:crypto';

import { expect, type Page,test } from '@playwright/test';

/**
 * Departments visual baselines — captured against a REAL, seeded backend (the
 * isolated acceptance server), not an empty one. The existing `console.spec.ts`
 * seeds an unsigned `alg:'none'` token with a fake org and runs with no
 * backend, so those pages render their empty/error state. Here we sign a real
 * HS256 JWT whose `sub` is the seeded super-admin user and whose `orgId` is the
 * real org, so the proxied `/admin/*` + `/me` calls authenticate and the pages
 * render actual data.
 *
 * The token is signed in the Node test process with `node:crypto` (web has no
 * `jose` dependency). The server verifies HS256 with `JWT_SECRET`, so the
 * secret is read from the env the visual run is started with (defaulting to the
 * acceptance server's value).
 */
const JWT_SECRET =
  process.env.WEB_JWT_SECRET ??
  '74c0a5f6488345f01952c49164069108ad0a348a981c6fbdaf18f066e487cb6c';
const ORG_ID = process.env.WEB_ORG_ID ?? 'org-d3ab7deb';
// `e27ffa97…` is the super-admin user created by the org's setup flow; its
// /me returns the full 41-point permission set, so every mutating affordance
// (and the create drawer) is enabled for the baseline.
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

/** Seed the auth store with a real token before the SPA commits its render. */
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

test.describe('departments visual baselines', () => {
  test('department tree renders the seeded 5-level structure', async ({ page }) => {
    seedAuth(page);
    await page.goto('/orgs/departments');
    await expect(page.getByRole('heading', { name: 'Departments' })).toBeVisible();
    // The seeded tree is Engineering > Platform > Backend > Backend-Core >
    // Storage (5 levels) plus a Sales sibling. The tree is fully expanded by
    // default, so all five names are visible once data loads.
    for (const name of ['Engineering', 'Platform', 'Backend', 'Backend-Core', 'Storage', 'Sales']) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    // Select the root so the right-hand detail panel is populated too.
    await page.getByText('Engineering', { exact: true }).click();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('departments-tree.png', { fullPage: true });
  });

  test('create-department drawer is open', async ({ page }) => {
    seedAuth(page);
    await page.goto('/orgs/departments');
    await expect(page.getByText('Engineering', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '+ Add department' }).click();
    await expect(page.getByText('New department')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('departments-drawer.png', { fullPage: true });
  });
});
