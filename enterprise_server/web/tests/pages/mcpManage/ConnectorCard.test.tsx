import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import type { Connector } from '../../../src/api/connectors';
import { t } from '../../../src/i18n';
import { ConnectorCard } from '../../../src/pages/mcpManage/ConnectorCard';
import { fill } from '../../../src/pages/mcpManage/types';

const base: Connector = {
  id: 'c1', serverKey: 'search', nameEn: 'Search', nameZh: '搜索', version: '1.0.0',
  categoryId: 'cat1', description: 'Web search', connectorType: 'mcp',
  url: 'https://example.com/mcp', transport: 'http', authMode: 'user-key',
  authConfig: {}, secretMeta: null, authStatus: 'configured', enabled: true,
  scope: { allCompany: false, deptIds: ['rd'], userIds: [] }, scopeSummary: 'depts:1',
  tools: [], toolCount: 12, hasDraft: false,
  lastTestAt: null, lastTestStatus: null, lastLatencyMs: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

const conn = (o: Partial<Connector> = {}): Connector => ({ ...base, ...o });

describe('ConnectorCard', () => {
  test('renders the server key (monospace), display name, auth-mode tag and version', () => {
    render(<ConnectorCard c={conn()} onOpen={() => {}} onToggle={() => {}} onMenu={() => {}} />);
    const key = screen.getByText('search');
    expect(key.tagName).toBe('CODE');
    expect(key.className).toContain('font-mono');
    // Display name prefers the Chinese name (rendered in the title; the initials
    // badge repeats it, so pin the assertion to the <strong> title element).
    expect(screen.getByText('搜索', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(t('mcp.auth.userKey'))).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
  });

  test('renders the tool-count tag with the connector count', () => {
    render(<ConnectorCard c={conn({ toolCount: 12 })} onOpen={() => {}} onToggle={() => {}} onMenu={() => {}} />);
    expect(screen.getByText(fill(t('mcp.tools.count'), { n: 12 }))).toBeInTheDocument();
  });

  test('renders the draft tag only when hasDraft is true', () => {
    const { rerender } = render(<ConnectorCard c={conn({ hasDraft: false })} onOpen={() => {}} onToggle={() => {}} onMenu={() => {}} />);
    expect(screen.queryByText(t('mcp.draft.tag'))).not.toBeInTheDocument();
    rerender(<ConnectorCard c={conn({ hasDraft: true })} onOpen={() => {}} onToggle={() => {}} onMenu={() => {}} />);
    expect(screen.getByText(t('mcp.draft.tag'))).toBeInTheDocument();
  });

  test('renders the auth-pending tag only when authStatus is pending', () => {
    const { rerender } = render(<ConnectorCard c={conn({ authStatus: 'configured' })} onOpen={() => {}} onToggle={() => {}} onMenu={() => {}} />);
    expect(screen.queryByText(t('mcp.auth.pending'))).not.toBeInTheDocument();
    rerender(<ConnectorCard c={conn({ authStatus: 'pending' })} onOpen={() => {}} onToggle={() => {}} onMenu={() => {}} />);
    expect(screen.getByText(t('mcp.auth.pending'))).toBeInTheDocument();
  });

  test('renders no usage metrics (calls / error rate / 30-day window)', () => {
    render(<ConnectorCard c={conn()} onOpen={() => {}} onToggle={() => {}} onMenu={() => {}} />);
    expect(screen.queryByText(/调用量|错误率|近\s*30\s*天|30[-\s]?day|error rate/i)).not.toBeInTheDocument();
  });

  test('clicking the enable switch calls onToggle with the inverted value and does not open', async () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorCard c={conn({ enabled: true })} onOpen={onOpen} onToggle={onToggle} onMenu={() => {}} />);
    await user.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('c1', false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('clicking the ⋯ button calls onMenu and does not open the card', async () => {
    const onOpen = vi.fn();
    const onMenu = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorCard c={conn()} onOpen={onOpen} onToggle={() => {}} onMenu={onMenu} />);
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(onMenu).toHaveBeenCalledTimes(1);
    const [event, id] = onMenu.mock.calls[0];
    // The prop is a React MouseEvent: the synthetic event wraps the native one.
    expect(event.nativeEvent).toBeInstanceOf(Event);
    expect(id).toBe('c1');
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('Enter on the focused card body opens the detail', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<ConnectorCard c={conn()} onOpen={onOpen} onToggle={() => {}} onMenu={() => {}} />);
    const card = container.querySelector('[role="button"]') as HTMLElement;
    card.focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('c1');
  });

  test('Space on the focused switch toggles but does not open the card (target guard)', async () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorCard c={conn({ enabled: true })} onOpen={onOpen} onToggle={onToggle} onMenu={() => {}} />);
    const sw = screen.getByRole('switch');
    sw.focus();
    await user.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('c1', false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('members-only scope renders the member count and no zero-department count', () => {
    render(<ConnectorCard c={conn({ scope: { allCompany: false, deptIds: [], userIds: ['u1'] } })} onOpen={() => {}} onToggle={() => {}} onMenu={() => {}} />);
    expect(screen.getByText(fill(t('mcp.scope.users'), { m: 1 }))).toBeInTheDocument();
    expect(screen.queryByText(/0 departments|0 个部门/)).not.toBeInTheDocument();
  });
});
