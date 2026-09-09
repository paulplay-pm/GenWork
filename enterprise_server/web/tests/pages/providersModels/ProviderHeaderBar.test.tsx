import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ProviderHeaderBar } from '../../../src/pages/providersModels/ProviderHeaderBar';

const baseProvider = {
  id: 'p1',
  provider: 'openai',
  endpoint: 'https://api.openai.com/v1',
  label: 'OpenAI',
  enabled: true,
  region: 'global' as const,
  default_base_url: 'https://api.openai.com/v1',
  website: null,
  description: null,
  api_key_masked: 'sk-…abcd',
  status: 'connected' as const,
  latency_ms: 142,
  last_test_at: null,
  created_at: '2026-01-01T00:00:00Z',
  is_builtin: false,
  protocol: 'openai' as const,
  coding_plan: false,
};

describe('pages/providersModels/ProviderHeaderBar', () => {
  test('shows provider label, base url, and custom tag', () => {
    render(
      <ProviderHeaderBar
        provider={baseProvider}
        canManage={true}
        busy={false}
        onTest={() => {}}
        onSave={() => {}}
      />
    );
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('https://api.openai.com/v1')).toBeInTheDocument();
    // Custom tag for a non-built-in provider.
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  test('shows the built-in tag and the not-configured hint when endpoint is empty', () => {
    render(
      <ProviderHeaderBar
        provider={{ ...baseProvider, endpoint: null, is_builtin: true }}
        canManage={true}
        busy={false}
        onTest={() => {}}
        onSave={() => {}}
      />
    );
    expect(screen.getByText('Built-in')).toBeInTheDocument();
    expect(screen.getByText('Provider has no Base URL configured')).toBeInTheDocument();
  });

  test('invokes onTest when test button clicked', () => {
    const onTest = vi.fn();
    render(
      <ProviderHeaderBar
        provider={baseProvider}
        canManage={true}
        busy={false}
        onTest={onTest}
        onSave={() => {}}
      />
    );
    const testBtn = screen.getByRole('button', { name: /Test connection/i });
    fireEvent.click(testBtn);
    expect(onTest).toHaveBeenCalledWith('p1');
  });

  test('invokes onSave when save button clicked', () => {
    const onSave = vi.fn();
    render(
      <ProviderHeaderBar
        provider={baseProvider}
        canManage={true}
        busy={false}
        onTest={() => {}}
        onSave={onSave}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    expect(onSave).toHaveBeenCalledWith('p1');
  });

  test('hides save when canManage is false and never renders a delete button', () => {
    render(
      <ProviderHeaderBar
        provider={baseProvider}
        canManage={false}
        busy={false}
        onTest={() => {}}
        onSave={() => {}}
      />
    );
    // No Save button when canManage is false.
    expect(screen.queryByRole('button', { name: /Save/i })).toBeNull();
    // Delete moved to the rail: nothing delete-shaped in the header.
    expect(screen.queryByLabelText(/Delete/i)).toBeNull();
  });

  test('disables buttons while busy', () => {
    render(
      <ProviderHeaderBar
        provider={baseProvider}
        canManage={true}
        busy={true}
        onTest={() => {}}
        onSave={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: /Test connection/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save/i })).toBeDisabled();
  });
});
