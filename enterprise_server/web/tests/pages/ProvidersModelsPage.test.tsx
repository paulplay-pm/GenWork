import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import type { ProviderKeyView } from '../../src/api/providers';
import { useAuthStore } from '../../src/auth/store';
import { ProvidersModelsPage } from '../../src/pages/ProvidersModelsPage';

function renderPage(initialEntries: string[] = ['/']): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <ProvidersModelsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Order-independent fetch mock keyed on the route prefix. */
function mockFetchData(providers: ProviderKeyView[], models: unknown[] = []): void {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/admin/provider-keys')) {
      return Promise.resolve(
        new Response(JSON.stringify(providers), { status: 200 })
      );
    }
    if (url.startsWith('/admin/models')) {
      return Promise.resolve(new Response(JSON.stringify(models), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

const providerRow = (
  over: Partial<ProviderKeyView> = {}
): ProviderKeyView => ({
  id: 'pk1',
  provider: 'openai',
  endpoint: 'https://api.openai.com/v1',
  label: 'prod-openai',
  enabled: true,
  region: 'global',
  default_base_url: 'https://api.openai.com/v1',
  website: 'https://platform.openai.com',
  description: 'prod cluster',
  api_key_masked: 'sk-…abcd',
  status: 'connected',
  latency_ms: 142,
  last_test_at: null,
  created_at: '2026-08-26T00:00:00Z',
  is_builtin: true,
  protocol: 'openai',
  coding_plan: false,
  ...over,
});

describe('pages/ProvidersModelsPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['model_admin'] },
    });
  });

  test('shows loading indicator while queries are in flight', () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    renderPage();
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  test('shows page header and rail sections when loaded', async () => {
    mockFetchData([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Model management')).toBeInTheDocument()
    );
    expect(screen.getByPlaceholderText(/Search/i)).toBeInTheDocument();
    // Empty-state CTA in the detail pane.
    expect(screen.getByText(/Select a provider on the left/i)).toBeInTheDocument();
  });

  test('defaults to the first provider on entry without a click', async () => {
    mockFetchData([providerRow()]);
    renderPage();
    // The rail loads and the detail pane auto-selects the only provider —
    // its info card is pre-filled with the row's label, no click required.
    await waitFor(() =>
      expect(screen.getByDisplayValue('prod-openai')).toBeInTheDocument()
    );
  });

  test('prefers the first built-in provider over a custom one on entry', async () => {
    // Custom is listed first, but the default picks the built-in (top rail row).
    const custom = providerRow({ id: 'pkc', provider: 'deepseek', label: 'my deepseek', is_builtin: false });
    const builtin = providerRow({ id: 'pkb', provider: 'deepseek', label: 'DeepSeek', is_builtin: true });
    mockFetchData([custom, builtin]);
    renderPage();
    // The built-in is the one selected: its label fills the info card; the
    // custom label does not (only the selected provider renders the info card).
    await waitFor(() =>
      expect(screen.getByDisplayValue('DeepSeek')).toBeInTheDocument()
    );
    expect(screen.queryByDisplayValue('my deepseek')).toBeNull();
  });

  test('shows the empty state when there are no providers', async () => {
    mockFetchData([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Model management')).toBeInTheDocument()
    );
    // Nothing to auto-select → the detail pane keeps its select-provider CTA.
    expect(screen.getByText(/Select a provider on the left/i)).toBeInTheDocument();
  });

  test('renders breadcrumb and header when a provider is selected', async () => {
    mockFetchData([providerRow()]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getAllByText('prod-openai').length).toBeGreaterThan(0)
    );
    await user.click(screen.getAllByText('prod-openai')[0]!);
    // Breadcrumb + h1 pick up the label.
    await waitFor(() =>
      expect(screen.getAllByText('prod-openai').length).toBeGreaterThanOrEqual(2)
    );
  });

  test('selected provider renders header, info card and model list', async () => {
    mockFetchData([providerRow()]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getAllByText('prod-openai').length).toBeGreaterThan(0)
    );
    await user.click(screen.getAllByText('prod-openai')[0]!);
    // Info card fields pre-filled from the row.
    await waitFor(() =>
      expect(screen.getByDisplayValue('prod-openai')).toBeInTheDocument()
    );
    expect(screen.getByDisplayValue('https://api.openai.com/v1')).toBeInTheDocument();
    // Header actions + model table shell.
    expect(screen.getByRole('button', { name: /Test connection/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add model/i })).toBeInTheDocument();
    // No models yet → empty state.
    expect(screen.getByText(/No models configured/i)).toBeInTheDocument();
  });

  test('custom draft selection renders the editable shell with a fresh slug', async () => {
    mockFetchData([]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Search/i)).toBeInTheDocument()
    );
    // The "+ Add provider" button lives under the custom section.
    await user.click(screen.getByRole('button', { name: /Add provider/i }));
    // A custom draft's slug is generated at click time (custom-<ts>); the
    // header h1 falls back to the localized "new name" default.
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 1, name: /New custom provider/i })
      ).toBeInTheDocument()
    );
    // Create-mode shell renders the info card, pre-filled with the draft name.
    expect(screen.getByDisplayValue('New custom provider')).toBeInTheDocument();
  });

  test('hides save/delete/toggle when canManage is false', async () => {
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['user'] },
    });
    mockFetchData([providerRow({ label: 'prod-openai', description: null })]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getAllByText('prod-openai').length).toBeGreaterThan(0)
    );
    await user.click(screen.getAllByText('prod-openai')[0]!);
    // ProviderInfoCard renders with the label field populated.
    await waitFor(() =>
      expect(screen.getByDisplayValue('prod-openai')).toBeInTheDocument()
    );
    // No "Add model" / "Fetch models" buttons when canManage=false.
    expect(screen.queryByRole('button', { name: /Add model/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Fetch models/i })).toBeNull();
    // The header still shows the test button (always visible).
    expect(
      screen.getByRole('button', { name: /Test connection/i })
    ).toBeInTheDocument();
  });

  test('never renders api_key encrypted value', async () => {
    const secret = 'sk-DO-NOT-LEAK-1234567890';
    mockFetchData([
      providerRow({
        api_key_masked: 'sk-…abcd',
        // @ts-expect-error — simulating a (buggy) server leaking the secret.
        api_key_encrypted: secret,
      }),
    ]);
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText('prod-openai').length).toBeGreaterThan(0)
    );
    expect(screen.queryByText(secret)).toBeNull();
    expect(screen.queryByText(/DO-NOT-LEAK/)).toBeNull();
  });

  test('add model opens the drawer and saves via POST /admin/models', async () => {
    mockFetchData([providerRow()]);
    renderPage();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getAllByText('prod-openai').length).toBeGreaterThan(0)
    );
    await user.click(screen.getAllByText('prod-openai')[0]!);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Add model/i })).toBeInTheDocument()
    );
    await user.click(screen.getByRole('button', { name: /Add model/i }));
    // The drawer opens with the name / model-ID inputs.
    const nameInput = screen.getByPlaceholderText('e.g. DeepSeek Chat');
    const idInput = screen.getByPlaceholderText('e.g. deepseek-chat');
    await user.type(nameInput, 'My Model');
    await user.type(idInput, 'my-model');
    // Two "Save" buttons exist (header, drawer footer); the drawer's is
    // rendered last in the DOM.
    const saveButtons = screen.getAllByRole('button', { name: /^Save$/ });
    await user.click(saveButtons[saveButtons.length - 1]!);
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]) === '/admin/models' &&
          (c[1] as RequestInit | undefined)?.method === 'POST'
      );
      expect(post).toBeDefined();
    });
    const post = fetchMock.mock.calls.find(
      (c) =>
        String(c[0]) === '/admin/models' &&
        (c[1] as RequestInit | undefined)?.method === 'POST'
    )!;
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      orgId: 'o1',
      providerKeyId: 'pk1',
      provider: 'openai',
      model: 'my-model',
      displayName: 'My Model',
      types: ['chat'],
    });
    // On success the drawer closes.
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('e.g. deepseek-chat')).toBeNull()
    );
  });

  test('delete model opens a styled confirm dialog and deletes on confirm', async () => {
    // A single real model under the (built-in) provider so the row renders.
    mockFetchData([providerRow()], [
      {
        id: 'builtin:o1:openai:gpt-5',
        provider: 'openai',
        provider_key_id: 'pk1',
        model: 'gpt-5',
        display_name: 'GPT-5',
        types: ['chat'],
        context_window: 128000,
        enabled: true,
        disabled_by_admin: false,
      },
    ]);
    renderPage();
    const user = userEvent.setup();
    // Default selection lands on the provider; the model row renders its name.
    await waitFor(() =>
      expect(screen.getByText('GPT-5')).toBeInTheDocument()
    );
    // The row's trash icon opens the styled dialog (not window.confirm).
    await user.click(screen.getByRole('button', { name: /Delete/i }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 2, name: 'Delete model' }),
      ).toBeInTheDocument()
    );
    // The message shows the friendly display name, not the raw catalog id.
    expect(screen.getByText(/Delete model "GPT-5"/)).toBeInTheDocument();
    expect(screen.queryByText('builtin:o1:openai:gpt-5')).toBeNull();
    // Confirming issues DELETE /admin/models/<id>.
    // The row's trash icon (aria-label "Delete") and the dialog's confirm
    // button (text "Delete") share a name; the dialog is rendered last, so it
    // is the final match.
    const deleteButtons = screen.getAllByRole('button', { name: /^Delete$/ });
    await user.click(deleteButtons[deleteButtons.length - 1]!);
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).includes('/admin/models/') &&
          (c[1] as RequestInit | undefined)?.method === 'DELETE'
      );
      expect(del).toBeDefined();
    });
    // The dialog closes after confirming.
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { level: 2, name: 'Delete model' }),
      ).toBeNull()
    );
  });
});
