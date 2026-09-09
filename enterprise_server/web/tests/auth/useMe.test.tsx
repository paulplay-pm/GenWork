import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useAuthStore } from '../../src/auth/store';
import { clearMeProfileCache } from '../../src/auth/useMe';
import { usePermissions } from '../../src/auth/usePermissions';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

function Probe() {
  const { hasPermission } = usePermissions();
  return <div data-testid="probe">{hasPermission('dept:view') ? 'granted' : 'denied'}</div>;
}

describe('auth/useMe', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // Session-scoped module state: each test starts from a fresh session.
    clearMeProfileCache();
    useAuthStore.setState({
      token: 'jwt',
      claims: { sub: 'u1', orgId: 'o1', roles: ['org_admin'] },
    });
  });

  test('two usePermissions consumers in one tree share a single /me fetch', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          username: 'alice',
          display_name: 'Alice',
          permissions: ['dept:view'],
          effectiveDataScope: 'all',
        }),
        { status: 200 }
      )
    );
    render(
      <div>
        <Probe />
        <Probe />
      </div>
    );
    // Both consumers mount before the deferred /me fires; the in-flight
    // promise is shared, so exactly one request is issued.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain('/me');
    await waitFor(() => expect(screen.getAllByText('granted')).toHaveLength(2));
  });

  test('a later mount uses the cache and issues no further /me fetch', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          username: 'alice',
          display_name: 'Alice',
          permissions: ['dept:view'],
          effectiveDataScope: 'all',
        }),
        { status: 200 }
      )
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('granted'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A later mount (e.g. a page opened after the sidebar resolved /me) must
    // hit the module cache — no additional network request.
    const second = render(<Probe />);
    await waitFor(() => {
      expect(second.container.textContent).toBe('granted');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
