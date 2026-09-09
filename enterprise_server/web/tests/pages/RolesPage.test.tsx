import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { useAuthStore } from '../../src/auth/store';
import { clearMeProfileCache } from '../../src/auth/useMe';
import { RolesPage } from '../../src/pages/RolesPage';

const wrap = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
};

const me = {
  username: 'alice',
  display_name: 'Alice',
  permissions: ['role:view', 'role:create', 'role:edit', 'role:delete', 'dept:view'],
  effectiveDataScope: 'all',
};

const builtinRole = {
  id: 'rb',
  name: 'org_admin',
  displayName: 'Organization admin',
  description: 'Full access',
  permissions: ['role:view', 'audit:view'],
  dataScope: 'org_wide',
  customDeptIds: [],
  isBuiltin: true,
  memberCount: 3,
};

const customRole = {
  id: 'rc',
  name: 'auditor',
  displayName: 'Auditor',
  description: 'Reads audit logs',
  permissions: ['audit:view', 'audit:export'],
  dataScope: 'self',
  customDeptIds: [],
  isBuiltin: false,
  memberCount: 2,
};

const deptForest = [
  {
    id: 'd1',
    name: 'Root',
    code: 'ROOT',
    parent_id: null,
    path: '/Root',
    directMembers: 0,
    subtreeMembers: 5,
    children: [
      {
        id: 'd2',
        name: 'Eng',
        code: 'ENG',
        parent_id: 'd1',
        path: '/Root/Eng',
        directMembers: 5,
        subtreeMembers: 5,
        children: [],
      },
    ],
  },
];

/** The `/me` fetch is deferred one tick behind the page's own queries, so the
 * roles-list mock must be queued before the `/me` mock. */
const mockMeFirst = (roles: unknown[]) => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(roles), { status: 200 }));
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(me), { status: 200 }));
};

describe('pages/RolesPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // Session-scoped /me cache: each test starts from a fresh session so the
    // deferred GET /me actually fires (and lands on the mock queued here).
    clearMeProfileCache();
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] } });
  });

  test('lists built-in roles by default; built-in card hides delete', async () => {
    mockMeFirst([builtinRole]);
    render(wrap(<RolesPage />));
    await waitFor(() => expect(screen.getByText('Organization admin')).toBeInTheDocument());
    // Card shows the code, member count and data-scope label.
    expect(screen.getByText('org_admin')).toBeInTheDocument();
    // Type tag: the segment button plus one badge on the built-in card.
    expect(screen.getAllByText('Built-in').length).toBeGreaterThan(1);
    expect(screen.getByText('3 members')).toBeInTheDocument();
    expect(screen.getByText('Organization-wide')).toBeInTheDocument();
    // The custom role is not in the built-in segment.
    expect(screen.queryByText('Auditor')).toBeNull();
    // Built-in roles are delete-locked: no delete affordance on the card.
    expect(screen.queryByText('Delete')).toBeNull();
    // A role manager can still edit and copy.
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  test('segmented control switches between the built-in and custom lists', async () => {
    mockMeFirst([builtinRole]);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([customRole]), { status: 200 }));
    render(wrap(<RolesPage />));
    await waitFor(() => expect(screen.getByText('Organization admin')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() => expect(screen.getByText('Auditor')).toBeInTheDocument());
    expect(screen.getByText('2 members')).toBeInTheDocument();
    expect(screen.queryByText('Organization admin')).toBeNull();
  });

  test('drawer step 2 shows the five data-scope radio cards', async () => {
    mockMeFirst([builtinRole]);
    render(wrap(<RolesPage />));
    await waitFor(() => expect(screen.getByText('Organization admin')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Edit'));
    const drawer = await screen.findByTestId('role-drawer');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(within(drawer).getByText('Custom department scope')).toBeInTheDocument());
    for (const label of [
      'Organization-wide',
      'Department and below',
      'Own department',
      'Self only',
      'Custom department scope',
    ]) {
      expect(within(drawer).getByText(label)).toBeInTheDocument();
    }
  });

  test('drawer step 3 renders all modules with per-action checkboxes', async () => {
    mockMeFirst([builtinRole]);
    render(wrap(<RolesPage />));
    await waitFor(() => expect(screen.getByText('Organization admin')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Edit'));
    const drawer = await screen.findByTestId('role-drawer');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(within(drawer).getByText('Custom department scope')).toBeInTheDocument());
    // Step 2 → step 3.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(within(drawer).getByText('View users')).toBeInTheDocument());
    // All 10 module sections render (fixed catalog order). Some labels
    // intentionally repeat (e.g. "View audit log" is both a module and the
    // audit:view point), so match by presence rather than uniqueness.
    for (const label of [
      'User management',
      'Role management',
      'Department management',
      'Models & keys',
      'Provider keys',
      'Skill management',
      'View audit log',
      'Version management',
      'MCP management',
      'Agent management',
    ]) {
      expect(within(drawer).getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
    // Per-action checkboxes from the fine-grained catalog.
    expect(within(drawer).getByText('Adjust department members')).toBeInTheDocument();
    expect(within(drawer).getByText('Rotate provider keys')).toBeInTheDocument();
    expect(within(drawer).getByText('Publish agents')).toBeInTheDocument();
  });

  test('selecting the custom department scope reveals the dept multi-select', async () => {
    mockMeFirst([builtinRole]);
    // Lazy dept fetch fires only once custom_dept_tree is selected in step 2.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(deptForest), { status: 200 }));
    render(wrap(<RolesPage />));
    await waitFor(() => expect(screen.getByText('Organization admin')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Edit'));
    const drawer = await screen.findByTestId('role-drawer');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(within(drawer).getByText('Custom department scope')).toBeInTheDocument());
    fireEvent.click(within(drawer).getByRole('radio', { name: 'Custom department scope' }));
    await waitFor(() =>
      expect(within(drawer).getByText('Select departments in scope')).toBeInTheDocument()
    );
    // The lazy dept fetch resolves after the multi-select label appears.
    await waitFor(() => expect(within(drawer).getByText('Root/Eng')).toBeInTheDocument());
  });

  test('hides the add button and card actions without the fine role points', async () => {
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'u1', orgId: 'o1', roles: ['user'] } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    // Viewer-only profile: role:view but no create/edit/delete points.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          username: 'bob',
          display_name: 'Bob',
          permissions: ['role:view'],
          effectiveDataScope: 'self',
        }),
        { status: 200 }
      )
    );
    render(wrap(<RolesPage />));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('+ New role')).toBeNull();
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Copy')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
  });
});
