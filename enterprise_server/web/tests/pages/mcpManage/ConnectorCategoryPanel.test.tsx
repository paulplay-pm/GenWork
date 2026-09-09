import type { JSX } from 'react';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import { t } from '../../../src/i18n';
import { ConnectorCategoryPanel, type ConnectorCategory } from '../../../src/pages/mcpManage/ConnectorCategoryPanel';

const categories: ConnectorCategory[] = [
  { id: 'cat1', name: 'Search' },
  { id: 'cat2', name: 'Data' },
];
const counts = { cat1: 3, cat2: 4 };

const noopPanelProps = {
  categories,
  counts,
  total: 7,
  current: 'all' as const,
  onSelect: () => {},
  onAdd: () => {},
};

/** Stateful wrapper so the controlled search input behaves like the page. */
function Harness(): JSX.Element {
  const [q, setQ] = useState('');
  return <ConnectorCategoryPanel {...noopPanelProps} search={q} onSearch={setQ} />;
}

describe('ConnectorCategoryPanel', () => {
  test('renders the All row with the total and each category row with its count', () => {
    render(<ConnectorCategoryPanel {...noopPanelProps} search="" onSearch={() => {}} />);
    const allRow = screen.getByText(t('mcp.all')).closest('button') as HTMLElement;
    expect(within(allRow).getByText('7')).toBeInTheDocument();
    const searchRow = screen.getByText('Search').closest('button') as HTMLElement;
    expect(within(searchRow).getByText('3')).toBeInTheDocument();
    const dataRow = screen.getByText('Data').closest('button') as HTMLElement;
    expect(within(dataRow).getByText('4')).toBeInTheDocument();
  });

  test('typing in the search input filters the category rows by name', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText(t('mcp.categorySearch'));
    await user.type(input, 'sear');
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.queryByText('Data')).not.toBeInTheDocument();
    // The All row is always shown, filtered or not.
    expect(screen.getByText(t('mcp.all'))).toBeInTheDocument();
  });

  test('clicking the add-category button fires onAdd', async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorCategoryPanel {...noopPanelProps} onAdd={onAdd} search="" onSearch={() => {}} />);
    await user.click(screen.getByText(t('mcp.addCategory')));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
