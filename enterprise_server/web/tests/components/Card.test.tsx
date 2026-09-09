import { fireEvent,render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { Card } from '../../src/components/Card';
import { EmptyState } from '../../src/components/EmptyState';

describe('components/Card', () => {
  test('renders header + children when header provided', () => {
    render(
      <Card header="Title here">
        <p>body</p>
      </Card>
    );
    expect(screen.getByText('Title here')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  test('renders children without header', () => {
    render(
      <Card>
        <p>only body</p>
      </Card>
    );
    expect(screen.getByText('only body')).toBeInTheDocument();
  });

  test('onClick fires when card is interactive', () => {
    const onClick = vi.fn();
    render(
      <Card onClick={onClick}>
        <p>clickable</p>
      </Card>
    );
    fireEvent.click(screen.getByText('clickable'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('components/EmptyState', () => {
  test('renders title + description + optional action', () => {
    render(
      <EmptyState
        title="Nothing here"
        description="Try adding something"
        action={<button>Add</button>}
      />
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Try adding something')).toBeInTheDocument();
    expect(screen.getByText('Add')).toBeInTheDocument();
  });

  test('title-only is fine', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.getByText('Empty')).toBeInTheDocument();
  });
});