import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { StatusDot } from '../../src/components/StatusDot';

describe('components/StatusDot', () => {
  test('renders connected variant with success token', () => {
    const { container } = render(<StatusDot status="connected" />);
    const dot = container.querySelector('span');
    expect(dot).not.toBeNull();
    expect(dot!.className).toMatch(/success-primary/);
  });

  test('renders failed variant with danger token', () => {
    const { container } = render(<StatusDot status="failed" />);
    const dot = container.querySelector('span');
    expect(dot).not.toBeNull();
    expect(dot!.className).toMatch(/danger-primary/);
  });

  test('renders unknown variant with tertiary text token', () => {
    const { container } = render(<StatusDot status="unknown" />);
    const dot = container.querySelector('span');
    expect(dot).not.toBeNull();
    expect(dot!.className).toMatch(/text-tertiary/);
  });
});
