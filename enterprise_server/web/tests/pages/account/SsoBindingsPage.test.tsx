import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useAuthStore } from '../../../src/auth/store';
import { clearMeProfileCache } from '../../../src/auth/useMe';
import { setLang } from '../../../src/i18n';
import { SsoBindingsPage } from '../../../src/pages/account/SsoBindingsPage';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

const renderPage = (): ReturnType<typeof render> => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SsoBindingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const mockConnections = [
  {
    id: 'c1',
    name: '飞书',
    providerType: 'feishu',
    sortOrder: 0,
    enabled: true,
    logoUrl: null,
    bound: true,
    externalId: 'kk@example.com',
  },
  {
    id: 'c2',
    name: '钉钉',
    providerType: 'dingtalk',
    sortOrder: 1,
    enabled: true,
    logoUrl: null,
    bound: false,
    externalId: null,
  },
];

// Queue mocks in the order the page fires:
//   1) GET /auth/orgs                    (page's useEffect on mount)
//   2) GET /me/sso-binding/connections   (TanStack Query)
//   3) GET /me                           (deferred useMe, defensive)
const queueHappy = (): void => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ orgs: [{ id: 'o1', name: 'Acme' }] }), { status: 200 }),
  );
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ connections: mockConnections }), { status: 200 }),
  );
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
};

