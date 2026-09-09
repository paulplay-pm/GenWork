import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useAuthStore } from '../../src/auth/store';
import { setLang } from '../../src/i18n';
import { AgentManagePage } from '../../src/pages/AgentManagePage';

function seedFetch(): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/role-options')) return new Response(JSON.stringify({ roles: ['super_admin', 'org_admin', 'agent_admin', 'policy_admin'] }), { status: 200 });
    if (url.includes('/admin/agent-marketplace/agents')) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes('/admin/skill-marketplace/skills')) return new Response(JSON.stringify([]), { status: 200 });
    return new Response('{}', { status: 200 });
  });
}

interface SeedOpts {
  refs?: { ids: string[]; names: string[] };
  providers?: unknown[];
}

function seedAgents(agents: unknown[], opts: SeedOpts = {}): void {
  const refs = opts.refs ?? { ids: [], names: [] };
  const providers = opts.providers ?? [];
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/role-options')) return new Response(JSON.stringify({ roles: ['org_admin', 'agent_admin'] }), { status: 200 });
    // references (delete pre-check) — must match before the generic agents list.
    if (url.includes('/references')) return new Response(JSON.stringify(refs), { status: 200 });
    if (url.includes('/admin/provider-keys')) return new Response(JSON.stringify(providers), { status: 200 });
    if (url.includes('/admin/agent-marketplace/agents')) return new Response(JSON.stringify(agents), { status: 200 });
    if (url.includes('/admin/skill-marketplace/skills')) return new Response(JSON.stringify([]), { status: 200 });
    return new Response('{}', { status: 200 });
  });
}

function seedListError(): void {
  // Reject ONLY the admin agents-list endpoint. The page fires several
  // queries concurrently (agents list, skills picker, role options), so a
  // blanket mockRejectedValueOnce could land on a different query.
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/admin/agent-marketplace/agents')) return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    if (url.includes('/role-options')) return new Response(JSON.stringify({ roles: ['org_admin'] }), { status: 200 });
    if (url.includes('/admin/skill-marketplace/skills')) return new Response(JSON.stringify([]), { status: 200 });
    return new Response('{}', { status: 200 });
  });
}

function seedListForbidden(): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/admin/agent-marketplace/agents')) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    if (url.includes('/role-options')) return new Response(JSON.stringify({ roles: ['org_admin'] }), { status: 200 });
    if (url.includes('/admin/skill-marketplace/skills')) return new Response(JSON.stringify([]), { status: 200 });
    return new Response('{}', { status: 200 });
  });
}

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><AgentManagePage /></MemoryRouter></QueryClientProvider>);
}

function findCall(method: string, urlPart: string): boolean {
  return fetchMock.mock.calls.some((c) => {
    const init = (c[1] ?? {}) as RequestInit;
    return String(c[0]).includes(urlPart) && String(init.method ?? '').toUpperCase() === method;
  });
}

function putBodyFor(agentId: string): unknown | undefined {
  const hit = fetchMock.mock.calls.find((c) => {
    const init = (c[1] ?? {}) as RequestInit;
    return String(c[0]).includes(`/agents/${agentId}`) && String(init.method ?? '').toUpperCase() === 'PUT';
  });
  return hit ? JSON.parse(String((hit[1] as RequestInit).body)) : undefined;
}

function reviewerAgent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 'agent_1', name: 'Reviewer', description: 'd', identity: '', systemPrompt: '',
    model: 'gpt-5', thinkingLevel: '', icon: '', skillIds: ['s1', 's2'], subagentAllowAgentIds: ['sub1'],
    allowedRoles: ['org_admin', 'agent_admin'], enabled: true, aboutYou: '', iconColor: 0, ...over,
  };
}

