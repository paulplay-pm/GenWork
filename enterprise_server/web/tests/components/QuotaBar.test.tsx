import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { QuotaBar } from '../../src/components/QuotaBar';

describe('components/QuotaBar', () => {
  test('renders used/quota text', () => {
    render(<QuotaBar used={50} quota={100} />);
    expect(screen.getByText('50 / 100')).toBeInTheDocument();
  });
  test('red bar when at warning threshold', () => {
    const { container } = render(<QuotaBar used={95} quota={100} />);
    expect(container.querySelector('.bg-\\[var\\(--danger-primary\\)\\]')).not.toBeNull();
  });
  test('yellow bar between 0.7 and warning', () => {
    const { container } = render(<QuotaBar used={80} quota={100} />);
    expect(container.querySelector('.bg-\\[var\\(--warning-primary\\)\\]')).not.toBeNull();
  });
});
