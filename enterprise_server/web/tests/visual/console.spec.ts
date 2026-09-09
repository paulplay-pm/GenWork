import { expect, type Page,test } from '@playwright/test';

/**
 * Build a JWT whose payload decodes to the supplied claims.
 *
 * The app's `useAuthStore.login()` only reads the payload (middle segment)
 * and parses it as JSON; the signature is never checked client-side, so
 * an unsigned token is sufficient for visual baselines.
 */
function buildToken(claims: { sub: string; orgId: string; roles: string[] }): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify(claims));
  return `${header}.${payload}.`;
}

/**
 * Register an init script that, on every page load, imports the Zustand
 * auth store via Vite's dev server and seeds `token` + `claims` directly.
 *
 * The store lives only in memory, so we must inject state BEFORE the SPA
 * boots — a normal `page.goto` would otherwise trigger the AuthGuard
 * redirect to `/login` before we can call `setState`.
 *
 * The init script is registered once via `addInitScript`; `useAuthStore`
 * is a module-level singleton, so re-importing the module on each
 * navigation returns the same store instance and `setState` writes
 * persist for that page lifetime.
 */
function registerAuthSeed(
  page: Page,
  claims: { sub: string; orgId: string; roles: string[] }
): void {
  const token = buildToken(claims);
  void page.addInitScript(
    ({ tok, c }) => {
      // Run after the SPA module graph loads but before the React tree
      // commits the initial render. `requestAnimationFrame` is a safe
      // point: all top-level `import` statements (including main.tsx)
      // have executed.
      const trySeed = (): void => {
        import('/src/auth/store.ts')
          .then((mod) => {
            mod.useAuthStore.setState({ token: tok, claims: c });
          })
          .catch(() => {
            // Module not yet available — retry next frame.
            requestAnimationFrame(trySeed);
          });
      };
      requestAnimationFrame(trySeed);
    },
    { tok: token, c: claims }
  );
}

test.describe('console visual baselines', () => {
  test('login page', async ({ page }) => {
    // No auth seed — we want the redirect to /login.
    await page.goto('/');
    await page.waitForURL(/\/login/);
    await expect(page.getByRole('heading', { name: /Sign in/i })).toBeVisible();
    await expect(page).toHaveScreenshot('login.png', { fullPage: true });
  });

  test('sidebar sectioned nav', async ({ page }) => {
    registerAuthSeed(page, {
      sub: 'paul-admin',
      orgId: 'default-org',
      roles: ['super_admin'],
    });
    await page.goto('/');
    await expect(page.locator('aside').first()).toBeVisible();
    await expect(page.locator('aside').first()).toHaveScreenshot('sidebar.png');
  });

  test('providers + models master-detail', async ({ page }) => {
    registerAuthSeed(page, {
      sub: 'paul-admin',
      orgId: 'default-org',
      roles: ['super_admin'],
    });
    await page.goto('/config/providers');
    await page.waitForLoadState('domcontentloaded');
    // Wait for React Query's single retry against the dev server (no
    // backend) to settle so the page header and provider rail render.
    await page.waitForTimeout(1200);
    await expect(page).toHaveScreenshot('providers-detail.png', { fullPage: true });
  });

  test('users list', async ({ page }) => {
    registerAuthSeed(page, {
      sub: 'paul-admin',
      orgId: 'default-org',
      roles: ['super_admin'],
    });
    await page.goto('/orgs/users');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1200);
    await expect(page).toHaveScreenshot('users-list.png', { fullPage: true });
  });

  test('audit list', async ({ page }) => {
    registerAuthSeed(page, {
      sub: 'paul-admin',
      orgId: 'default-org',
      roles: ['super_admin'],
    });
    await page.goto('/monitoring/audit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1200);
    await expect(page).toHaveScreenshot('audit-list.png', { fullPage: true });
  });

  test('usage page', async ({ page }) => {
    registerAuthSeed(page, {
      sub: 'paul-admin',
      orgId: 'default-org',
      roles: ['super_admin'],
    });
    await page.goto('/monitoring/usage');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1200);
    await expect(page).toHaveScreenshot('usage.png', { fullPage: true });
  });
});