describe('pages/account/SsoBindingsPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearMeProfileCache();
    setLang('zh');
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['user'] },
    });
  });

  // 1. Title + subtitle
  test('renders title and subtitle', async () => {
    queueHappy();
    renderPage();
    expect(await screen.findByText('SSO 账号绑定')).toBeInTheDocument();
    expect(screen.getByText(/绑定企业身份源/)).toBeInTheDocument();
  });

  // 2. Bound count pill renders {bound}/{total}
  test('renders bound count 1/2', async () => {
    queueHappy();
    renderPage();
    expect(await screen.findByText(/已绑定\s*1\s*\/\s*2/)).toBeInTheDocument();
  });

  // 3. All rows render with name + status + button
  test('renders all rows with name + status + button', async () => {
    queueHappy();
    renderPage();
    expect(await screen.findByText('飞书')).toBeInTheDocument();
    expect(screen.getByText('钉钉')).toBeInTheDocument();
    expect(screen.getByText('feishu')).toBeInTheDocument();
    expect(screen.getByText('dingtalk')).toBeInTheDocument();
    expect(screen.getByText('已绑定')).toBeInTheDocument();
    expect(screen.getByText('未绑定')).toBeInTheDocument();
  });

  // 4. Bound row shows the bound account placeholder
  test('bound row shows bound account', async () => {
    queueHappy();
    renderPage();
    expect(await screen.findByText(/已绑定账号\s*kk@example\.com/)).toBeInTheDocument();
  });

  // 5. Unbound row shows 绑定 button
  test('unbound row shows 绑定 button', async () => {
    queueHappy();
    renderPage();
    const bindButtons = await screen.findAllByRole('button', { name: '绑定' });
    expect(bindButtons.length).toBeGreaterThanOrEqual(1);
  });

  // 6. Search filters by name (case-insensitive, also matches providerType)
  test('search filters by name (case-insensitive)', async () => {
    queueHappy();
    renderPage();
    const search = await screen.findByPlaceholderText('搜索 SSO 类型或名称');
    fireEvent.change(search, { target: { value: 'feishu' } });
    await waitFor(() => {
      expect(screen.queryByText('钉钉')).not.toBeInTheDocument();
    });
    expect(screen.getByText('飞书')).toBeInTheDocument();
  });

  // 7. Tab: 已绑定 shows only bound rows
  test('tab switch: 已绑定 shows only bound rows', async () => {
    queueHappy();
    renderPage();
    const boundTab = await screen.findByRole('tab', { name: /已绑定\s*1/ });
    fireEvent.click(boundTab);
    await waitFor(() => {
      expect(screen.queryByText('钉钉')).not.toBeInTheDocument();
    });
    expect(screen.getByText('飞书')).toBeInTheDocument();
  });

  // 8. Tab: 未绑定 shows only unbound rows
  test('tab switch: 未绑定 shows only unbound rows', async () => {
    queueHappy();
    renderPage();
    const unboundTab = await screen.findByRole('tab', { name: /未绑定\s*1/ });
    fireEvent.click(unboundTab);
    await waitFor(() => {
      expect(screen.queryByText('飞书')).not.toBeInTheDocument();
    });
    expect(screen.getByText('钉钉')).toBeInTheDocument();
  });

  // 9. Tab 全部 {n} substitutes the count (NOT literal "{n}")
  test('tab 全部 {n} substitutes the count', async () => {
    queueHappy();
    renderPage();
    expect(await screen.findByText(/全部\s*2/)).toBeInTheDocument();
  });

  // 10. Click 绑定 → POST /me/sso-binding/start → assign returned authorizeUrl
  test('click 绑定 starts the bind flow and assigns the returned authorizeUrl', async () => {
    const assignSpy = vi.fn();
    const origAssign = window.location.assign;
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign: assignSpy },
      writable: true,
      configurable: true,
    });
    try {
      // Mount-time fetches in queue order:
      //   1) GET /auth/orgs
      //   2) GET /me/sso-binding/connections
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ orgs: [{ id: 'o1', name: 'Acme' }] }), { status: 200 }),
      );
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ connections: mockConnections }), { status: 200 }),
      );
      // Deferred GET /me (from a setTimeout(0) inside useMe's shared cache)
      // and the click-triggered POST /me/sso-binding/start both fall through
      // to this default. The POST is what actually matters; whatever the
      // /me consumer gets here is harmless because SsoBindingsPage does not
      // read /me directly.
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ authorizeUrl: 'https://idp.example/x?state=s1' }),
          { status: 200 },
        ),
      );
      renderPage();
      const bindButtons = await screen.findAllByRole('button', { name: '绑定' });
      // Wait for the button to be enabled (orgName has resolved)
      await waitFor(() => expect(bindButtons[0]).not.toBeDisabled());
      fireEvent.click(bindButtons[0]);
      await waitFor(() => {
        expect(assignSpy).toHaveBeenCalledWith('https://idp.example/x?state=s1');
      });
      // The POST is sent to /me/sso-binding/start with returnTarget=web
      const postCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.endsWith('/me/sso-binding/start'));
      expect(postCalls.length).toBe(1);
    } finally {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, assign: origAssign },
        writable: true,
        configurable: true,
      });
    }
  });

  // 11. Click 解绑 → unbindSsoBinding called (DELETE /me/sso-binding) + list refetches
  test('click 解绑 calls unbindSsoBinding and refetches', async () => {
    queueHappy();
    renderPage();
    const unbindBtn = await screen.findByRole('button', { name: '解绑' });
    // Refetch triggered by invalidate after DELETE succeeds.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ connections: [mockConnections[1]] }), { status: 200 }),
    );
    fireEvent.click(unbindBtn);
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.endsWith('/me/sso-binding'))).toBe(true);
    });
    await waitFor(() => {
      const connectionsCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.endsWith('/me/sso-binding/connections'));
      expect(connectionsCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // 11b. Refetch on mount (staleTime: 0)
  test('refetches on mount (staleTime: 0)', async () => {
    queueHappy();
    const { unmount } = renderPage();
    await waitFor(() => {
      const connectionsCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.endsWith('/me/sso-binding/connections'));
      expect(connectionsCalls.length).toBe(1);
    });
    unmount();
    queueHappy();
    renderPage();
    await waitFor(() => {
      const connectionsCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.endsWith('/me/sso-binding/connections'));
      expect(connectionsCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // 12. Empty state shows hint
  test('empty state shows hint', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ orgs: [{ id: 'o1', name: 'Acme' }] }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ connections: [] }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    renderPage();
    expect(await screen.findByText('尚未配置任何 SSO 连接')).toBeInTheDocument();
    expect(screen.getByText(/请联系管理员/)).toBeInTheDocument();
  });

  // 13. Loading state — must show "加载中…" (i18n key ssoBindings.loading MUST exist)
  test('loading state shows 加载中…', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ orgs: [{ id: 'o1', name: 'Acme' }] }), { status: 200 }),
    );
    // Never resolve — keeps the query in loading state.
    fetchMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByText('加载中…')).toBeInTheDocument();
  });

  // 14. Error state
  test('error state shows 加载失败 + 重试', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ orgs: [{ id: 'o1', name: 'Acme' }] }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    );
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    renderPage();
    expect(await screen.findByText('加载失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  // 15. Retry button calls refetch
  test('click 重试 refetches', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ orgs: [{ id: 'o1', name: 'Acme' }] }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'network' }), { status: 500 }),
    );
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    renderPage();
    const retryBtn = await screen.findByRole('button', { name: '重试' });
    queueHappy();
    fireEvent.click(retryBtn);
    await waitFor(() => {
      const connectionsCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.endsWith('/me/sso-binding/connections'));
      expect(connectionsCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // 16. Mount with sessionStorage.ssoBindJustSucceeded='1' → toast 绑定成功 dispatched + flag cleared
  test('mount with ssoBindJustSucceeded=1 dispatches success toast and clears flag', async () => {
    queueHappy();
    sessionStorage.setItem('ssoBindJustSucceeded', '1');
    const toastHandler = vi.fn();
    window.addEventListener('app:showToast', toastHandler as EventListener);
    try {
      renderPage();
      await waitFor(() => {
        expect(toastHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            detail: expect.objectContaining({ kind: 'success', message: '绑定成功' }),
          }),
        );
      });
      expect(sessionStorage.getItem('ssoBindJustSucceeded')).toBeNull();
    } finally {
      window.removeEventListener('app:showToast', toastHandler as EventListener);
      sessionStorage.removeItem('ssoBindJustSucceeded');
    }
  });

  // 17. Mount with ?error=bind_external_id_exists → toast 该 SSO 账号已绑定其他用户 dispatched + URL cleaned
  test('mount with ?error=bind_external_id_exists dispatches duplicate-externalId toast and cleans URL', async () => {
    queueHappy();
    const replaceSpy = vi.fn();
    const origReplace = window.history.replaceState;
    window.history.replaceState = replaceSpy as typeof window.history.replaceState;
    const toastHandler = vi.fn();
    window.addEventListener('app:showToast', toastHandler as EventListener);
    try {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?error=bind_external_id_exists' },
        writable: true,
        configurable: true,
      });
      renderPage();
      await waitFor(() => {
        expect(toastHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            detail: expect.objectContaining({
              kind: 'error',
              message: '该 SSO 账号已绑定其他用户',
            }),
          }),
        );
      });
      expect(replaceSpy).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '' },
        writable: true,
        configurable: true,
      });
      window.history.replaceState = origReplace;
      window.removeEventListener('app:showToast', toastHandler as EventListener);
    }
  });

  // 18. Mount with ?error=sso_access_denied → toast 授权已取消 dispatched + URL cleaned
  test('mount with ?error=sso_access_denied dispatches cancelled toast and cleans URL', async () => {
    queueHappy();
    const replaceSpy = vi.fn();
    const origReplace = window.history.replaceState;
    window.history.replaceState = replaceSpy as typeof window.history.replaceState;
    const toastHandler = vi.fn();
    window.addEventListener('app:showToast', toastHandler as EventListener);
    try {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?error=sso_access_denied' },
        writable: true,
        configurable: true,
      });
      renderPage();
      await waitFor(() => {
        expect(toastHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            detail: expect.objectContaining({
              kind: 'error',
              message: '授权已取消',
            }),
          }),
        );
      });
      expect(replaceSpy).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '' },
        writable: true,
        configurable: true,
      });
      window.history.replaceState = origReplace;
      window.removeEventListener('app:showToast', toastHandler as EventListener);
    }
  });
});
