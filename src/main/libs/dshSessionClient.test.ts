import { describe, expect, test } from 'vitest';

import { extractTextBlocks } from './dshSessionClient';

describe('extractTextBlocks', () => {
  test('extracts text from a real assistant/message session event shape', () => {
    // Captured from a live dsh 0.1.0-rc.6 session log: payload nests under
    // `data.message.content`.
    const event = {
      type: 'assistant/message',
      seq: 19,
      time: 1786821658005,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'E2E delegation OK: the mock coding agent finished the task.' }],
          source: { kind: 'model' },
        },
      },
    };
    expect(extractTextBlocks(event)).toEqual(['E2E delegation OK: the mock coding agent finished the task.']);
  });

  test('joins multiple text blocks and ignores non-text blocks', () => {
    const event = {
      data: {
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool-use', name: 'bash' },
            { type: 'text', text: 'second' },
          ],
        },
      },
    };
    expect(extractTextBlocks(event)).toEqual(['first', 'second']);
  });

  test('returns empty for events without text content', () => {
    expect(extractTextBlocks({ type: 'turn/end', data: { reason: { kind: 'completed' } } })).toEqual([]);
    expect(extractTextBlocks(null)).toEqual([]);
  });
});
