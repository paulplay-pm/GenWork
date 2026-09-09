import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useAuthStore } from '../../src/auth/store';
import { clearMeProfileCache } from '../../src/auth/useMe';
import { UserMenu } from '../../src/components/UserMenu';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

function renderMenu(): void {
  render(
    <MemoryRouter>
      <UserMenu />
    </MemoryRouter>
  );
}

describe('components/UserMenu', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // The /me profile cache is session-scoped module state; each test simulates
    // a fresh session, so reset it like the auth store below.
    clearMeProfileCache();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('/me')) {
        return new Response(
          JSON.stringify({ username: 'paul', display_name: 'Paul Wang' }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    });
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'uuid-1234', orgId: 'o1', roles: ['super_admin'] },
    });
  });

  test('shows the display name from /me, not the user id', async () => {
    renderMenu();
    await screen.findByText('Paul Wang');
    expect(screen.queryByText('uuid-1234')).toBeNull();
  });

  test('opens a 3-item menu on click', async () => {
    renderMenu();
    await screen.findByText('Paul Wang');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('menuitem', { name: /Personal info/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Change password/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Log out/i })).toBeInTheDocument();
  });

  test('opens the personal-info modal with the display name pre-filled', async () => {
    renderMenu();
    await screen.findByText('Paul Wang');
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Personal info/i }));
    const input = (await screen.findByPlaceholderText(/How you appear/i)) as HTMLInputElement;
    expect(input.value).toBe('Paul Wang');
  });

  test('opens the change-password modal', async () => {
    renderMenu();
    await screen.findByText('Paul Wang');
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Change password/i }));
    expect(screen.getByPlaceholderText(/Current password/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/New password/i)).toBeInTheDocument();
  });

  test('falls back to the JWT sub when /me fails', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    renderMenu();
    await waitFor(() => expect(screen.getByText('uuid-1234')).toBeInTheDocument());
  });
});
