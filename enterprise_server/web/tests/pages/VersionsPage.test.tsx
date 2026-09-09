import { beforeEach,describe, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent,render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { useAuthStore } from '../../src/auth/store';
import { VersionsPage } from '../../src/pages/VersionsPage';

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/config/versions']}>
        <VersionsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('pages/VersionsPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] },
    });
  });

  test('renders empty state when there are no releases', async () => {
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 }));
    renderPage();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.getByText(/Versions|版本/i)).toBeInTheDocument();
  });

  test('lists releases with version + latest badge', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([
        {
          id: 'r1',
          version: '1.2.0',
          published_at: '2026-08-27T00:00:00Z',
          change_log: { zh: { title: 'zh', content: ['a'] } },
          installers: { macArm: { id: 'file-1', fileName: 'GenWork.dmg', fileSize: 100, sha256: 's' } },
          enabled: true,
          is_latest: true,
        },
      ]), { status: 200 })
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('1.2.0')).toBeInTheDocument();
    });
    expect(screen.getByText(/Latest|最新/i)).toBeInTheDocument();
  });

  test('add button opens drawer; submit POSTs to /admin/releases', async () => {
    const installerFile = new File([new Uint8Array(32)], 'GenWork.dmg', {
      type: 'application/x-apple-diskimage',
    });
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 })); // initial list
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: 'up-1', chunkSize: 65536 }), { status: 200 })
    ); // installer upload init
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ totalAccepted: 32 }), { status: 200 })
    ); // installer chunk PUT
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 'file-1', fileName: 'GenWork.dmg', fileSize: 32, sha256: 's' }),
        { status: 200 }
      )
    ); // installer upload complete
    fetchMock.mockResolvedValueOnce(new Response('{"id":"new-id"}', { status: 200 })); // POST
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 })); // refetch
    renderPage();
    await waitFor(() => fetchMock.mock.calls.length >= 1);
    const addBtn = screen.getByRole('button', { name: /Add|新增/i });
    fireEvent.click(addBtn);
    // The drawer has a Save button. Field names come from the page implementation;
    // assert a call whose URL is '/admin/releases'.
    const versionInput = await screen.findByPlaceholderText(/1\.0\.0/i);
    fireEvent.change(versionInput, { target: { value: '2.0.0' } });
    // Creating a release requires at least one installer, so upload the
    // macOS file before saving.
    const macInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!macInput) throw new Error('expected the installer file input to be present');
    Object.defineProperty(macInput, 'files', {
      value: [installerFile],
      configurable: true,
    });
    fireEvent.change(macInput);
    await screen.findByText(/Uploaded: GenWork|已上传/i);
    const saveBtn = screen.getByRole('button', { name: /Save|保存/i });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      const calls = (fetchMock.mock.calls as Array<[string, RequestInit]>)
        .filter(([url]) => url.endsWith('/admin/releases'));
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  test('opens the drawer with two installer uploaders', async () => {
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 }));
    renderPage();
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    const addBtn = screen.getByRole('button', { name: /Add|新增/i });
    fireEvent.click(addBtn);
    await waitFor(() => {
      expect(screen.getByText(/Apple Silicon|macOS/i)).toBeInTheDocument();
      expect(screen.getByText(/Windows \(x64\)|Windows/i)).toBeInTheDocument();
    });
  });

  test('F3: file input value resets so picking the same File twice fires onPick twice', async () => {
    const installerFile = new File([new Uint8Array(32)], 'GenWork.dmg', {
      type: 'application/x-apple-diskimage',
    });
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 })); // initial list
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ uploadId: 'up-1', chunkSize: 65536 }), { status: 200 })
    ); // installer upload init
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ totalAccepted: 32 }), { status: 200 })
    ); // installer chunk PUT
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'file-1', fileName: 'GenWork.dmg', fileSize: 32, sha256: 's' }),
        { status: 200 }
      )
    ); // installer upload complete
    renderPage();
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    fireEvent.click(screen.getByRole('button', { name: /Add|新增/i }));
    const macInput = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!el) throw new Error('expected the installer file input to be present');
      return el;
    });
    Object.defineProperty(macInput, 'files', { value: [installerFile], configurable: true });
    fireEvent.change(macInput);
    await waitFor(() => { expect(macInput.value).toBe(''); });
    // Re-select the SAME File instance; without the F3 fix the change event
    // would not fire because the input's value would still equal the previous
    // selection.
    Object.defineProperty(macInput, 'files', { value: [installerFile], configurable: true });
    fireEvent.change(macInput);
    await waitFor(() => {
      const initCalls = (fetchMock.mock.calls as Array<[string, RequestInit]>).filter(
        ([url, init]) =>
          typeof url === 'string' &&
          url.includes('/admin/releases/installers/init') &&
          (init?.method ?? 'GET').toUpperCase() === 'POST'
      );
      // Without the fix we'd see at most 1 init call here; with the fix we see
      // at least 2 (the input.reset + re-fire path).
      expect(initCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('F1: done state shows filename + humanized fileSize', async () => {
    const installerFile = new File([new Uint8Array(100)], 'GenWork.dmg', {
      type: 'application/x-apple-diskimage',
    });
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 })); // initial list
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ uploadId: 'up-1', chunkSize: 65536 }), { status: 200 })
    ); // installer upload init
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ totalAccepted: 100 }), { status: 200 })
    ); // installer chunk PUT
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 'file-1', fileName: 'GenWork.dmg', fileSize: 100, sha256: 's' }),
        { status: 200 }
      )
    ); // installer upload complete
    renderPage();
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    fireEvent.click(screen.getByRole('button', { name: /Add|新增/i }));
    const macInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!macInput) throw new Error('expected the installer file input to be present');
    Object.defineProperty(macInput, 'files', { value: [installerFile], configurable: true });
    fireEvent.change(macInput);
    // The done-state row should show both the filename AND a humanized size.
    await waitFor(() => {
      expect(screen.getByText(/Uploaded: GenWork\.dmg \(100 B\)/i)).toBeInTheDocument();
    });
  });
});
