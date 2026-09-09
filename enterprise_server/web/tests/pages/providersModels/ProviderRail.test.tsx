import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ProviderRail } from '../../../src/pages/providersModels/ProviderRail';

const mk = (over: Partial<import('../../../src/api/providers').ProviderKeyView> = {}) => ({
  id: 'id',
  provider: 'openai',
  endpoint: null,
  label: 'OpenAI',
  enabled: true,
  region: 'global' as const,
  default_base_url: null,
  website: null,
  description: null,
  api_key_masked: null,
  status: 'connected' as const,
  latency_ms: null,
  last_test_at: null,
  created_at: '2026-01-01T00:00:00Z',
  is_builtin: true,
  protocol: 'openai' as const,
  coding_plan: false,
  ...over,
});

const providers = [
  mk({ id: 'p1', provider: 'openai', label: 'OpenAI', is_builtin: true }),
  mk({ id: 'p2', provider: 'vllm', label: 'vllm', is_builtin: false, status: 'failed' }),
];

const renderRail = (props: Partial<Parameters<typeof ProviderRail>[0]> = {}) =>
  render(
    <ProviderRail
      providers={providers}
      modelCounts={{}}
      selectedId={null}
      onSelect={() => {}}
      canManage={true}
      onDeleteProvider={vi.fn()}
      onToggleProvider={vi.fn()}
      {...props}
    />
  );

describe('pages/providersModels/ProviderRail', () => {
  test('renders both sections', () => {
    renderRail();
    expect(screen.getByPlaceholderText(/Search/i)).toBeInTheDocument();
    expect(screen.getByText(/Built-in/)).toBeInTheDocument();
    expect(screen.getByText(/OpenAI/)).toBeInTheDocument();
    expect(screen.getByText(/vllm/)).toBeInTheDocument();
  });

  test('filters by search text', () => {
    renderRail();
    fireEvent.change(screen.getByPlaceholderText(/Search/i), {
      target: { value: 'vll' },
    });
    expect(screen.queryByText(/OpenAI/)).not.toBeInTheDocument();
    expect(screen.getByText(/vllm/)).toBeInTheDocument();
  });

  test('clicking a row invokes onSelect', () => {
    const onSelect = vi.fn();
    renderRail({ onSelect });
    fireEvent.click(screen.getByText(/OpenAI/));
    expect(onSelect).toHaveBeenCalledWith('p1');
  });

  test('hides add provider button when canManage is false', () => {
    renderRail({ canManage: false });
    expect(screen.queryByText(/add provider/i)).not.toBeInTheDocument();
  });

  test('shows model count badge per provider', () => {
    renderRail({ modelCounts: { openai: 5, vllm: 1 } });
    // The OpenAI row should show "5", the vllm row should show "1".
    const openaiRow = screen.getByText(/OpenAI/).closest('[role="button"]');
    expect(openaiRow).not.toBeNull();
    expect(openaiRow).toHaveTextContent('5');
    const vllmRow = screen.getByText(/^vllm$/).closest('[role="button"]');
    expect(vllmRow).not.toBeNull();
    expect(vllmRow).toHaveTextContent('1');
  });

  test('defaults missing count to 0', () => {
    renderRail({ providers: [providers[0]], modelCounts: {} });
    const openaiRow = screen.getByText(/OpenAI/).closest('[role="button"]');
    expect(openaiRow).toHaveTextContent('0');
  });
});
