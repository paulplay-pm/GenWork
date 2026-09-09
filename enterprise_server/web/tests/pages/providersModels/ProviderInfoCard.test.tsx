import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ProviderInfoCard } from '../../../src/pages/providersModels/ProviderInfoCard';

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

describe('pages/providersModels/ProviderInfoCard', () => {
  test('renders name and base url with initial values, and no description field', () => {
    render(<ProviderInfoCard provider={baseProvider} canManage={true} onDraftChange={() => {}} />);
    expect(screen.getByDisplayValue('OpenAI')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://api.openai.com/v1')).toBeInTheDocument();
    // The old Notes/description field is gone.
    expect(screen.queryByLabelText(/Notes/i)).toBeNull();
  });

  test('shows the masked key hint and the keep-current hint', () => {
    render(<ProviderInfoCard provider={baseProvider} canManage={true} onDraftChange={() => {}} />);
    expect(screen.getAllByText(/sk-…abcd/).length).toBeGreaterThan(0);
    expect(screen.getByText(/keep the current key/i)).toBeInTheDocument();
  });

  test('pushes the current field values up to the page on mount', async () => {
    const onDraftChange = vi.fn();
    render(
      <ProviderInfoCard provider={baseProvider} canManage={true} onDraftChange={onDraftChange} />
    );
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith({
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        protocol: 'openai',
        codingPlan: false,
        apiKey: '',
      })
    );
  });

  test('includes the typed key in the pushed draft', async () => {
    const onDraftChange = vi.fn();
    render(
      <ProviderInfoCard provider={baseProvider} canManage={true} onDraftChange={onDraftChange} />
    );
    const key = screen.getByLabelText(/API Key/i);
    fireEvent.change(key, { target: { value: 'sk-new' } });
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith({
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        protocol: 'openai',
        codingPlan: false,
        apiKey: 'sk-new',
      })
    );
  });

  test('has no save button (saving is consolidated on the header)', () => {
    render(<ProviderInfoCard provider={baseProvider} canManage={true} onDraftChange={() => {}} />);
    expect(screen.queryByRole('button', { name: /Save/i })).toBeNull();
  });

  test('choosing a protocol auto-fills the Base URL to that protocol default', async () => {
    const onDraftChange = vi.fn();
    render(
      <ProviderInfoCard
        provider={{ ...baseProvider, protocol: 'openai', endpoint: 'https://custom.example/v1' }}
        canManage={true}
        onDraftChange={onDraftChange}
      />
    );
    // Switch to Anthropic → Base URL becomes the Anthropic default (overwriting
    // the custom value, per the agreed behavior).
    fireEvent.click(screen.getByRole('radio', { name: /Anthropic compatible/i }));
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith({
        label: 'OpenAI',
        baseUrl: 'https://api.anthropic.com',
        protocol: 'anthropic',
        codingPlan: false,
        apiKey: '',
      })
    );
    expect(screen.getByDisplayValue('https://api.anthropic.com')).toBeInTheDocument();
  });

  test('name defaults to the provider slug when no label is stored', async () => {
    const onDraftChange = vi.fn();
    render(
      <ProviderInfoCard
        provider={{ ...baseProvider, provider: 'vllm-custom', label: null, endpoint: null }}
        canManage={true}
        onDraftChange={onDraftChange}
      />
    );
    expect(screen.getByDisplayValue('vllm-custom')).toBeInTheDocument();
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ label: 'vllm-custom', baseUrl: '' })
      )
    );
  });

  test('disables the inputs when canManage is false', () => {
    render(<ProviderInfoCard provider={baseProvider} canManage={false} onDraftChange={() => {}} />);
    expect(screen.getByDisplayValue('OpenAI')).toBeDisabled();
    expect(screen.getByDisplayValue('https://api.openai.com/v1')).toBeDisabled();
    expect(screen.getByRole('radio', { name: /OpenAI compatible/i })).toBeDisabled();
    expect(screen.getByLabelText(/API Key/i)).toBeDisabled();
  });

  test('api-key eye toggle changes input type', () => {
    render(<ProviderInfoCard provider={baseProvider} canManage={true} onDraftChange={() => {}} />);
    const apiKeyInput = screen.getByLabelText(/API Key/i);
    expect(apiKeyInput).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: /Show/i }));
    expect(apiKeyInput).toHaveAttribute('type', 'text');
  });
});
