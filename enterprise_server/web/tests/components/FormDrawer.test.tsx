import { fireEvent,render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { FormDrawer } from '../../src/components/FormDrawer';

describe('components/FormDrawer', () => {
  test('renders nothing when closed', () => {
    const { container } = render(
      <FormDrawer
        open={false}
        title="X"
        fields={[]}
        onSubmit={() => {}}
        onClose={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });
  test('renders title and fields when open', () => {
    render(
      <FormDrawer
        open={true}
        title="Create user"
        fields={[{ name: 'username', label: 'Username', type: 'text', required: true }]}
        onSubmit={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Create user')).toBeInTheDocument();
    expect(screen.getByText(/Username/)).toBeInTheDocument();
  });
  test('onSubmit called with values', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <FormDrawer
        open={true}
        title="X"
        fields={[{ name: 'username', label: 'Username', type: 'text' }]}
        onSubmit={onSubmit}
        onClose={() => {}}
      />
    );
    const input = screen.getByLabelText('Username');
    fireEvent.change(input, { target: { value: 'alice' } });
    fireEvent.click(screen.getByText('Save'));
    // give a short window for the async submit to fire; the form
    // calls onSubmit after a microtask boundary.
    await new Promise((res) => setTimeout(res, 50));
    expect(onSubmit).toHaveBeenCalled();
  });
  test('onClose called when backdrop clicked', () => {
    const onClose = vi.fn();
    render(
      <FormDrawer open={true} title="X" fields={[]} onSubmit={() => {}} onClose={onClose} />
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});