describe('AgentManagePage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'a', orgId: 'o1', roles: ['agent_admin'] } });
    // jsdom reports navigator.language = 'en-US'; the assertions below are
    // written against the zh dictionary, so pin the locale explicitly.
    setLang('zh');
    seedFetch();
  });

  test('renders the agentmgmt title and the empty state', async () => {
    renderPage();
    expect(await screen.findByText('智能体管理')).toBeInTheDocument();
    expect(await screen.findByText(/暂无智能体/)).toBeInTheDocument();
  });

  test('+ add button opens the create drawer', async () => {
    renderPage();
    const addBtn = await screen.findByRole('button', { name: /新增智能体/ });
    fireEvent.click(addBtn);
    // The drawer now overlays the list, so assert the create drawer's save
    // button (创建智能体; it reads 保存 in edit mode) instead of a heading.
    expect(await screen.findByRole('button', { name: '创建智能体' })).toBeInTheDocument();
  });

  test('card shows the agent model', async () => {
    seedAgents([reviewerAgent({ model: 'myorg/claude-opus' })]);
    renderPage();
    expect(await screen.findByText('myorg/claude-opus')).toBeInTheDocument();
  });

  test('card resolves the model chip to vendor label + model id', async () => {
    seedAgents(
      [reviewerAgent({ model: 'myorg/claude-opus' })],
      { providers: [{ id: 'pk_myorg', provider: 'myorg', label: 'My Vendor' }] },
    );
    renderPage();
    // The vendor's 模型配置 label replaces the raw provider slug.
    expect(await screen.findByText('My Vendor · claude-opus')).toBeInTheDocument();
    // ...and the raw slug is no longer shown.
    expect(screen.queryByText('myorg/claude-opus')).toBeNull();
  });

  test('card model chip falls back to the raw ref when the provider is unknown', async () => {
    // No provider-keys seeded → the query returns {} (non-array) → raw ref.
    seedAgents([reviewerAgent({ model: 'myorg/claude-opus' })]);
    renderPage();
    expect(await screen.findByText('myorg/claude-opus')).toBeInTheDocument();
  });

  test('card shows count chips for model / roles / skills / subagents', async () => {
    seedAgents([reviewerAgent()]); // model gpt-5, 2 roles, 2 skills, 1 subagent
    renderPage();
    expect(await screen.findByText('gpt-5')).toBeInTheDocument();
    expect(await screen.findByText('角色 2')).toBeInTheDocument();
    expect(await screen.findByText('技能 2')).toBeInTheDocument();
    expect(await screen.findByText('子代理 1')).toBeInTheDocument();
  });

  test('a disabled card shows the disabled chip', async () => {
    seedAgents([reviewerAgent({ enabled: false })]);
    renderPage();
    expect(await screen.findByText('已禁用')).toBeInTheDocument();
  });

  test('no-icon agent renders without an <img>', async () => {
    seedAgents([reviewerAgent({ icon: '' })]);
    renderPage();
    await screen.findByText('Reviewer');
    expect(document.querySelector('img')).toBeNull();
  });

  test('the enable switch turns an agent on with a direct PUT', async () => {
    seedAgents([reviewerAgent({ enabled: false })]);
    renderPage();
    const sw = await screen.findByRole('switch', { checked: false });
    fireEvent.click(sw);
    await waitFor(() => expect(putBodyFor('agent_1')).toEqual({ enabled: true }));
  });

  test('disabling an enabled agent shows a confirm popover, then PUT enabled:false', async () => {
    seedAgents([reviewerAgent({ enabled: true })]);
    renderPage();
    const sw = await screen.findByRole('switch', { checked: true });
    fireEvent.click(sw);
    // The disable popover (light confirm) appears anchored to the card;
    // no PUT is issued until the admin confirms in it.
    const confirm = await screen.findByRole('button', { name: '确定禁用' });
    expect(putBodyFor('agent_1')).toBeUndefined();
    fireEvent.click(confirm);
    await waitFor(() => expect(putBodyFor('agent_1')).toEqual({ enabled: false }));
  });

  test('deleting shows the reference list then DELETE on confirm', async () => {
    // references endpoint returns one referrer by name.
    seedAgents([reviewerAgent()], { refs: { ids: ['a2'], names: ['数据分析员'] } });
    renderPage();
    const del = await screen.findByRole('button', { name: '删除' });
    fireEvent.click(del);
    await waitFor(() => expect(findCall('GET', '/references')).toBe(true));
    // The dialog message names the referrers, not just the count.
    expect(screen.getByText(/数据分析员/)).toBeInTheDocument();
    const delBtns = screen.getAllByRole('button', { name: '删除' });
    fireEvent.click(delBtns[delBtns.length - 1]);
    await waitFor(() => expect(findCall('DELETE', '/agents/agent_1')).toBe(true));
  });

  test('closing a dirty drawer prompts to discard', async () => {
    seedAgents([reviewerAgent()]);
    renderPage();
    fireEvent.click((await screen.findByText('Reviewer')).closest('[data-testid="agent-card"]') as HTMLElement);
    const name = await screen.findByRole('textbox', { name: /Agent 名称/i });
    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    expect(await screen.findByText('放弃未保存的更改？')).toBeInTheDocument();
  });

  test('the card is clickable and opens the drawer', async () => {
    seedAgents([reviewerAgent()]);
    renderPage();
    const card = (await screen.findByText('Reviewer')).closest('[data-testid="agent-card"]') as HTMLElement;
    fireEvent.click(card);
    // The page opens the unified tabbed AgentDrawer; the identity tab
    // (助手身份) is rendered in the tab bar.
    expect(await screen.findByText('助手身份')).toBeInTheDocument();
  });

  test('a disabled card is dimmed and carries the agent-card testid', async () => {
    seedAgents([reviewerAgent({ enabled: false })]);
    renderPage();
    const chip = await screen.findByText('已禁用');
    const card = chip.closest('[data-testid="agent-card"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.className).toContain('opacity-');
  });

  test('delete runs the reference check and deletes on confirm', async () => {
    seedAgents([reviewerAgent()]);
    renderPage();
    const cardDelete = await screen.findByRole('button', { name: '删除' });
    fireEvent.click(cardDelete);
    // reference pre-check was issued and the confirm dialog appeared.
    await waitFor(() => expect(findCall('GET', '/references')).toBe(true));
    expect(await screen.findByText('删除智能体「Reviewer」？')).toBeInTheDocument();
    // Two 删除 buttons now (card + dialog confirm); the dialog's is last.
    const delBtns = screen.getAllByRole('button', { name: '删除' });
    fireEvent.click(delBtns[delBtns.length - 1]);
    await waitFor(() => expect(findCall('DELETE', '/agents/agent_1')).toBe(true));
  });

  test('shows a no-result state when the search matches nothing', async () => {
    seedAgents([reviewerAgent()]);
    renderPage();
    const input = (await screen.findByRole('searchbox')) as HTMLInputElement;
    // Fake timers make the 300 ms debounce deterministic: advance exactly
    // 300 ms and assert synchronously, independent of CI load.
    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: 'zzz-nope' } });
      await act(async () => { vi.advanceTimersByTime(300); });
      expect(screen.getByText(/未找到/)).toBeInTheDocument();
      // The input's × and the no-result panel's clear button both use the
      // 清除搜索 label; the panel's is last in DOM order (same convention as
      // the delete test above). Clicking it resets the search immediately.
      const clearBtns = screen.getAllByRole('button', { name: '清除搜索' });
      fireEvent.click(clearBtns[clearBtns.length - 1]);
      expect(screen.getByText('Reviewer')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('shows the error state with a retry button when the list query fails', async () => {
    seedListError();
    renderPage();
    expect(await screen.findByText('加载失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  test('shows the no-access state without a retry button on a 403', async () => {
    seedListForbidden();
    renderPage();
    expect(await screen.findByText('你无权访问智能体管理')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });
});
