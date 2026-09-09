import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import type { ModelView } from '../../../src/api/models';
import type { ProviderKeyView } from '../../../src/api/providers';
import { setLang } from '../../../src/i18n';
import { ModelSelect } from '../../../src/pages/agentManage/drawer/ModelSelect';

const provider = (over: Partial<ProviderKeyView> = {}): ProviderKeyView => ({
  id: 'pk1', provider: 'openai', endpoint: 'https://api.openai.com', label: 'OpenAI',
  enabled: true, region: 'global', default_base_url: 'https://api.openai.com',
  website: null, description: null, api_key_masked: 'sk-…', status: 'connected',
  latency_ms: 12, last_test_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
  is_builtin: false, protocol: 'openai', coding_plan: false,
  ...over,
});

const model = (over: Partial<ModelView> = {}): ModelView => ({
  id: 'm1', provider: 'openai', model: 'gpt-5', display_name: 'GPT-5', type: 'chat', types: ['chat'],
  quota_per_user_per_day: null, enabled: true, disabled_by_admin: false,
  supports_image: false, supports_video: false, supports_thinking: true,
  context_window: null, max_tokens: null, temperature: null, top_p: null,
  max_output_tokens: null, ...over,
});

describe('ModelSelect', () => {
  test('dropdown groups models under their vendor and selecting sets provider/model', () => {
    setLang('zh');
    let saved: string | undefined;
    // Both providers are enabled, so both of their models are offered.
    const providers = [
      provider({ id: 'pk1', provider: 'openai', label: 'OpenAI' }),
      provider({ id: 'pk-anthropic', provider: 'anthropic', label: 'Anthropic' }),
    ];
    const models = [
      model({ id: 'm1', provider: 'openai', model: 'gpt-5', display_name: 'GPT-5', provider_key_id: 'pk1' }),
      model({ id: 'm2', provider: 'openai', model: 'o3', display_name: 'O3', provider_key_id: 'pk1' }),
      model({ id: 'm3', provider: 'anthropic', model: 'claude-opus', display_name: 'Claude Opus', provider_key_id: 'pk-anthropic' }),
      // An admin-disabled model is excluded from the list (and its group).
      model({ id: 'm4', provider: 'anthropic', model: 'claude-sonnet', display_name: 'Claude Sonnet', provider_key_id: 'pk-anthropic', disabled_by_admin: true }),
    ];
    render(<ModelSelect value="" onChange={v => { saved = v; }} models={models} providers={providers} fallbackFree={false} />);
    // The collapsed field shows a placeholder until a model is chosen.
    fireEvent.click(screen.getByRole('button', { name: /providerId\/modelId/ }));
    // Vendor group header renders the 模型配置 label (matched by key id).
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    // Models under that vendor; the disabled one is filtered out.
    expect(screen.getByRole('option', { name: /GPT-5/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /O3/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Claude Sonnet/ })).toBeNull();
    // Selecting a model issues the provider/model value.
    fireEvent.click(screen.getByRole('option', { name: /Claude Opus/ }));
    expect(saved).toBe('anthropic/claude-opus');
  });

  test('a disabled provider contributes no models (its group is absent)', () => {
    // The reported duplicate: builtin + custom deepseek share a slug. Only the
    // BUILTIN deepseek key is enabled, so only its models are offered — the
    // custom key's same-named model is not shown, so there is no duplicate.
    setLang('zh');
    const providers = [
      provider({ id: 'builtin:o1:deepseek', provider: 'deepseek', label: 'DeepSeek', is_builtin: true, enabled: true }),
      provider({ id: 'custom:o1:deepseek', provider: 'deepseek', label: 'my deepseek', enabled: false }),
    ];
    const models = [
      model({ id: 'b1', provider: 'deepseek', model: 'deepseek-flash', display_name: 'deepseek-flash', provider_key_id: 'builtin:o1:deepseek' }),
      model({ id: 'c1', provider: 'deepseek', model: 'deepseek-flash', display_name: 'deepseek-flash', provider_key_id: 'custom:o1:deepseek' }),
    ];
    render(<ModelSelect value="" onChange={() => {}} models={models} providers={providers} fallbackFree={false} />);
    fireEvent.click(screen.getByRole('button', { name: /providerId\/modelId/ }));
    // Exactly one deepseek-flash (the enabled builtin's), not two.
    expect(screen.getAllByRole('option', { name: /deepseek-flash/ })).toHaveLength(1);
    expect(screen.getByText('DeepSeek')).toBeInTheDocument();
    // The disabled provider renders no group.
    expect(screen.queryByText('my deepseek')).toBeNull();
  });

  test('two same-slug providers both enabled show as distinct groups', () => {
    setLang('zh');
    const providers = [
      provider({ id: 'builtin:o1:deepseek', provider: 'deepseek', label: 'DeepSeek', is_builtin: true, enabled: true }),
      provider({ id: 'custom:o1:deepseek', provider: 'deepseek', label: 'my deepseek', enabled: true }),
    ];
    const models = [
      model({ id: 'b1', provider: 'deepseek', model: 'deepseek-v4-pro', display_name: 'deepseek-v4-pro', provider_key_id: 'builtin:o1:deepseek' }),
      model({ id: 'c1', provider: 'deepseek', model: 'deepseek-v4-pro', display_name: 'deepseek-v4-pro', provider_key_id: 'custom:o1:deepseek' }),
    ];
    render(<ModelSelect value="" onChange={() => {}} models={models} providers={providers} fallbackFree={false} />);
    fireEvent.click(screen.getByRole('button', { name: /providerId\/modelId/ }));
    // Both keys' same-named model is offered, each under its own labeled group.
    expect(screen.getAllByRole('option', { name: /deepseek-v4-pro/ })).toHaveLength(2);
    expect(screen.getByText('DeepSeek')).toBeInTheDocument();
    expect(screen.getByText('my deepseek')).toBeInTheDocument();
  });

  test('collapsed field shows the vendor label plus the model ID once a model is selected', () => {
    setLang('zh');
    const models = [model({ id: 'm1', provider: 'openai', model: 'gpt-5', display_name: 'GPT-5', provider_key_id: 'pk1' })];
    render(<ModelSelect value="openai/gpt-5" onChange={() => {}} models={models} providers={[provider()]} fallbackFree={false} />);
    // The collapsed button reads "vendor label · modelId" (not the raw
    // provider slug, and not the display_name alone).
    expect(screen.getByRole('button', { name: /OpenAI · gpt-5/ })).toBeInTheDocument();
  });

  test('collapsed field degrades to the raw provider/model for a free-text value', () => {
    setLang('zh');
    const models = [model({ id: 'm1', provider: 'openai', model: 'gpt-5', display_name: 'GPT-5', provider_key_id: 'pk1' })];
    render(<ModelSelect value="rw/legacy-1" onChange={() => {}} models={models} providers={[provider()]} fallbackFree={false} />);
    expect(screen.getByRole('button', { name: /rw\/legacy-1/ })).toBeInTheDocument();
  });

  test('still shows enabled models (slugged) when the provider list is absent', () => {
    // Degraded case: no provider data → the enabled-provider filter is skipped
    // so the model-level list is not hidden, and the header falls back to slug.
    setLang('zh');
    render(<ModelSelect value="" onChange={() => {}} models={[model({ id: 'm1', provider: 'custom-lab', model: 'x', display_name: 'X' })]} providers={[]} fallbackFree={false} />);
    fireEvent.click(screen.getByRole('button', { name: /providerId\/modelId/ }));
    expect(screen.getByRole('option', { name: /X/ })).toBeInTheDocument();
    expect(screen.getByText('custom-lab')).toBeInTheDocument();
  });

  test('falls back to free text when the catalog is empty', () => {
    setLang('zh');
    render(<ModelSelect value="rw/legacy" onChange={() => {}} models={[]} providers={[]} fallbackFree={false} />);
    expect(screen.getByRole('textbox', { name: /模型/ })).toHaveValue('rw/legacy');
  });
});
