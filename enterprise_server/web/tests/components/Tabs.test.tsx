import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import { Tabs } from '../../src/components/Tabs';

describe('components/Tabs', () => {
  test('renders all tab labels', () => {
    render(
      <Tabs
        items={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]}
        value="a"
        onChange={() => {}}
      />
    );
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  test('active tab has accent background and bold weight', () => {
    render(
      <Tabs
        items={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]}
        value="a"
        onChange={() => {}}
      />
    );
    const a = screen.getByText('A');
    expect(a.className).toMatch(/bg-\[var\(--accent-light\)\]/);
    expect(a.className).toMatch(/font-semibold/);
  });

  test('inactive tab has secondary text color', () => {
    render(
      <Tabs
        items={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]}
        value="a"
        onChange={() => {}}
      />
    );
    const b = screen.getByText('B');
    expect(b.className).toMatch(/text-\[var\(--text-secondary\)\]/);
  });

  test('clicking inactive tab fires onChange with that key', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Tabs
        items={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]}
        value="a"
        onChange={onChange}
      />
    );
    await user.click(screen.getByText('B'));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  test('clicking active tab does not fire onChange', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Tabs items={[{ key: 'a', label: 'A' }]} value="a" onChange={onChange} />
    );
    await user.click(screen.getByText('A'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
