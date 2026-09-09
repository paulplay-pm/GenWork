import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pencil, Trash2 } from 'lucide-react';
import { describe, expect, test, vi } from 'vitest';

import { IconButton } from '../../src/components/IconButton';

describe('components/IconButton', () => {
  test('renders label as title and aria-label', () => {
    render(
      <IconButton label="Edit">
        <Pencil />
      </IconButton>
    );
    const btn = screen.getByRole('button', { name: 'Edit' });
    expect(btn.getAttribute('title')).toBe('Edit');
  });

  test('danger variant applies danger hover classes', () => {
    const { container } = render(
      <IconButton label="Delete" variant="danger">
        <Trash2 />
      </IconButton>
    );
    const btn = container.querySelector('button');
    expect(btn?.className).toMatch(/hover:bg-\[var\(--danger-light\)\]/);
    expect(btn?.className).toMatch(/hover:text-\[var\(--danger-primary\)\]/);
  });

  test('default variant applies hover classes without danger', () => {
    const { container } = render(
      <IconButton label="Edit">
        <Pencil />
      </IconButton>
    );
    const btn = container.querySelector('button');
    expect(btn?.className).toMatch(/hover:bg-\[var\(--bg-hover\)\]/);
    expect(btn?.className).not.toMatch(/hover:text-\[var\(--danger-primary\)\]/);
  });

  test('clicking fires onClick', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <IconButton label="Edit" onClick={onClick}>
        <Pencil />
      </IconButton>
    );
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('renders 28x28 square with rounded corners', () => {
    const { container } = render(
      <IconButton label="Edit">
        <Pencil />
      </IconButton>
    );
    const btn = container.querySelector('button');
    expect(btn?.className).toMatch(/w-7/);
    expect(btn?.className).toMatch(/h-7/);
    expect(btn?.className).toMatch(/rounded-\[var\(--radius-sm\)\]/);
  });
});
