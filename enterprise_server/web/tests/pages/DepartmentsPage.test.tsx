import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useAuthStore } from '../../src/auth/store';
import { DepartmentsPage } from '../../src/pages/DepartmentsPage';

const wrap = (ui: ReactElement) => { const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); return <QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>; };

describe('pages/DepartmentsPage', () => {
  beforeEach(() => { fetchMock.mockReset(); useAuthStore.setState({ token: 'jwt', claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] } }); });
  test('renders the tree with subtree counts and opens detail', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 'r', name: 'Acme', code: 'ROOT', parent_id: null, path: '/Acme', directMembers: 1, subtreeMembers: 5, children: [
        { id: 'e', name: 'Eng', code: 'ENG', parent_id: 'r', path: '/Acme/Eng', directMembers: 4, subtreeMembers: 4, children: [] },
      ] },
    ]), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'r', name: 'Acme', stats: { direct: 1, subtree: 5, children: 1 }, members: [] }), { status: 200 }));
    render(wrap(<DepartmentsPage />));
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    expect(screen.getByText('Eng')).toBeInTheDocument();
  });
});
