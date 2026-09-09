import { beforeEach,describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { apiClient } from '../../src/api/client';
import { useAuthStore } from '../../src/auth/store';
import { SetupPage } from '../../src/pages/SetupPage';

describe('pages/SetupPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useAuthStore.getState().logout();
    apiClient.setBaseUrl('http://test');
    apiClient.setTokenProvider(() => null);
    apiClient.setRefresh(null);
  });

  test('status false → renders wizard', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ superAdminExists: false, hasPendingInvite: false }), { status: 200 })
    );
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    );
    // The org step is shown: the wizard heading, the org-name field, and the
    // Continue button (disabled until a name is entered).
    await waitFor(() =>
      expect(screen.getByText(/Set up your organization/i)).toBeInTheDocument()
    );
    expect(screen.getByPlaceholderText(/Acme Corp/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/i })).toBeDisabled();
  });

  test('status true → redirects to /login', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ superAdminExists: true, hasPendingInvite: false }), { status: 200 })
    );
    render(
      <MemoryRouter initialEntries={['/setup']}>
        <SetupPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // An existing super admin is bounced to /login, so the org-step UI never
    // renders (the Continue button is the org step's control).
    expect(screen.queryByRole('button', { name: /Continue/i })).toBeNull();
  });

  test('start → render code + form', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ superAdminExists: false, hasPendingInvite: false }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ orgId: 'o1', orgName: 'Acme', code: 'GENWORK-SETUP-AAA-BBB-CCC', expiresAt: '2030-01-01T00:00:00Z' }),
          { status: 200 }
        )
      );
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    );
    // Org step first; fill the name (required) and click Continue.
    const continueBtn = await screen.findByRole('button', { name: /Continue/i });
    fireEvent.change(screen.getByPlaceholderText(/Acme Corp/i), { target: { value: 'Acme' } });
    fireEvent.click(continueBtn);
    await waitFor(() => expect(screen.getByText(/GENWORK-SETUP-AAA-BBB-CCC/)).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/Username/i)).toBeInTheDocument();
  });
});