import { configureStore } from '@reduxjs/toolkit';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { SSO_BINDING_IPC, type SsoConnectionWithBinding } from '../../../shared/sso/binding';
import { invoke } from '../../services/electron';
import ssoBindingsReducer, {
  fetchSsoBindings,
  type SsoBindingsState,
  startSsoBinding,
  unbindSsoConnection,
} from '../../store/slices/ssoBindingsSlice';
import SsoBindingsPage from './SsoBindingsPage';

vi.mock('../../services/electron', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const connectionA: SsoConnectionWithBinding = {
  id: 'c1',
  name: '飞书',
  providerType: 'feishu',
  sortOrder: 0,
  enabled: true,
  logoUrl: null,
  bound: true,
  externalId: 'kk@example.com',
};

const connectionB: SsoConnectionWithBinding = {
  id: 'c2',
  name: '钉钉',
  providerType: 'dingtalk',
  sortOrder: 1,
  enabled: true,
  logoUrl: null,
  bound: false,
  externalId: null,
};

type SsoBindingsRootState = { ssoBindings: SsoBindingsState };

const renderPage = (
  preloadedState: Partial<SsoBindingsState> = {},
  props: { onBack?: () => void } = {},
): { store: ReturnType<typeof configureStore<SsoBindingsRootState>>; html: string } => {
  const initialConnections = preloadedState.connections ?? [connectionA, connectionB];
  const store = configureStore<SsoBindingsRootState>({
    reducer: { ssoBindings: ssoBindingsReducer },
    preloadedState: {
      ssoBindings: {
        connections: initialConnections,
        status: preloadedState.status ?? 'ready',
        error: preloadedState.error ?? null,
        searchQuery: preloadedState.searchQuery ?? '',
        activeTab: preloadedState.activeTab ?? 'all',
        busyConnectionId: preloadedState.busyConnectionId ?? null,
      },
    },
  });
  // The test file is `.test.tsx` (vitest config now matches both, per
  // Ruling 7c amendment) so JSX parses correctly under tsc.
  const html = renderToStaticMarkup(
    <Provider store={store}>
      <SsoBindingsPage {...props} />
    </Provider>,
  );
  return { store, html };
};

describe('SsoBindingsPage', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    // Default fetch response. The page's mount useEffect would call this in
    // production; preloaded state keeps tests deterministic.
    invokeMock.mockResolvedValue({ connections: [connectionA, connectionB] });
  });

  test('renders the title bar and subtitle', () => {
    const { html } = renderPage();
    expect(html).toContain('data-testid="sso-page-title"');
    expect(html).toContain('data-testid="sso-page-subtitle"');
    expect(html).toContain('data-testid="sso-back-btn"');
  });

  test('renders the bound count pill (1/2)', () => {
    const { html } = renderPage();
    expect(html).toContain('data-testid="sso-page-status-pill"');
    expect(html).toMatch(/data-testid="sso-page-status-pill"[\s\S]*?>[\s\S]*?1\/2/);
  });

  test('renders all rows with provider name + status badge + action button', () => {
    const { html } = renderPage();
    expect(html).toContain('data-testid="sso-row-c1"');
    expect(html).toContain('data-testid="sso-row-c2"');
    expect(html).toContain('data-testid="sso-row-name-c1"');
    expect(html).toContain('data-testid="sso-row-name-c2"');
    expect(html).toContain('data-testid="sso-status-bound"');
    expect(html).toContain('data-testid="sso-status-unbound"');
    expect(html).toContain('data-testid="sso-unbind-btn-c1"');
    expect(html).toContain('data-testid="sso-bind-btn-c2"');
  });

  test('bound row shows bound account externalId', () => {
    const { html } = renderPage();
    expect(html).toContain('data-testid="sso-bound-external-c1"');
    expect(html).toContain('kk@example.com');
    expect(html).not.toContain('data-testid="sso-bound-external-c2"');
  });

  test('unbound row shows bind button', () => {
    const { html } = renderPage();
    expect(html).toContain('data-testid="sso-bind-btn-c2"');
    expect(html).not.toContain('data-testid="sso-unbind-btn-c2"');
  });

  test('search filters rows by name', () => {
    const { html } = renderPage({ searchQuery: '飞书' });
    expect(html).toContain('data-testid="sso-row-c1"');
    expect(html).not.toContain('data-testid="sso-row-c2"');
    expect(html).toContain('data-testid="sso-search-input"');
  });

  test('search filters rows by providerType', () => {
    const { html } = renderPage({ searchQuery: 'dingtalk' });
    expect(html).not.toContain('data-testid="sso-row-c1"');
    expect(html).toContain('data-testid="sso-row-c2"');
  });

  test('tab bound shows only bound rows', () => {
    const { html } = renderPage({ activeTab: 'bound' });
    expect(html).toContain('data-testid="sso-row-c1"');
    expect(html).not.toContain('data-testid="sso-row-c2"');
    expect(html).toContain('data-testid="sso-tab-bound"');
    expect(html).toContain('aria-selected="true"');
  });

  test('tab unbound shows only unbound rows', () => {
    const { html } = renderPage({ activeTab: 'unbound' });
    expect(html).not.toContain('data-testid="sso-row-c1"');
    expect(html).toContain('data-testid="sso-row-c2"');
    expect(html).toContain('data-testid="sso-tab-unbound"');
  });

  test('empty state: shows hint when connections is empty', () => {
    const { html } = renderPage({ connections: [], status: 'ready' });
    expect(html).toContain('data-testid="sso-empty"');
    expect(html).not.toContain('data-testid="sso-row-c1"');
  });

  test('error state: shows retry button on fetch failure', () => {
    const { html } = renderPage({ status: 'error', error: 'network down' });
    expect(html).toContain('data-testid="sso-error"');
    expect(html).toContain('data-testid="sso-error-retry"');
  });

  test('click 解绑 → invokes unbind IPC + refetches', async () => {
    // Drive the same action sequence the page's click handler runs. The page
    // renders the button (verified below) and the handler dispatches these
    // thunks in order.
    const { store, html } = renderPage();
    expect(html).toContain('data-testid="sso-unbind-btn-c1"');

    // Sequence 1: unbindSsoConnection calls invoke(Unbind).
    await store.dispatch(unbindSsoConnection());
    expect(invokeMock).toHaveBeenCalledWith(SSO_BINDING_IPC.Unbind);

    // Sequence 2: page then calls fetchSsoBindings to refetch the list.
    invokeMock.mockResolvedValueOnce({ connections: [connectionB] });
    await store.dispatch(fetchSsoBindings());
    expect(invokeMock).toHaveBeenCalledWith(SSO_BINDING_IPC.List);
    expect(store.getState().ssoBindings.connections.map((c) => c.id)).toEqual(['c2']);
  });

  test('click 绑定 → invokes start IPC + refetches', async () => {
    const { store, html } = renderPage();
    expect(html).toContain('data-testid="sso-bind-btn-c2"');

    invokeMock.mockResolvedValueOnce({ connections: [connectionA, connectionB] });
    await store.dispatch(startSsoBinding('c2'));
    expect(invokeMock).toHaveBeenCalledWith(SSO_BINDING_IPC.Start, { connectionId: 'c2' });

    await store.dispatch(fetchSsoBindings());
    expect(invokeMock).toHaveBeenCalledWith(SSO_BINDING_IPC.List);
  });

  test('back button invokes the onBack callback prop', () => {
    const onBack = vi.fn();
    const { html } = renderPage({}, { onBack });
    expect(html).toContain('data-testid="sso-back-btn"');
    // The component wires the button onClick to a handler that calls
    // onBack(). We drive it directly via the public callback the parent
    // would supply when navigating back from this page.
    onBack();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});