import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { useAuthStore } from '../../src/auth/store';
import { clearMeProfileCache } from '../../src/auth/useMe';
import { UsersPage } from '../../src/pages/UsersPage';

const wrap = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
};

const meFull = {
  username: 'alice',
  display_name: 'Alice',
  permissions: ['user:view', 'user:create', 'user:edit', 'user:export', 'role:view'],
  effectiveDataScope: 'all',
};

const userRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'u-bob',
  org_id: 'o1',
  username: 'bob',
  display_name: 'Bob',
  email: 'bob@corp.example',
  phone: null,
  position: 'Engineer',
  level: 'P6',
  department_id: 'd2',
  primary_dept_name: 'Eng',
  timezone: null,
  extra_roles: ['user', 'auditor'],
  status: 'active',
  joined_at: '2026-01-05T00:00:00Z',
  last_login_at: null,
  created_at: '2026-08-26T00:00:00Z',
  ...overrides,
});

const roles = [
  {
    id: 'r-user',
    name: 'user',
    displayName: 'Member',
    description: null,
    permissions: [],
    dataScope: 'self',
    customDeptIds: [],
    isBuiltin: true,
    memberCount: 9,
  },
  {
    id: 'r-auditor',
    name: 'auditor',
    displayName: 'Auditor',
    description: null,
    permissions: ['audit:view'],
    dataScope: 'org_wide',
    customDeptIds: [],
    isBuiltin: false,
    memberCount: 2,
  },
];

const depts = [
  {
    id: 'd1',
    name: 'Root',
    code: 'ROOT',
    parent_id: null,
    path: '/Root',
    leader_id: null,
    sort: 0,
    description: null,
    directMembers: 0,
    subtreeMembers: 5,
    children: [
      {
        id: 'd2',
        name: 'Eng',
        code: 'ENG',
        parent_id: 'd1',
        path: '/Root/Eng',
        leader_id: null,
        sort: 0,
        description: null,
        directMembers: 5,
        subtreeMembers: 5,
        children: [],
      },
    ],
  },
];

/** The `/me` fetch is deferred one tick behind the page's own queries, so the
 * users / roles / departments mocks must be queued before the `/me` mock. */
const mockPageData = (me: object = meFull, rows: unknown[] = [userRow()]): void => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(rows), { status: 200 }));
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(roles), { status: 200 }));
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(depts), { status: 200 }));
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(me), { status: 200 }));
};

