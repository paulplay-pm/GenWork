import { fireEvent,render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { DataTable } from '../../src/components/DataTable';

interface Row {
  id: string;
  name: string;
}

describe('components/DataTable', () => {
  test('renders rows', () => {
    render(<DataTable<Row> columns={[{ key: 'name', header: 'Name' }]} rows={[{ id: '1', name: 'Alice' }]} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
  test('shows empty message', () => {
    render(<DataTable<Row> columns={[{ key: 'name', header: 'Name' }]} rows={[]} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });
  test('loading state', () => {
    render(<DataTable<Row> columns={[{ key: 'name', header: 'Name' }]} rows={[]} loading />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });
  test('row click fires callback', () => {
    const onClick = vi.fn();
    render(<DataTable<Row> columns={[{ key: 'name', header: 'Name' }]} rows={[{ id: '1', name: 'A' }]} onRowClick={onClick} />);
    fireEvent.click(screen.getByText('A'));
    expect(onClick).toHaveBeenCalledWith({ id: '1', name: 'A' });
  });
});