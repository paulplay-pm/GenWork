import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { InfoGrid } from '../../src/components/InfoGrid';

describe('components/InfoGrid', () => {
  test('renders all item labels and values', () => {
    render(<InfoGrid items={[{ label: 'Endpoint', value: 'https://api.deepseek.com' }]} />);
    expect(screen.getByText('Endpoint')).toBeInTheDocument();
    expect(screen.getByText('https://api.deepseek.com')).toBeInTheDocument();
  });

  test('default is 3 columns', () => {
    const { container } = render(
      <InfoGrid items={[{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]} />
    );
    expect((container.firstChild as HTMLElement).className).toMatch(/grid-cols-3/);
  });

  test('columns=2 uses two-col layout', () => {
    const { container } = render(
      <InfoGrid columns={2} items={[{ label: 'A', value: 'a' }]} />
    );
    expect((container.firstChild as HTMLElement).className).toMatch(/grid-cols-2/);
  });

  test('columns=4 uses four-col layout', () => {
    const { container } = render(
      <InfoGrid columns={4} items={[{ label: 'A', value: 'a' }]} />
    );
    expect((container.firstChild as HTMLElement).className).toMatch(/grid-cols-4/);
  });

  test('renders values with mono font', () => {
    render(
      <InfoGrid items={[{ label: 'ID', value: 'deepseek' }]} />
    );
    const valueEl = screen.getByText('deepseek');
    expect(valueEl.className).toMatch(/font-mono/);
  });

  test('uses token border color for grid lines', () => {
    const { container } = render(
      <InfoGrid items={[{ label: 'A', value: 'a' }]} />
    );
    expect((container.firstChild as HTMLElement).className).toMatch(/bg-\[var\(--border-subtle\)\]/);
  });
});
