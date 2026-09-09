import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import { setLang } from '../../src/i18n';
import { ModelDrawer } from '../../src/pages/providersModels/ModelDrawer';

describe('ModelDrawer', () => {
  test('renders 8 type cards and calls onSave with selected types', async () => {
    // The assertions below use the zh labels; pin the locale so the test
    // does not depend on jsdom's navigator.language.
    setLang('zh');
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ModelDrawer open providerId="p1" provider="openai" busy={false}
        model={{ id: 'm', provider: 'openai', model: 'gpt-4', display_name: 'GPT-4',
          types: ['chat'], type: 'chat', quota_per_user_per_day: null, enabled: true,
          disabled_by_admin: false, supports_image: false, supports_video: false, supports_thinking: false,
          context_window: 128000, max_tokens: null, temperature: 0.7, top_p: 0.9, max_output_tokens: null }}
        onSave={onSave} onClose={vi.fn()} />,
    );
    expect(screen.getByText('对话')).toBeInTheDocument();
    expect(screen.getByText('语音合成')).toBeInTheDocument(); // TTS card present
    // All 8 type cards render, one per `MODEL_TYPE_VALUES` entry.
    for (const label of ['对话', '视觉理解', '深度思考', '图像生成', 'Embedding', '重排序', '语音识别', '语音合成']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    await user.click(screen.getByText('深度思考')); // toggle reasoning on
    await user.click(screen.getByRole('button', { name: /保存/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].types).toContain('reasoning');
    expect(onSave.mock.calls[0][0].types).toContain('chat');
  });

  test('an untouched edit of an originally-null sampling field round-trips as null', async () => {
    setLang('zh');
    const user = userEvent.setup();
    const onSave = vi.fn();
    // Edit a model whose sampling fields are all null. The drawer must NOT
    // materialize them to the UI defaults (0.7 / 0.9 / 200000) on an
    // untouched save — the payload must carry null so the backend leaves
    // the columns as-is.
    render(
      <ModelDrawer open providerId="p1" provider="openai" busy={false}
        model={{ id: 'm-null', provider: 'openai', model: 'embed-1', display_name: 'Embed 1',
          types: ['embedding'], type: 'embedding', quota_per_user_per_day: null, enabled: true,
          disabled_by_admin: false, supports_image: false, supports_video: false, supports_thinking: false,
          context_window: null, max_tokens: null, temperature: null, top_p: null, max_output_tokens: null }}
        onSave={onSave} onClose={vi.fn()} />,
    );
    // Open the drawer, leave every sampling control untouched, and save.
    await user.click(screen.getByRole('button', { name: /保存/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0][0];
    expect(payload.contextWindow).toBeNull();
    expect(payload.temperature).toBeNull();
    expect(payload.topP).toBeNull();
    // The non-sampling fields still round-trip so the save isn't a no-op.
    expect(payload.model).toBe('embed-1');
    expect(payload.types).toEqual(['embedding']);
  });
});
