import { describe, expect, test } from 'vitest';

import { anthropicToOpenAI, openAIToAnthropic } from './genworkFormatTransform';

describe('cowork format reasoning_content transforms', () => {
  test('converts Anthropic thinking blocks to OpenAI reasoning_content', () => {
    const result = anthropicToOpenAI({
      model: 'deepseek-v4-pro',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'need the file first. ' },
            { type: 'text', text: 'I will read it.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Read',
              input: { file_path: '/tmp/a.ts' },
            },
          ],
        },
      ],
    });

    expect(result.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: 'I will read it.',
        reasoning_content: 'need the file first. ',
        tool_calls: [
          expect.objectContaining({
            id: 'toolu_1',
            type: 'function',
            function: expect.objectContaining({
              name: 'Read',
              arguments: '{"file_path":"/tmp/a.ts"}',
            }),
          }),
        ],
      }),
    ]);
  });

  test('converts OpenAI reasoning_content to Anthropic thinking blocks', () => {
    const result = openAIToAnthropic({
      id: 'chatcmpl_1',
      model: 'mimo-v2.5-pro',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            reasoning_content: 'check the active project first.',
            content: 'I need one command.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'Bash',
                  arguments: '{"command":"pwd"}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
      },
    });

    expect(result.content).toEqual([
      { type: 'thinking', thinking: 'check the active project first.' },
      { type: 'text', text: 'I need one command.' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'Bash',
        input: { command: 'pwd' },
      },
    ]);
  });
});
