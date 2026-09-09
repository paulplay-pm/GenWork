import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { LoginPage, safeNextRedirect } from '../../src/pages/LoginPage';
import { apiClient } from '../../src/api/client';
import { useAuthStore } from '../../src/auth/store';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

/**
 * Intercept `window.location.assign` (used for the full-navigation to the
 * validated `?next=` target) instead of triggering a real jsdom navigation.
 * `useLocation().search` is read from the router's history (set via
 * `initialEntries`), so only `assign` needs stubbing here.
 */
const realLocation = window.location;
function stubAssign(assign: (url: string) => void): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...realLocation, assign },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  useAuthStore.getState().logout();
  apiClient.setBaseUrl('http://test');
  apiClient.setTokenProvider(() => null);
  apiClient.setRefresh(null);
  // Restore a clean location each test.
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: realLocation,
  });
});

describe('safeNextRedirect (open-redirect guard)', () => {
  test('accepts a same-origin absolute path', () => {
    expect(safeNextRedirect('?next=' + encodeURIComponent('/api/pages/abc/index.html'))).toBe(
      '/api/pages/abc/index.html',
    );
  });

  test('accepts a plain root path', () => {
    expect(safeNextRedirect('?next=%2F')).toBe('/');
  });

  test('rejects a protocol-relative URL (//evil.com)', () => {
    expect(safeNextRedirect('?next=' + encodeURIComponent('//evil.com/x'))).toBeNull();
  });

  test('rejects an absolute foreign URL (https://evil.com)', () => {
    expect(safeNextRedirect('?next=' + encodeURIComponent('https://evil.com/x'))).toBeNull();
  });

  test('rejects a relative path (../../etc)', () => {
    expect(safeNextRedirect('?next=' + encodeURIComponent('../../etc'))).toBeNull();
  });

  test('returns null when there is no next param', () => {
    expect(safeNextRedirect('?foo=bar')).toBeNull();
    expect(safeNextRedirect('')).toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(safeNextRedirect('?next=%zz')).toBeNull();
  });
});

describe('pages/LoginPage ?next= handling', () => {
  const orgsResp = (orgs: { id: string; name: string }[]) =>
    new Response(JSON.stringify({ orgs }), { status: 200 });

  test('after login, a valid ?next= triggers a full navigation to that path', async () => {
    const assignSpy = vi.fn();
    stubAssign(assignSpy);
    fetchMock.mockResolvedValueOnce(orgsResp([{ id: 'o1', name: 'Acme' }]));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt-1' }), { status: 200 }));

    render(
      <MemoryRouter initialEntries={['/login?next=' + encodeURIComponent('/api/pages/abc/index.html')]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    // The full navigation target is the validated share path (a real page
    // request, not an in-app route change).
    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(1));
    expect(assignSpy).toHaveBeenCalledWith('/api/pages/abc/index.html');
  });

  test('an unsafe ?next= does NOT full-navigate to a foreign target', async () => {
    const assignSpy = vi.fn();
    stubAssign(assignSpy);
    fetchMock.mockResolvedValueOnce(orgsResp([{ id: 'o1', name: 'Acme' }]));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt-1' }), { status: 200 }));

    render(
      <MemoryRouter initialEntries={['/login?next=' + encodeURIComponent('//evil.com/x')]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>Dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(assignSpy).not.toHaveBeenCalled();
    // Falls back to the app root via the SPA router.
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
  });
});
