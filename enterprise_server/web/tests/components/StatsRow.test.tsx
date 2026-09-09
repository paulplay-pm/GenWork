import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { StatsRow } from '../../src/components/StatsRow';

describe('components/StatsRow', () => {
  test('renders stat labels and values', () => {
    render(<StatsRow stats={[{ label: 'Configured models', value: 5 }]} />);
    expect(screen.getByText('Configured models')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  test('trend up uses success token color', () => {
    const { container } = render(
      <StatsRow stats={[{ label: 'L', value: 1, trend: { direction: 'up', text: '+12%' } }]} />
    );
    const trendEl = container.querySelector('[data-trend="up"]');
    expect(trendEl?.className).toMatch(/text-\[var\(--success-primary\)\]/);
  });

  test('trend down uses danger token color', () => {
    const { container } = render(
      <StatsRow stats={[{ label: 'L', value: 1, trend: { direction: 'down', text: '-8%' } }]} />
    );
    const trendEl = container.querySelector('[data-trend="down"]');
    expect(trendEl?.className).toMatch(/text-\[var\(--danger-primary\)\]/);
  });

  test('trend flat uses tertiary token color', () => {
    const { container } = render(
      <StatsRow stats={[{ label: 'L', value: 1, trend: { direction: 'flat', text: '0%' } }]} />
    );
    const trendEl = container.querySelector('[data-trend="flat"]');
    expect(trendEl?.className).toMatch(/text-\[var\(--text-tertiary\)\]/);
  });

  test('renders no trend element when trend is undefined', () => {
    const { container } = render(
      <StatsRow stats={[{ label: 'L', value: 1 }]} />
    );
    expect(container.querySelector('[data-trend]')).toBeNull();
  });
});
