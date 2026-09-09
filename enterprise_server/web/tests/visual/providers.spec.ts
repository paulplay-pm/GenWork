import { createHmac } from 'node:crypto';

import { expect, type Page, test } from '@playwright/test';

/**
 * Providers & models visual baselines — captured against a REAL, seeded
 * backend (the isolated acceptance server: `runMigrations` +
 * `seedBuiltinProviders` against a throwaway DB, with one custom provider + a
 * key on at least one provider so the masked hint renders). A properly
 * HS256-signed token (sub = a super-admin user, real orgId) is seeded so the
 * proxied `/admin/provider-keys` + `/admin/models` + `/me` calls authenticate
 * and the page renders the seeded data. Signed with `node:crypto` because web
 * has no `jose` dependency (mirrors `users.spec.ts`).
 *
 * NOTE: baselines ARE captured — against a real, isolated, seeded throwaway
 * backend (a Docker `postgres:16` container with `runMigrations` +
 * `seedBuiltinProviders`, plus the real `enterprise_server` on spare ports;
 * the dev `gwork` DB was never touched). The screenshots are gitignored and
 * local-only (web/.gitignore ignores tests/visual/screenshots/) — NOT
 * committed. Regenerate them with `npm run test:visual:update` (or directly):
 *   WEB_PORT=<spare> WEB_PROXY_TARGET=<backend> WEB_ORG_ID=<org> \
 *   WEB_JWT_SECRET=<secret> npx playwright test tests/visual/providers.spec.ts --update-snapshots
 * from `enterprise_server/web/`.
 */
const JWT_SECRET =
  process.env.WEB_JWT_SECRET ??
  '74c0a5f6488345f01952c49164069108ad0a348a981c6fbdaf18f066e487cb6c';
const ORG_ID = process.env.WEB_ORG_ID ?? 'org-model-provider';
const SUPER_SUB = 'u-acceptance-super-admin';

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

async function gotoProviders(page: Page): Promise<void> {
  seedAuth(page);
  await page.goto('/config/providers');
  // Wait for the rail to render (providers + models fetched). The two group
  // headings are the reliable "loaded" markers.
  await expect(page.getByRole('heading', { name: /Built-in/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Custom/i })).toBeVisible();
}

test.describe('providers & models visual baselines', () => {
  test('provider rail: builtins + custom, grouped', async ({ page }) => {
    await gotoProviders(page);
    // A couple of the seeded built-ins (by slug) are visible in the rail.
    await expect(page.getByText('openai', { exact: true })).toBeVisible();
    await expect(page.getByText('anthropic', { exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('providers-list.png', { fullPage: true });
  });

  test('provider detail: header + 连接信息 (protocol radio, masked key)', async ({ page }) => {
    await gotoProviders(page);
    // Select the `anthropic` built-in (protocol=anthropic → the Anthropic radio
    // is checked). A seeded key on the provider makes the masked hint render.
    await page.getByText('anthropic', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Test connection' })).toBeVisible();
    // Two "Save" buttons exist (header + info card); the header's is first.
    await expect(page.getByRole('button', { name: 'Save' }).first()).toBeVisible();
    // The 连接信息 card (en: "Provider info") with the API-protocol radio group.
    await expect(page.getByRole('heading', { name: 'Provider info' })).toBeVisible();
    await expect(page.getByText('API Protocol', { exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('provider-detail.png', { fullPage: true });
  });

  test('model drawer: 8 type cards + context + sampling', async ({ page }) => {
    await gotoProviders(page);
    // Enter detail mode (a provider must be selected for the model list / the
    // "Add model" action to render).
    await page.getByText('openai', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add model' })).toBeVisible();
    await page.getByRole('button', { name: 'Add model' }).click();
    // The drawer opens as a fixed overlay. Scope assertions to it — the model
    // table also renders a "Context window" column header, so an unscoped
    // getByText would hit both (strict-mode violation).
    const drawer = page.locator('div.fixed.inset-0.z-50');
    await expect(drawer.getByRole('heading', { name: 'Add model' })).toBeVisible();
    await expect(drawer.getByText('Basic info', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Types', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Context window', { exact: true })).toBeVisible();
    // Sampling params (temperature / top P).
    await expect(drawer.getByText('Temperature', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Top P', { exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('model-drawer.png', { fullPage: true });
  });
});
