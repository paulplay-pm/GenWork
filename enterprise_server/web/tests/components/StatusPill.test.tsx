import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { StatusPill } from '../../src/components/StatusPill';

describe('components/StatusPill', () => {
  test('renders children inside a rounded pill', () => {
    const { container } = render(<StatusPill tone="active">running</StatusPill>);
    const root = container.firstChild as HTMLElement;
    expect(root.textContent).toContain('running');
    expect(root.className).toMatch(/rounded-full/);
    expect(root.className).toMatch(/inline-flex/);
  });

  test('active tone uses success token', () => {
    const { container } = render(<StatusPill tone="active">running</StatusPill>);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/text-\[var\(--success-primary\)\]/);
  });

  test('disabled tone uses neutral text', () => {
    const { container } = render(<StatusPill tone="disabled">off</StatusPill>);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/text-\[var\(--text-tertiary\)\]/);
  });

  test('error tone uses danger token', () => {
    const { container } = render(<StatusPill tone="error">fail</StatusPill>);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/text-\[var\(--danger-primary\)\]/);
  });

  test('renders a colored dot before children', () => {
    const { container } = render(<StatusPill tone="warning">warn</StatusPill>);
    const dot = container.querySelector('span > span');
    expect(dot).not.toBeNull();
    expect(dot?.className).toMatch(/rounded-full/);
  });
});