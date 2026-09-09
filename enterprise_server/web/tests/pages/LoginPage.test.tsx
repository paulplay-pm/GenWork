import { beforeEach,describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { apiClient } from '../../src/api/client';
import { useAuthStore } from '../../src/auth/store';
import { LoginPage } from '../../src/pages/LoginPage';

describe('pages/LoginPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useAuthStore.getState().logout();
    apiClient.setBaseUrl('http://test');
    apiClient.setTokenProvider(() => null);
    apiClient.setRefresh(null);
  });

  // The page fetches /auth/orgs on mount. These helpers seed that first call
  // so the interaction fetches are the ones under test.
  const orgsResp = (orgs: { id: string; name: string }[]) =>
    new Response(JSON.stringify({ orgs }), { status: 200 });
  const seedOrgs = (orgs: { id: string; name: string }[]) => {
    fetchMock.mockResolvedValueOnce(orgsResp(orgs));
  };

  test('renders username/password fields and submit (single org hides the selector)', async () => {
    seedOrgs([{ id: 'o1', name: 'Acme' }]);
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Username/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Password/i)).toBeInTheDocument();
    // With a single org the selector is hidden (orgName is auto-filled).
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  test('submit triggers POST /auth/login and stores token on success', async () => {
    // Seed the orgs fetch AND the auto-fired /auth/sso/providers fetch
    // (the LoginPage triggers the SSO fetch on mount once the single org
    // is auto-selected, with an empty providers list).
    seedOrgs([{ id: 'o1', name: 'Acme' }]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ providers: [] }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'jwt-1' }), { status: 200 })
    );
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); // orgs + sso
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    // Call 2 is the /auth/login POST; calls 0 + 1 are orgs + sso on mount.
    const [path, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(path).toMatch(/\/auth\/login$/);
    const body = JSON.parse(init.body as string);
    expect(body.username).toBe('');
    expect(body.password).toBe('');
  });

  test('error message on login failure (401 invalid → Invalid credentials)', async () => {
    seedOrgs([{ id: 'o1', name: 'Acme' }]);
    // Auto-fired SSO fetch on mount, with an empty providers list.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ providers: [] }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"invalid"}', { status: 401 })
    );
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() =>
      expect(screen.getByText(/Invalid credentials/i)).toBeInTheDocument()
    );
    // The submit button must return to enabled state — the previous behavior
    // was to wedge on `[disabled]` forever because of the refresh storm.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sign in/i })).not.toBeDisabled()
    );
  });

  test('rate-limited 429 shows the specific message', async () => {
    seedOrgs([{ id: 'o1', name: 'Acme' }]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ providers: [] }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"rate_limited"}', { status: 429 })
    );
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() =>
      expect(screen.getByText(/Too many failed attempts/i)).toBeInTheDocument()
    );
  });

  test('failed login does NOT trigger /auth/refresh (no infinite storm)', async () => {
    // Regression: a failed login previously fired an infinite series of
    // /auth/refresh 401s because refresh-on-401 applied to /auth/login too.
    seedOrgs([{ id: 'o1', name: 'Acme' }]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ providers: [] }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"invalid"}', { status: 401 })
    );
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    // Give any rogue retries a chance to fire. They must not.
    await new Promise((r) => setTimeout(r, 50));
    // Exactly three calls: orgs, sso, login. No /auth/refresh is ever
    // fired.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const paths = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(paths.some((p) => p.endsWith('/auth/login'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/auth/refresh'))).toBe(false);
  });

  test('username/password fields are wired', async () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    const username = screen.getByPlaceholderText(/Username/i) as HTMLInputElement;
    const password = screen.getByPlaceholderText(/Password/i) as HTMLInputElement;
    fireEvent.change(username, { target: { value: 'alice' } });
    fireEvent.change(password, { target: { value: 'pw' } });
    expect(username.value).toBe('alice');
    expect(password.value).toBe('pw');
  });

  // --- UX features (org selector, password toggle, Enter-to-submit) ---

  test('org selector is hidden when there is exactly one org', async () => {
    seedOrgs([{ id: 'o1', name: 'Acme' }]);
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  test('org selector renders as a dropdown when there are multiple orgs', async () => {
    seedOrgs([
      { id: 'o1', name: 'Acme' },
      { id: 'o2', name: 'Globex' },
    ]);
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    const optionNames = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(optionNames).toEqual(['Acme', 'Globex']);
  });

  test('password input has a show/hide toggle that flips input type', async () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    const password = screen.getByPlaceholderText(/Password/i) as HTMLInputElement;
    expect(password.type).toBe('password');

    const toggle = screen.getByRole('button', { name: /show password/i });
    fireEvent.click(toggle);
    expect(password.type).toBe('text');

    fireEvent.click(toggle);
    expect(password.type).toBe('password');
  });

  test('pressing Enter in the password field submits the form', async () => {
    fetchMock.mockResolvedValueOnce(orgsResp([{ id: 'o1', name: 'Acme' }]));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ providers: [] }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt-1' }), { status: 200 }));
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/Username/i), { target: { value: 'alice' } });
    const password = screen.getByPlaceholderText(/Password/i);
    fireEvent.change(password, { target: { value: 'pw' } });
    fireEvent.keyDown(password, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [path] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(path).toMatch(/\/auth\/login$/);
  });

  // --- SSO providers row ---

  /** Seed the orgs fetch and a matching /auth/sso/providers response. The
   * LoginPage fires the SSO fetch when the org is auto-selected (single
   * org), so we need both responses queued in order. */
  const seedOrgsAndSso = (
    orgs: { id: string; name: string }[],
    providers: Array<{ id: string; name: string; provider_type: string; sort_order: number; logoUrl: string | null }>,
  ): void => {
    fetchMock.mockResolvedValueOnce(orgsResp(orgs));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ providers }), { status: 200 }),
    );
  };

  test('SSO providers render as a circular-icon row below the submit button, with each logo', async () => {
    seedOrgsAndSso([{ id: 'o1', name: 'Acme' }], [
      { id: 'p1', name: 'Okta', provider_type: 'generic-oidc', sort_order: 0, logoUrl: 'https://cdn.example/okta.png' },
      { id: 'p2', name: 'Feishu', provider_type: 'feishu', sort_order: 1, logoUrl: 'https://cdn.example/feishu.png' },
    ]);
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    // Both buttons (Okta + Feishu) render with an accessible name derived
    // from the localized "Log in with <name>" string.
    const okta = await screen.findByRole('button', { name: /Log in with Okta/i });
    const feishu = await screen.findByRole('button', { name: /Log in with Feishu/i });
    expect(okta).toBeInTheDocument();
    expect(feishu).toBeInTheDocument();
    // Each button shows the provider logo as an <img>.
    const imgs = okta.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect((imgs[0] as HTMLImageElement).getAttribute('src')).toBe('https://cdn.example/okta.png');
    const feishuImgs = feishu.querySelectorAll('img');
    expect(feishuImgs).toHaveLength(1);
    expect((feishuImgs[0] as HTMLImageElement).getAttribute('src')).toBe('https://cdn.example/feishu.png');
  });

  test('SSO provider with null logoUrl falls back to a text monogram', async () => {
    seedOrgsAndSso([{ id: 'o1', name: 'Acme' }], [
      { id: 'p1', name: 'Okta', provider_type: 'generic-oidc', sort_order: 0, logoUrl: null },
    ]);
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    const btn = await screen.findByRole('button', { name: /Log in with Okta/i });
    // No <img> when logoUrl is null — a text monogram stands in.
    expect(btn.querySelectorAll('img')).toHaveLength(0);
    expect(btn.textContent).toContain('OK');
  });

  test('no SSO row when the public providers list is empty', async () => {
    seedOrgs([{ id: 'o1', name: 'Acme' }]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ providers: [] }), { status: 200 }),
    );
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // No "Other sign-in methods" divider is rendered.
    expect(screen.queryByText(/Other sign-in methods/i)).not.toBeInTheDocument();
  });
});