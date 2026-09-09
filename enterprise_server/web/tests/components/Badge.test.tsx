import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { Badge } from '../../src/components/Badge';

describe('components/Badge', () => {
  test('renders children with tone class', () => {
    render(<Badge tone="success">active</Badge>);
    const el = screen.getByText('active');
    expect(el).toBeInTheDocument();
    expect(el.className).toMatch(/bg-\[var\(--success-light\)\]/);
  });

  test('renders danger tone in red', () => {
    render(<Badge tone="danger">disabled</Badge>);
    const el = screen.getByText('disabled');
    expect(el.className).toMatch(/bg-\[var\(--danger-light\)\]/);
  });

  test('renders info tone in sky', () => {
    render(<Badge tone="info">configured</Badge>);
    const el = screen.getByText('configured');
    expect(el.className).toMatch(/bg-\[var\(--accent-light\)\]/);
  });
});