describe('pages/UsersPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // Session-scoped /me cache: each test starts from a fresh session so the
    // deferred GET /me actually fires (and lands on the mock queued here).
    clearMeProfileCache();
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] },
    });
  });

  test('lists users and renders role chips with the data-scope suffix', async () => {
    mockPageData();
    render(wrap(<UsersPage />));
    await screen.findByText('bob');
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('bob@corp.example')).toBeInTheDocument();
    // The primary-dept cell (the filter select also lists 'Eng' as an option).
    expect(within(screen.getByRole('table')).getByText('Eng')).toBeInTheDocument();
    // Role chips carry the role's data-scope label as a suffix ("code · scope").
    expect(screen.getByText('auditor')).toBeInTheDocument();
    expect(screen.getByText(/Organization-wide/)).toBeInTheDocument();
    expect(screen.getByText(/Self only/)).toBeInTheDocument();
    // Localized status pill (the filter select also lists 'Active' as an option).
    expect(within(screen.getByRole('table')).getByText('Active')).toBeInTheDocument();
  });

  test('shows the filter bar and the gated export/import/create actions', async () => {
    mockPageData();
    render(wrap(<UsersPage />));
    await screen.findByText('bob');
    expect(
      screen.getByPlaceholderText('Search username, name or email')
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Department' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Role' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ New user' })).toBeInTheDocument();
  });

  test('selecting a row reveals the batch bar with the four actions; clearing hides it', async () => {
    mockPageData();
    render(wrap(<UsersPage />));
    await screen.findByText('bob');
    // No selection yet → no batch bar.
    expect(screen.queryByText('1 selected')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'bob' }));
    await screen.findByText('1 selected');
    expect(screen.getByRole('button', { name: 'Assign roles' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adjust department' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable/Disable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset passwords' })).toBeInTheDocument();
  });

  test('batch reset POSTs the action and surfaces the returned temp passwords', async () => {
    mockPageData();
    render(wrap(<UsersPage />));
    await screen.findByText('bob');
    fireEvent.click(screen.getByRole('checkbox', { name: 'bob' }));
    await screen.findByText('1 selected');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          affected: 1,
          tempPasswords: [{ username: 'bob', tempPassword: 'batch-temp-77' }],
        }),
        { status: 200 }
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset passwords' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/admin/users/batch'))
      ).toBe(true)
    );
    expect(await screen.findByText('batch-temp-77')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/admin/users/batch')
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.action).toBe('reset_password');
    expect(body.userIds).toEqual(['u-bob']);
  });

  test('create drawer shows the org and role sections (chips with scope + union/intersection hint)', async () => {
    mockPageData();
    render(wrap(<UsersPage />));
    await screen.findByText('bob');
    fireEvent.click(screen.getByRole('button', { name: '+ New user' }));
    const drawer = await screen.findByTestId('user-drawer');
    expect(within(drawer).getByText('Basic information')).toBeInTheDocument();
    expect(within(drawer).getByText('Organization')).toBeInTheDocument();
    expect(within(drawer).getByText('Roles & permissions')).toBeInTheDocument();
    // Primary-dept tree select lists the department forest (the concurrent
    // dept chips repeat the names, so match the <option> role specifically).
    expect(within(drawer).getByRole('option', { name: 'Root' })).toBeInTheDocument();
    expect(within(drawer).getByRole('option', { name: 'Eng' })).toBeInTheDocument();
    // Role chips carry the data-scope label.
    expect(within(drawer).getByText('auditor')).toBeInTheDocument();
    expect(within(drawer).getByText(/Organization-wide/)).toBeInTheDocument();
    // The union-of-points / intersection-of-scopes explainer line.
    expect(within(drawer).getByText(/union/)).toBeInTheDocument();
    expect(within(drawer).getByText(/intersection/)).toBeInTheDocument();
  });

  test('creating a user surfaces the returned temp password in-app', async () => {
    mockPageData();
    render(wrap(<UsersPage />));
    await screen.findByText('bob');
    fireEvent.click(screen.getByRole('button', { name: '+ New user' }));
    const drawer = await screen.findByTestId('user-drawer');
    fireEvent.change(within(drawer).getByLabelText('Username'), {
      target: { value: 'carol' },
    });
    fireEvent.change(within(drawer).getByLabelText('Primary department'), {
      target: { value: 'd1' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: /auditor/ }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'u-carol', tempPassword: 'Caro-Temp-1234' }), {
        status: 200,
      })
    );
    fireEvent.click(within(drawer).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) => String(c[0]).endsWith('/admin/users') && (c[1] as RequestInit).method === 'POST'
        )
      ).toBe(true)
    );
    expect(await screen.findByText('Caro-Temp-1234')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith('/admin/users') && (c[1] as RequestInit).method === 'POST'
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.username).toBe('carol');
    expect(body.primaryDeptId).toBe('d1');
    expect(body.roles).toEqual(['auditor']);
    // Server-generated password: the create body carries no password.
    expect(body.password).toBeUndefined();
    // Canonical wire keys only (no legacy departmentId/extraRoles).
    expect(body.departmentId).toBeUndefined();
    expect(body.extraRoles).toBeUndefined();
  });

  test('reset password surfaces the server-generated temp password (no client password input)', async () => {
    mockPageData();
    render(wrap(<UsersPage />));
    await screen.findByText('bob');
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ tempPassword: 'bob-temp-9x2k' }), { status: 200 })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/reset-password'))
      ).toBe(true)
    );
    // The returned temp password is shown in-app, once.
    expect(await screen.findByText('bob-temp-9x2k')).toBeInTheDocument();
    // No second password input is offered — the server generates it.
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  test('gates Create on the fine user:create point, not the coarse org_admin role', async () => {
    // Coarse role says org_admin, but /me carries no user:create.
    mockPageData({
      username: 'alice',
      display_name: 'Alice',
      permissions: ['user:view', 'user:edit'],
      effectiveDataScope: 'all',
    });
    render(wrap(<UsersPage />));
    // Wait for /me to land: user:edit present → the row actions render…
    await screen.findByRole('button', { name: 'Reset password' });
    // …but without user:create there is no Create (or Import/Export).
    expect(screen.queryByRole('button', { name: '+ New user' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  test('hides the row enable/disable/reset affordances and the batch bar without user:edit', async () => {
    mockPageData({
      username: 'alice',
      display_name: 'Alice',
      permissions: ['user:view', 'user:create', 'user:export'],
      effectiveDataScope: 'all',
    });
    render(wrap(<UsersPage />));
    // Wait for /me to land: user:create present → the Create button renders.
    await screen.findByRole('button', { name: '+ New user' });
    expect(screen.queryByRole('button', { name: /Disable/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Enable/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reset password/i })).toBeNull();
    // Selecting a row still does not reveal the batch bar: every batch action
    // requires user:edit server-side, so the bar hides for non-editors.
    fireEvent.click(screen.getByRole('checkbox', { name: 'bob' }));
    await waitFor(() =>
      expect((screen.getByRole('checkbox', { name: 'bob' }) as HTMLInputElement).checked).toBe(
        true
      )
    );
    expect(screen.queryByText('1 selected')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Assign roles' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adjust department' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable/Disable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset passwords' })).toBeNull();
  });

  test('shows a green Enable (not Disable) for a disabled user', async () => {
    mockPageData(meFull, [userRow({ status: 'disabled' })]);
    render(wrap(<UsersPage />));
    await screen.findByText('bob');
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disable/i })).toBeNull();
  });

  test('disabling goes through the in-app confirm dialog and POSTs to /disable', async () => {
    mockPageData();
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(wrap(<UsersPage />));
    await screen.findByText('bob');
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    expect(await screen.findByText('Disable "bob"?')).toBeInTheDocument();
    // The dialog's confirm button is a second "Disable" — pick the last one.
    const dialogConfirm = screen.getAllByRole('button', { name: 'Disable' }).pop()!;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    fireEvent.click(dialogConfirm);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/disable'))
      ).toBe(true)
    );
    expect(nativeConfirm).not.toHaveBeenCalled();
    nativeConfirm.mockRestore();
  });

  test('Enable POSTs to the enable endpoint', async () => {
    mockPageData(meFull, [userRow({ status: 'disabled' })]);
    render(wrap(<UsersPage />));
    const enableBtn = await screen.findByRole('button', { name: 'Enable' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    fireEvent.click(enableBtn);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/enable'))
      ).toBe(true)
    );
  });

  test('import dialog uploads the CSV, POSTs /import and reports the result', async () => {
    mockPageData();
    render(wrap(<UsersPage />));
    await screen.findByText('bob');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByTestId('import-dialog');
    const csv = [
      'username,display_name,email',
      'alice2,Alice,alice2@corp.example',
      ',,,',
    ].join('\n');
    const file = new File([csv], 'users.csv', { type: 'text/csv' });
    fireEvent.change(within(dialog).getByLabelText('Choose CSV file'), {
      target: { files: [file] },
    });
    // The file text is read asynchronously (FileReader) — wait for the
    // import button to become enabled before clicking.
    const importBtn = within(dialog).getByRole('button', { name: 'Import' });
    await waitFor(() => expect((importBtn as HTMLButtonElement).disabled).toBe(false));
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1,
          skipped: 1,
          errors: [{ row: 3, reason: 'username required' }],
          tempPasswords: [{ username: 'alice2', tempPassword: 'imp-pw-99' }],
        }),
        { status: 200 }
      )
    );
    fireEvent.click(importBtn);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/admin/users/import'))
      ).toBe(true)
    );
    expect(await screen.findByText(/1 created, 1 skipped/)).toBeInTheDocument();
    expect(screen.getByText(/Row 3: username required/)).toBeInTheDocument();
    expect(screen.getByText('imp-pw-99')).toBeInTheDocument();
    // The POST body carries the orgId and the raw CSV text.
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/admin/users/import')
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.orgId).toBe('o1');
    expect(String(body.csv)).toContain('alice2');
  });

  test('partial import failure still reports the created users and their temp passwords', async () => {
    mockPageData();
    render(wrap(<UsersPage />));
    await screen.findByText('bob');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByTestId('import-dialog');
    const file = new File(
      [
        [
          'username,display_name,email',
          'dave,Dave,dave@corp.example',
        ].join('\n'),
      ],
      'users.csv',
      { type: 'text/csv' }
    );
    fireEvent.change(within(dialog).getByLabelText('Choose CSV file'), {
      target: { files: [file] },
    });
    const importBtn = within(dialog).getByRole('button', { name: 'Import' });
    await waitFor(() => expect((importBtn as HTMLButtonElement).disabled).toBe(false));
    // The server commits per row: a mid-import failure returns 500 with the
    // partial result — the client must still surface it (temp passwords are
    // one-time only).
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'partial_import_failed',
          created: 1,
          skipped: 1,
          errors: [{ row: 2, reason: 'internal_error' }],
          tempPasswords: [{ username: 'dave', tempPassword: 'part-pw-42' }],
        }),
        { status: 500 }
      )
    );
    fireEvent.click(importBtn);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/admin/users/import'))
      ).toBe(true)
    );
    // The result report renders from the error body, with the partial note.
    expect(await screen.findByText(/partially failed/i)).toBeInTheDocument();
    expect(screen.getByText(/1 created, 1 skipped/)).toBeInTheDocument();
    expect(screen.getByText('part-pw-42')).toBeInTheDocument();
  });
});
