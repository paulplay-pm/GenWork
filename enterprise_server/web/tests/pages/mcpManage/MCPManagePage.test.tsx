import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import type { Connector } from '../../../src/api/connectors';
import { useAuthStore } from '../../../src/auth/store';
import { useToastStore } from '../../../src/components/toastStore';
import { t } from '../../../src/i18n';
import { fill } from '../../../src/pages/mcpManage/types';
import { MCPManagePage } from '../../../src/pages/MCPManagePage';

const conn: Connector = {
  id: 'c1', serverKey: 'search', nameEn: 'Search', nameZh: '搜索', version: '1.0.0',
  categoryId: 'cat1', description: 'Web search', connectorType: 'mcp',
  url: 'https://example.com/mcp', transport: 'http', authMode: 'user-key',
  authConfig: {}, secretMeta: null, authStatus: 'configured', enabled: true,
  scope: { allCompany: false, deptIds: ['rd'], userIds: [] }, scopeSummary: 'depts:1',
  tools: [], toolCount: 12, hasDraft: false,
  lastTestAt: null, lastTestStatus: null, lastLatencyMs: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

const user = (id: string, name: string, dept: string) => ({
  id, org_id: 'o1', username: id, display_name: name, email: null, phone: null,
  position: null, level: null, department_id: null, primary_dept_name: dept,
  timezone: null, extra_roles: [], status: 'active', joined_at: null, last_login_at: null,
});

function seedFetch(): void {
  // The page fires six GETs in parallel; match most-specific URLs first
  // (`/admin/mcp-connectors` is a prefix of categories/settings/submissions).
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/admin/mcp-connectors/categories')) {
      return new Response(JSON.stringify([{ id: 'cat1', name: 'Search' }]), { status: 200 });
    }
    if (url.includes('/admin/mcp-connectors/submissions')) {
      return new Response(JSON.stringify({
        submissions: [
          {
            id: 'sub1', name: 'Search MCP', desc: 'Web search for the org',
            authorId: 'u1', version: '1.2.0', submittedAt: '2026-09-20T08:00:00.000Z',
            status: 'pending', rejectReason: null,
            cfg: {
              serverKey: 'search-mcp', url: 'https://mcp.example.com/sse', authMode: 'none',
              scope: { allCompany: true, deptIds: [], userIds: [] }, tools: ['search', 'fetch'],
            },
            approvedConnectorId: null,
          },
          {
            id: 'sub2', name: 'Bad MCP', desc: 'Rejected one',
            authorId: 'u2', version: '0.1.0', submittedAt: '2026-09-19T08:00:00.000Z',
            status: 'rejected', rejectReason: 'incomplete config', cfg: {}, approvedConnectorId: null,
          },
        ],
        counts: { pending: 1, approved: 0, rejected: 1, withdrawn: 0 },
      }), { status: 200 });
    }
    if (url.includes('/admin/mcp-connectors/settings')) {
      return new Response(JSON.stringify({ membersCanSubmit: true }), { status: 200 });
    }
    if (url.includes('/admin/mcp-connectors')) {
      return new Response(JSON.stringify([conn]), { status: 200 });
    }
    if (url.includes('/admin/departments')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.includes('/admin/users')) {
      return new Response(JSON.stringify([user('u1', 'Alice', 'R&D'), user('u2', 'Bob', 'Sales')]), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><MCPManagePage /></MemoryRouter></QueryClientProvider>);
}

/** Wait for the connector list to land (the seeded card shows its description;
 * the name text also appears in the initials badge, so match the unique desc). */
async function awaitLoaded(): Promise<void> {
  await screen.findByText(conn.description ?? conn.nameEn ?? conn.serverKey);
}

const calledUrls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));

// Finding B1 fixtures: the LIST row (live) says a draft is staged; the
// detail endpoint returns the staged draft with the URL changed A -> B.
const DRAFT_URL = 'https://example.com/mcp-v2';
const connDraft: Connector = { ...conn, hasDraft: true };

/** Seed like `seedFetch`, but the list row has `hasDraft: true` and the
 * detail endpoint (`/admin/mcp-connectors/c1`) returns the staged draft. */
