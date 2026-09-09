import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { ModelView } from '../../../src/api/models';
import { ModelList } from '../../../src/pages/providersModels/ModelList';

const baseModel: ModelView = {
  id: 'm1',
  provider: 'openai',
  model: 'gpt-4o',
  display_name: 'GPT-4o',
  type: 'chat',
  types: ['chat', 'vision'],
  quota_per_user_per_day: 1000,
  enabled: true,
  disabled_by_admin: false,
  supports_image: true,
  supports_video: false,
  supports_thinking: false,
  context_window: 128000,
  max_tokens: 8192,
  temperature: null,
  top_p: null,
  max_output_tokens: null,
};

function renderList(over: Partial<Parameters<typeof ModelList>[0]> = {}) {
  const onAdd = vi.fn();
  const onEdit = vi.fn();
  render(
    <ModelList
      models={[baseModel]}
      canManage={true}
      busy={false}
      onRefresh={() => {}}
      onAdd={onAdd}
      onEdit={onEdit}
      onDelete={() => {}}
      onToggleEnabled={() => {}}
      {...over}
    />,
  );
  return { onAdd, onEdit };
}

describe('pages/providersModels/ModelList', () => {
  test('renders empty state when no models', () => {
    render(
      <ModelList
        models={[]}
        canManage={true}
        busy={false}
        onRefresh={() => {}}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onToggleEnabled={() => {}}
      />,
    );
    expect(screen.getByText(/No models configured/i)).toBeInTheDocument();
  });

  test('renders model rows with type badges and formatted context', () => {
    renderList();
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    // Multi-type badges render each `types` entry.
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Vision')).toBeInTheDocument();
    // Context window is formatted by `contextLabel` (128K, not 128,000).
    expect(screen.getByText('128K')).toBeInTheDocument();
  });

  test('Add button calls onAdd', () => {
    const { onAdd } = renderList();
    fireEvent.click(screen.getByRole('button', { name: /Add model/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  test('Edit button calls onEdit with the model', () => {
    const { onEdit } = renderList();
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(onEdit).toHaveBeenCalledWith(baseModel);
  });

  test('hides action buttons when canManage is false', () => {
    renderList({ canManage: false });
    expect(screen.queryByRole('button', { name: /^Edit$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add model/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Refresh/i })).toBeNull();
  });
});
