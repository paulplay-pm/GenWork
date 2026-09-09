import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import { Switch } from '../../src/components/Switch';

describe('components/Switch', () => {
  test('exposes role=switch with the accessible label and off state', () => {
    render(<Switch checked={false} onChange={() => {}} label="服务商已启用" />);
    const sw = screen.getByRole('switch', { name: '服务商已启用' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  test('reflects on state', () => {
    render(<Switch checked onChange={() => {}} label="on" />);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  test('clicking fires onChange with the inverted value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch checked={false} onChange={onChange} label="toggle" />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test('does not fire onChange when disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Switch checked={false} onChange={onChange} label="toggle" disabled />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('on state applies the accent track class', () => {
    const { container } = render(<Switch checked onChange={() => {}} label="x" />);
    expect(container.querySelector('button')?.className).toMatch(/bg-\[var\(--accent-primary\)\]/);
  });
});
