import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import { setLang } from '../../src/i18n';
import { ProviderRail } from '../../src/pages/providersModels/ProviderRail';

const mk = (over: Partial<import('../../src/api/providers').ProviderKeyView> = {}) => ({
  id: 'id', provider: 'openai', endpoint: 'https://api.openai.com/v1', label: 'OpenAI',
  enabled: true, region: null, default_base_url: null, website: null, description: null,
  api_key_masked: 'sk-••••••••a93f', status: 'unknown' as const, latency_ms: null, last_test_at: null,
  created_at: '', is_builtin: true, protocol: 'openai' as const, coding_plan: false, ...over,
});

describe('ProviderRail', () => {
  test('groups builtins and customs with counts; delete only on customs', async () => {
    // The section-header assertions below use the zh strings; pin the locale
    // so the test does not depend on jsdom's navigator.language.
    setLang('zh');
    const user = userEvent.setup();
    const onDeleteProvider = vi.fn();
    render(
      <ProviderRail
        providers={[mk({ id: 'b', provider: 'openai' }), mk({ id: 'c', provider: 'vllm', is_builtin: false, label: 'vllm-test' })]}
        modelCounts={{ openai: 3, vllm: 1 }}
        selectedId="b"
        onSelect={vi.fn()}
        canManage
        onAddProvider={vi.fn()}
        onDeleteProvider={onDeleteProvider}
        onToggleProvider={vi.fn()}
      />,
    );
    expect(screen.getByText(/内置服务商 \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/自定义服务商 \(1\)/)).toBeInTheDocument();
    // Delete icon present for the custom row only.
    expect(screen.getAllByLabelText('delete-provider').length).toBe(1);
    await user.click(screen.getByLabelText('delete-provider'));
    expect(onDeleteProvider).toHaveBeenCalledTimes(1);
    expect(onDeleteProvider.mock.calls[0][0].id).toBe('c');
  });

  test('enable switch calls onToggleProvider with the next state', async () => {
    setLang('en');
    const user = userEvent.setup();
    const onToggleProvider = vi.fn();
    render(
      <ProviderRail
        providers={[mk({ id: 'b', provider: 'openai', enabled: true })]}
        modelCounts={{}}
        selectedId={null}
        onSelect={vi.fn()}
        canManage
        onAddProvider={vi.fn()}
        onDeleteProvider={vi.fn()}
        onToggleProvider={onToggleProvider}
      />,
    );
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    expect(onToggleProvider).toHaveBeenCalledWith('b', false);
  });
});
