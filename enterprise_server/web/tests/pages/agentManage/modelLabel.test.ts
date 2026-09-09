import { describe, expect, test } from 'vitest';

import type { ProviderKeyView } from '../../../src/api/providers';
import { modelLabel } from '../../../src/pages/agentManage/modelLabel';

function provider(slug: string, label: string | null): ProviderKeyView {
  return {
    id: `pk_${slug}`, provider: slug, endpoint: null, label, enabled: true,
    region: null, default_base_url: null, website: null, description: null,
    api_key_masked: null, status: 'unknown', latency_ms: null, last_test_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    is_builtin: false, protocol: 'openai', coding_plan: false,
  };
}

describe('modelLabel', () => {
  test('resolves the provider slug to the configured vendor label', () => {
    const providers = [provider('myorg', 'My Vendor')];
    expect(modelLabel('myorg/claude-opus', providers)).toBe('My Vendor · claude-opus');
  });

  test('falls back to the raw ref when the slug has no configured provider', () => {
    const providers = [provider('other', 'Other')];
    expect(modelLabel('unknown/model-x', providers)).toBe('unknown/model-x');
  });

  test('falls back to the raw ref when there is no slash', () => {
    const providers = [provider('myorg', 'My Vendor')];
    expect(modelLabel('gpt-5', providers)).toBe('gpt-5');
  });

  test('falls back to the raw ref when the matched provider has no label', () => {
    const providers = [provider('myorg', null)];
    expect(modelLabel('myorg/model-x', providers)).toBe('myorg/model-x');
  });

  test('returns the empty string for an empty ref', () => {
    expect(modelLabel('', [provider('myorg', 'My Vendor')])).toBe('');
  });

  test('tolerates a missing providers list', () => {
    expect(modelLabel('myorg/claude-opus', undefined)).toBe('myorg/claude-opus');
  });
});
