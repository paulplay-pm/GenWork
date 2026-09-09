import type { JSX } from 'react';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';

import type { Connector } from '../../../src/api/connectors';
import { t } from '../../../src/i18n';
import { ConnectorCardGrid, type ConnectorTypeFilter } from '../../../src/pages/mcpManage/ConnectorCardGrid';

const mcpConn: Connector = {
  id: 'c1', serverKey: 'search', nameEn: 'Search', nameZh: '搜索', version: '1.0.0',
  categoryId: 'cat1', description: 'Web search', connectorType: 'mcp',
  url: 'https://example.com/mcp', transport: 'http', authMode: 'user-key',
  authConfig: {}, secretMeta: null, authStatus: 'configured', enabled: true,
  scope: { allCompany: false, deptIds: ['rd'], userIds: [] }, scopeSummary: 'depts:1',
  tools: [], toolCount: 12, hasDraft: false,
  lastTestAt: null, lastTestStatus: null, lastLatencyMs: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

const appConn: Connector = {
  ...mcpConn,
  id: 'c2', serverKey: 'crm', nameEn: 'CRM', nameZh: 'CRM', version: '2.3.1',
  description: 'CRM app connector', connectorType: 'app', url: 'https://example.com/app',
  authMode: 'sso', toolCount: 0,
};

/** Stateful wrapper so the type-filter chips behave like the page. */
function Harness({ connectors }: { connectors: Connector[] }): JSX.Element {
  const [filter, setFilter] = useState<ConnectorTypeFilter>('all');
  return (
    <ConnectorCardGrid
      connectors={connectors}
      typeFilter={filter}
      onTypeFilter={setFilter}
      categoryName="搜索"
      count={connectors.length}
      onOpen={() => {}}
      onToggle={() => {}}
      onMenuOpen={() => {}}
    />
  );
}

describe('ConnectorCardGrid', () => {
  test('renders the three type-filter chips', () => {
    render(<Harness connectors={[mcpConn, appConn]} />);
    expect(screen.getByRole('button', { name: t('mcp.typeFilter.all') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('mcp.typeFilter.mcp') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('mcp.typeFilter.app') })).toBeInTheDocument();
  });

  test('selecting the MCP chip hides app connectors and vice versa', async () => {
    const user = userEvent.setup();
    render(<Harness connectors={[mcpConn, appConn]} />);
    expect(screen.getByText('search')).toBeInTheDocument();
    expect(screen.getByText('crm')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: t('mcp.typeFilter.mcp') }));
    expect(screen.getByText('search')).toBeInTheDocument();
    expect(screen.queryByText('crm')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: t('mcp.typeFilter.app') }));
    expect(screen.queryByText('search')).not.toBeInTheDocument();
    expect(screen.getByText('crm')).toBeInTheDocument();
  });

  test('renders the empty state when the filter yields no connectors', () => {
    render(
      <ConnectorCardGrid
        connectors={[mcpConn]}
        typeFilter="app"
        onTypeFilter={() => {}}
        categoryName="搜索"
        count={1}
        onOpen={() => {}}
        onToggle={() => {}}
        onMenuOpen={() => {}}
      />,
    );
    expect(screen.getByText(t('mcp.connEmpty'))).toBeInTheDocument();
    expect(screen.queryByText('search')).not.toBeInTheDocument();
  });
});
