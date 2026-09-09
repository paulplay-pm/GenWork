import { beforeEach, describe, expect, test, vi } from 'vitest';
const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useAuthStore } from '../../../src/auth/store';
import { useToastStore } from '../../../src/components/toastStore';
import { setLang } from '../../../src/i18n';
import { SkillManagePage } from '../../../src/pages/SkillManagePage';

function seedFetch(): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/skills')) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes('/categories')) return new Response(JSON.stringify([
      { id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized', display_order: 9999 },
    ]), { status: 200 });
    if (url.includes('/roles/vocabulary')) return new Response(JSON.stringify({ roles: ['super_admin', 'org_admin', 'user'] }), { status: 200 });
    return new Response('{}', { status: 200 });
  });
}

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><SkillManagePage /></MemoryRouter></QueryClientProvider>);
}

describe('SkillManagePage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useAuthStore.setState({ token: 'jwt', claims: { sub: 'a', orgId: 'o1', roles: ['org_admin'] } });
    // jsdom reports navigator.language = 'en-US'; the assertions below are
    // written against the zh dictionary, so pin the locale explicitly.
    setLang('zh');
    seedFetch();
  });

  test('renders the skillmgmt title and the uncategorized category', async () => {
    renderPage();
    expect(await screen.findByText('技能管理')).toBeInTheDocument();
    expect(await screen.findByText('未分类')).toBeInTheDocument();
  });

  test('new category posts to the admin route', async () => {
    let posted = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/categories') && init?.method === 'POST') { posted = true; return new Response('{}', { status: 200 }); }
      if (url.includes('/skills')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('/categories')) return new Response(JSON.stringify([
        { id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized', display_order: 9999 }]), { status: 200 });
      if (url.includes('/roles/vocabulary')) return new Response(JSON.stringify({ roles: ['org_admin'] }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    renderPage();
    await screen.findByText(/新增分类/i);
    fireEvent.click(screen.getByRole('button', { name: /新增分类/i }));
    const input = await screen.findByLabelText(/新增分类/i);
    fireEvent.change(input, { target: { value: '设计' } });
    fireEvent.click(screen.getByRole('button', { name: /确定|确认|Confirm/i }));
    await waitFor(() => expect(posted).toBe(true));
  });

  // Two-stage create: select a zip → parseZip returns the name/version +
  // tempToken → save posts the tempToken (never a hand-typed name/id) to
  // POST /skills with the org-scoped scope shape.
  test('create parses the zip then posts the tempToken to /skills', async () => {
    let postedBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // URL trap: /skills/parse-zip contains /skills — match it FIRST.
      if (url.includes('/skills/parse-zip') && init?.method === 'POST') {
        return new Response(JSON.stringify({ name: 'TestSkill', version: '1.0.0', size: 100, sha256: 'abc', tempToken: 'tok123' }), { status: 200 });
      }
      if (url.includes('/skills') && init?.method === 'POST') {
        postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ skill_id: 'TestSkill' }), { status: 200 });
      }
      if (url.includes('/skills')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('/categories')) return new Response(JSON.stringify([
        { id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized', display_order: 9999 },
      ]), { status: 200 });
      if (url.includes('/admin/departments')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('/admin/users')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    renderPage();
    // Two '+ 添加技能' buttons exist (header + table empty state); use the header one.
    const addBtn = (await screen.findAllByRole('button', { name: /添加技能/ }))[0];
    fireEvent.click(addBtn);
    // The drawer opens with the zip-first 技能包 section; pick a package.
    const fileInput = await screen.findByLabelText(/上传安装包（.zip）/);
    fireEvent.change(fileInput, { target: { files: [new File(['zip-bytes'], 'pkg.zip', { type: 'application/zip' })] } });
    await screen.findByText('正在解析技能包…');
    await screen.findByText('已解析 TestSkill · v1.0.0');
    // The skill name is read-only (from the parse); only the zh name is typed.
    fireEvent.change(await screen.findByLabelText('名称（中文）'), { target: { value: '测试技能' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(postedBody).not.toBeNull());
    expect(postedBody).toEqual({
      tempToken: 'tok123',
      nameZh: '测试技能',
      category_id: 'uncategorized',
      scope: { allCompany: false, deptIds: [], userIds: [] },
    });
    expect(postedBody).not.toHaveProperty('skill_id');
    expect(postedBody).not.toHaveProperty('allowed_roles');
    // The drawer closes after a successful create.
    await waitFor(() => expect(screen.queryByLabelText(/上传安装包（.zip）/)).not.toBeInTheDocument());
  });

  // Edit: the drawer pre-fills from the SkillAdmin row and saves as a PATCH
  // of the org-scoped wire shape (nameZh/scope/…), never the removed
  // name_en/version/source/allowed_roles fields.
  test('edit drawer PATCHes the org-scoped shape without role fields', async () => {
    let patchBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/skills/parse-zip') && init?.method === 'POST') {
        return new Response(JSON.stringify({ name: 'Canvas', version: '2.0.0', size: 5, sha256: 'x', tempToken: 't9' }), { status: 200 });
      }
      if (url.includes('/skills') && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response('{}', { status: 200 });
      }
      if (url.includes('/skills')) return new Response(JSON.stringify([
        {
          id: 'sk1', name: 'Canvas', name_zh: '画布', description: 'd', category: 'uncategorized',
          version: '1.0.0', icon: null,
          scope: { allCompany: true, deptIds: [], userIds: [] }, scopeSummary: '全公司',
          zip: { fileName: 'canvas.zip', fileSize: 123 }, enabled: true, useCount30d: 3,
          updatedAt: '2026-09-01T00:00:00Z', createdBy: 'u1', updatedBy: 'u1',
        },
      ]), { status: 200 });
      if (url.includes('/categories')) return new Response(JSON.stringify([
        { id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized', display_order: 9999 },
      ]), { status: 200 });
      if (url.includes('/admin/departments')) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes('/admin/users')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    renderPage();
    // Open the row's edit drawer.
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    const nameZhInput = await screen.findByLabelText('名称（中文）');
    expect(nameZhInput).toHaveValue('画布');
    fireEvent.change(nameZhInput, { target: { value: '画布2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(patchBody).not.toBeNull());
    expect(patchBody).toEqual(expect.objectContaining({
      nameZh: '画布2',
      category_id: 'uncategorized',
      scope: { allCompany: true, deptIds: [], userIds: [] },
    }));
    expect(patchBody).not.toHaveProperty('name_en');
    expect(patchBody).not.toHaveProperty('version');
    expect(patchBody).not.toHaveProperty('source');
    expect(patchBody).not.toHaveProperty('allowed_roles');
    expect(patchBody).not.toHaveProperty('skill_id');
    // The drawer closes after a successful save.
    await waitFor(() => expect(screen.queryByLabelText('名称（中文）')).not.toBeInTheDocument());
  });

  // R63a: the delete flow must invalidate (refetch /skills) ONLY on a
  // successful DELETE. Success → success toast + row disappears; 500 →
  // error toast, the row stays, and the modal stays open for a retry.
  const SKILL_ROW = {
    id: 'sk1', name: 'Canvas', name_zh: '画布', description: 'd', category: 'uncategorized',
    version: '1.0.0', icon: null,
    scope: { allCompany: true, deptIds: [], userIds: [] }, scopeSummary: '全公司',
    zip: { fileName: 'canvas.zip', fileSize: 123 }, enabled: true, useCount30d: 3,
    updatedAt: '2026-09-01T00:00:00Z', createdBy: 'u1', updatedBy: 'u1',
  };

  const toastTexts = (): string[] => useToastStore.getState().toasts.map((t) => t.text);

  test('delete: confirm calls DELETE and invalidates on success', async () => {
    useToastStore.setState({ toasts: [] });
    let deleted = false;
    let deleteUrl: string | null = null;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // DELETE /skills/<id> — match the method before the /skills GET trap.
      if (init?.method === 'DELETE' && url.includes('/skills/')) {
        deleteUrl = url;
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (url.includes('/skills')) return new Response(JSON.stringify(deleted ? [] : [SKILL_ROW]), { status: 200 });
      if (url.includes('/categories')) return new Response(JSON.stringify([
        { id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized', display_order: 9999 },
      ]), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    renderPage();
    // Open the row's delete modal from the 删除 action.
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    // The impact modal shows; its confirm button is 确认删除.
    const confirmBtn = await screen.findByRole('button', { name: '确认删除' });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(deleteUrl).toBe('/api/admin/skill-marketplace/skills/sk1'));
    // Success toast, and the row disappears (invalidate refetched /skills → []).
    await waitFor(() => expect(toastTexts()).toContain('技能已删除'));
    await waitFor(() => expect(screen.queryByText('画布')).not.toBeInTheDocument());
    // The modal closes after a successful delete.
    expect(screen.queryByRole('button', { name: '确认删除' })).not.toBeInTheDocument();
  });

  test('delete: a 500 DELETE keeps the row and leaves the modal open', async () => {
    useToastStore.setState({ toasts: [] });
    let deleteCalled = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE' && url.includes('/skills/')) {
        deleteCalled = true;
        return new Response(JSON.stringify({ error: 'db down' }), { status: 500 });
      }
      if (url.includes('/skills')) return new Response(JSON.stringify([SKILL_ROW]), { status: 200 });
      if (url.includes('/categories')) return new Response(JSON.stringify([
        { id: 'uncategorized', name_zh: '未分类', name_en: 'Uncategorized', display_order: 9999 },
      ]), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteCalled).toBe(true));
    // Error toast (ApiError → 'http 500 db down').
    await waitFor(() => expect(toastTexts().some((t) => t.includes('http 500'))).toBe(true));
    // No success toast, the row is still there (no invalidate on failure)…
    expect(toastTexts()).not.toContain('技能已删除');
    expect(screen.getByText('画布')).toBeInTheDocument();
    // …and the modal is still open for a retry.
    expect(screen.getByRole('button', { name: '确认删除' })).toBeInTheDocument();
  });
});
