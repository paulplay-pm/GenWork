import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useAuthStore } from '../../src/auth/store';
import { Sidebar } from '../../src/components/Sidebar';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

function renderSidebar(initialPath = '/'): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Sidebar />
    </MemoryRouter>
  );
}

describe('components/Sidebar', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // /me is called by the footer (UserMenu → useMe); a 404 makes it degrade to
    // the JWT `sub` so the tests assert the fallback path deterministically.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1_admin', orgId: 'o1', roles: ['super_admin'] },
    });
  });

  test('renders brand block', () => {
    renderSidebar();
    expect(screen.getByText(/GenWork Console/i)).toBeInTheDocument();
  });

  test('renders all 4 nav section labels', () => {
    renderSidebar();
    expect(screen.getAllByText(/Overview/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Configuration/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Monitoring/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Organization/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/System/i)).toBeNull();
  });

  test('renders the footer name from the JWT sub when /me is unavailable', () => {
    renderSidebar();
    expect(screen.getByText(/u1_admin/i)).toBeInTheDocument();
    expect(screen.getByText(/Super admin/i)).toBeInTheDocument();
  });

  test('active route gets accent background', () => {
    renderSidebar('/config/providers');
    const link = screen.getByRole('link', { name: /Model configuration/i });
    expect(link.className).toMatch(/bg-\[var\(--accent-light\)\]/);
    expect(link.className).toMatch(/text-\[var\(--accent-primary\)\]/);
  });

  test('hides org_admin-gated items when user lacks capability', () => {
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['user'] },
    });
    renderSidebar();
    expect(screen.queryByRole('link', { name: /Users/i })).toBeNull();
  });

  test('shows the MCP management nav item for org_admin', () => {
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'a', orgId: 'o1', roles: ['org_admin'] } });
    renderSidebar('/config/mcp-manage');
    expect(screen.getByRole('link', { name: /MCP management/i })).toBeInTheDocument();
  });

  test('hides the MCP management nav item when lacking org_admin', () => {
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'u', orgId: 'o1', roles: ['user'] } });
    renderSidebar();
    expect(screen.queryByRole('link', { name: /MCP management/i })).toBeNull();
  });
});
