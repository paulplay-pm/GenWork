import { beforeEach,describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { SetupPage } from '../src/pages/SetupPage';

describe('smoke', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  test('SetupPage renders wizard when no super admin', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ superAdminExists: false, hasPendingInvite: false }),
        { status: 200 }
      )
    );
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(screen.getByText(/Set up your organization/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/Create the first admin account/i)).toBeInTheDocument();
  });
});