function seedFetchDraft(): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/admin/mcp-connectors/c1')) {
      // Detail: the staged (masked) draft the drawer must seed the form from.
      return new Response(JSON.stringify({
        ...connDraft,
        versions: [],
        draft: {
          url: DRAFT_URL,
          version: '1.1.0',
          nameZh: '搜索（草稿）',
          authConfig: {},
        },
      }), { status: 200 });
    }
    if (url.includes('/admin/mcp-connectors/categories')) {
      return new Response(JSON.stringify([{ id: 'cat1', name: 'Search' }]), { status: 200 });
    }
    if (url.includes('/admin/mcp-connectors/submissions')) {
      return new Response(JSON.stringify({
        submissions: [],
        counts: { pending: 0, approved: 0, rejected: 0, withdrawn: 0 },
      }), { status: 200 });
    }
    if (url.includes('/admin/mcp-connectors/settings')) {
      return new Response(JSON.stringify({ membersCanSubmit: true }), { status: 200 });
    }
    if (url.includes('/admin/mcp-connectors')) {
      return new Response(JSON.stringify([connDraft]), { status: 200 });
    }
    if (url.includes('/admin/departments')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.includes('/admin/users')) {
      return new Response(JSON.stringify([user('u1', 'Alice', 'R&D'), user('u2', 'Bob', 'Sales')]), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

describe('MCPManagePage (org connectors + review tabs)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useToastStore.setState({ toasts: [] });
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'a', orgId: 'o1', roles: ['org_admin'] } });
    seedFetch();
  });

  test('renders the two view tabs and the global setting switch', async () => {
    renderPage();
    await awaitLoaded();
    // Page title (h1; the category rail's h2 shares the same label) + the
    // two tabs (each with its count pill).
    expect(screen.getByRole('heading', { name: t('mcp.tabs.org'), level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(t('mcp.viewTab.org')) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(t('mcp.viewTab.review')) })).toBeInTheDocument();
    // The global "members can submit" switch (settings say on).
    expect(screen.getByRole('switch', { name: t('mcp.globalSetting.title') })).toHaveAttribute('aria-checked', 'true');
  });

  test('switching to the review tab shows the submissions table with per-status rows', async () => {
    const u = userEvent.setup();
    renderPage();
    await awaitLoaded();

    await u.click(screen.getByRole('button', { name: new RegExp(t('mcp.viewTab.review')) }));
    expect(await screen.findByText('Search MCP')).toBeInTheDocument();
    expect(screen.getByText('Bad MCP')).toBeInTheDocument();

    // Author resolution from the member list (name + dept).
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('R&D')).toBeInTheDocument();

    // Pending row: 通过 · 驳回; rejected row: 详情 + the inline rejection reason.
    expect(screen.getByRole('button', { name: t('mcp.review.approve') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('mcp.review.actionReject') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('mcp.review.detail') })).toBeInTheDocument();
    expect(
      screen.getByText(fill(t('mcp.review.rejectReasonLabel'), { reason: 'incomplete config' })),
    ).toBeInTheDocument();
  });

  test('the Add connector button opens the create drawer', async () => {
    const u = userEvent.setup();
    renderPage();
    await awaitLoaded();

    // The header button and the grid button share the label; the header one
    // comes first in the DOM.
    const addButtons = screen.getAllByRole('button', { name: t('mcp.addConnector') });
    expect(addButtons.length).toBeGreaterThanOrEqual(1);
    await u.click(addButtons[0]);
    expect(await screen.findByText(t('mcpDrawer.create.title'))).toBeInTheDocument();
  });

  test('the edit drawer seeds the form from the staged draft and shows the unpublished-changes banner', async () => {
    const u = userEvent.setup();
    seedFetchDraft();
    renderPage();
    await awaitLoaded();

    // Open the edit drawer via the connector card (role=button).
    await u.click(screen.getByRole('button', { name: new RegExp(conn.description ?? '') }));
    // The 存草稿 footer button only exists in edit mode — the drawer is open.
    expect(await screen.findByRole('button', { name: t('mcpDrawer.footer.saveDraft') })).toBeInTheDocument();

    // The banner keys off the (synchronous) list row's hasDraft.
    expect(screen.getByText(t('mcp.draft.banner'))).toBeInTheDocument();

    // The URL input is prefilled with the DRAFT's url (B), not the live one
    // (A) — once the detail fetch lands, the pristine form re-seeds from the
    // draft. (If the form stayed live-seeded the value would be conn.url.)
    const urlInput = await screen.findByLabelText(t('mcpDrawer.url'));
    await waitFor(() => expect(urlInput).toHaveValue(DRAFT_URL));
    expect(urlInput).not.toHaveValue(conn.url);

    // The draft's other staged fields land too (version / nameZh).
    expect(await screen.findByLabelText(t('mcpDrawer.version'))).toHaveValue('1.1.0');
    expect(screen.getByLabelText(t('mcpDrawer.nameZh'))).toHaveValue('搜索（草稿）');

    // The detail fetch did actually hit the detail endpoint (not the list).
    expect(calledUrls()).toContain('/admin/mcp-connectors/c1');
  });

  test('approving a pending submission posts to the approve route', async () => {
    const u = userEvent.setup();
    renderPage();
    await awaitLoaded();

    await u.click(screen.getByRole('button', { name: new RegExp(t('mcp.viewTab.review')) }));
    await u.click(await screen.findByRole('button', { name: t('mcp.review.approve') }));

    await waitFor(() => {
      expect(calledUrls()).toContain('/admin/mcp-connectors/submissions/sub1/approve');
    });
  });

  test('rejecting with an empty reason is blocked with a toast and no API call', async () => {
    const u = userEvent.setup();
    renderPage();
    await awaitLoaded();

    await u.click(screen.getByRole('button', { name: new RegExp(t('mcp.viewTab.review')) }));
    await u.click(await screen.findByRole('button', { name: t('mcp.review.actionReject') }));
    const modal = await screen.findByRole('dialog');

    // Confirm with the textarea still empty: toast, modal stays, no POST.
    await u.click(within(modal).getByRole('button', { name: t('mcp.review.reject.confirm') }));
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts.some((x) => x.kind === 'error' && x.text === t('mcp.review.reject.empty'))).toBe(true);
    });
    expect(calledUrls()).not.toContain('/admin/mcp-connectors/submissions/sub1/reject');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('rejecting with a reason posts it', async () => {
    const u = userEvent.setup();
    renderPage();
    await awaitLoaded();

    await u.click(screen.getByRole('button', { name: new RegExp(t('mcp.viewTab.review')) }));
    await u.click(await screen.findByRole('button', { name: t('mcp.review.actionReject') }));
    const modal = await screen.findByRole('dialog');

    await u.type(within(modal).getByLabelText(t('mcp.review.reject.intro')), 'incomplete config');
    await u.click(within(modal).getByRole('button', { name: t('mcp.review.reject.confirm') }));

    await waitFor(() => {
      expect(calledUrls()).toContain('/admin/mcp-connectors/submissions/sub1/reject');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
