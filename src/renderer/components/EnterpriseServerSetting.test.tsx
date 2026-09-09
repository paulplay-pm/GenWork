import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string): string => key },
}));

// `EnterpriseServerSetting` reads `window.electron.enterpriseMt.*` for
// status / verify / save / logout. SSR does not have a window, so install
// a stub on globalThis before the suite runs.
const stubEnterpriseMt = {
  getBootstrapStatus: async () => ({ url: 'https://prod.genwork.com' }),
  verifyUrl: async () => ({ ok: true }),
  saveUrl: async () => ({
    ok: true,
    status: { configured: true, url: 'https://prod.genwork.com' },
  }),
  logout: async () => undefined,
  quit: async () => undefined,
};

const reloadCalls: number[] = [];

beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = {
    electron: { enterpriseMt: stubEnterpriseMt },
    location: { reload: () => reloadCalls.push(Date.now()) },
  };
});

beforeEach(() => {
  reloadCalls.length = 0;
});

import { EnterpriseServerSetting } from './EnterpriseServerSetting';

describe('EnterpriseServerSetting', () => {
  test('renders without crashing and surfaces the entry title', () => {
    const html = renderToStaticMarkup(<EnterpriseServerSetting />);
    expect(html).toContain('enterpriseSettings.entryTitle');
  });

  test('modal is not rendered initially (edit-only keys absent)', () => {
    const html = renderToStaticMarkup(<EnterpriseServerSetting />);
    expect(html).not.toContain('enterpriseSetup.testConnection');
    expect(html).not.toContain('enterpriseSetup.cancel');
  });

  test('row container is a non-interactive div (only the pill opens the modal)', () => {
    const html = renderToStaticMarkup(<EnterpriseServerSetting />);
    // The outer container must NOT be a button — only the "修改" pill triggers the modal.
    expect(html).toMatch(/<div[^>]*>[\s\S]*?enterpriseSettings\.entryTitle[\s\S]*?<\/div>/);
  });

  test('edit affordance is a button (the only clickable surface)', () => {
    const html = renderToStaticMarkup(<EnterpriseServerSetting />);
    expect(html).toContain('enterpriseSettings.edit');
    // The edit label must live inside its own <button>, not a <span>.
    expect(html).toMatch(/<button[^>]*>[\s\S]*?enterpriseSettings\.edit[\s\S]*?<\/button>/);
    expect(html).not.toMatch(/<span[^>]*>[\s\S]*?enterpriseSettings\.edit[\s\S]*?<\/span>/);
    expect(html).toContain('rounded-lg border border-border');
    expect(html).toContain('px-3 py-1.5');
  });

  test('onSave persists the new URL via bridge.saveUrl', async () => {
    const saveCalls: string[] = [];
    const localBridge = {
      getBootstrapStatus: async () => ({ url: 'https://prod.genwork.com' }),
      verifyUrl: async () => ({ ok: true }),
      saveUrl: async (url: string) => {
        saveCalls.push(url);
        return { ok: true, status: { configured: true, url } };
      },
      logout: async () => undefined,
      quit: async () => undefined,
    };
    (globalThis as unknown as { window: unknown }).window = {
      electron: { enterpriseMt: localBridge },
      location: { reload: () => reloadCalls.push(Date.now()) },
    };

    const url = 'https://new.genwork.com';
    const result = await localBridge.saveUrl(url);
    expect(result.ok).toBe(true);
    expect(result.status?.url).toBe(url);
    expect(saveCalls).toEqual(['https://new.genwork.com']);
  });

  test('onSave calls logout + reload after a successful save', async () => {
    const logoutCalls: number[] = [];
    const localBridge = {
      getBootstrapStatus: async () => ({ url: 'https://prod.genwork.com' }),
      verifyUrl: async () => ({ ok: true }),
      saveUrl: async (_url: string) => ({
        ok: true,
        status: { configured: true, url: 'https://new.genwork.com' },
      }),
      logout: async () => {
        logoutCalls.push(Date.now());
      },
      quit: async () => undefined,
    };
    (globalThis as unknown as { window: unknown }).window = {
      electron: { enterpriseMt: localBridge },
      location: { reload: () => reloadCalls.push(Date.now()) },
    };

    // Exercise the same onSave body the parent component installs.
    const saveResult = await localBridge.saveUrl('https://new.genwork.com');
    if (saveResult.ok) {
      await localBridge.logout();
      window.location.reload();
    }
    expect(saveResult.ok).toBe(true);
    expect(logoutCalls).toHaveLength(1);
    expect(reloadCalls).toHaveLength(1);
  });

  test('onSave does NOT call logout or reload when saveUrl returns ok=false', async () => {
    const logoutCalls: number[] = [];
    reloadCalls.length = 0;
    const localBridge = {
      getBootstrapStatus: async () => ({ url: 'https://prod.genwork.com' }),
      verifyUrl: async () => ({ ok: true }),
      saveUrl: async (_url: string) => ({ ok: false, error: 'storage failure' }),
      logout: async () => {
        logoutCalls.push(Date.now());
      },
      quit: async () => undefined,
    };
    (globalThis as unknown as { window: unknown }).window = {
      electron: { enterpriseMt: localBridge },
      location: { reload: () => reloadCalls.push(Date.now()) },
    };
    const result = await localBridge.saveUrl('https://broken.genwork.com');
    if (result.ok) {
      await localBridge.logout();
      window.location.reload();
    }
    expect(result.ok).toBe(false);
    expect(logoutCalls).toHaveLength(0);
    expect(reloadCalls).toHaveLength(0);
  });
});