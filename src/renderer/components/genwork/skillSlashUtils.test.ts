import { describe, expect, test } from 'vitest';

import { resolveSkillSlashTrigger } from './skillSlashUtils';

describe('resolveSkillSlashTrigger', () => {
  test('triggers on a bare "/" at the very start', () => {
    expect(resolveSkillSlashTrigger('/', 1)).toEqual({
      slashIndex: 0,
      cursorPos: 1,
      filter: '',
    });
  });

  test('triggers with a partial filter and reports the filter text', () => {
    expect(resolveSkillSlashTrigger('/web', 4)).toEqual({
      slashIndex: 0,
      cursorPos: 4,
      filter: 'web',
    });
  });

  test('allows leading whitespace before the "/"', () => {
    expect(resolveSkillSlashTrigger('  /word', 7)).toEqual({
      slashIndex: 2,
      cursorPos: 7,
      filter: 'word',
    });
  });

  test('does not trigger when non-whitespace precedes the "/"', () => {
    // Mid-message slash: a word (not whitespace) before it.
    expect(resolveSkillSlashTrigger('do this /web', 13)).toBeNull();
    // A path-like value: text before the "/".
    expect(resolveSkillSlashTrigger('a/b', 3)).toBeNull();
  });

  test('does not trigger once the filter contains a space', () => {
    expect(resolveSkillSlashTrigger('/web search', 12)).toBeNull();
    expect(resolveSkillSlashTrigger('/new line', 9)).toBeNull();
  });

  test('does not trigger for an empty string or no slash', () => {
    expect(resolveSkillSlashTrigger('', 0)).toBeNull();
    expect(resolveSkillSlashTrigger('hello', 5)).toBeNull();
  });

  test('clamps the cursor position to the text length', () => {
    expect(resolveSkillSlashTrigger('/', 99)).toEqual({
      slashIndex: 0,
      cursorPos: 1,
      filter: '',
    });
  });

  test('does not trigger when another "/" precedes the trigger', () => {
    // A second "/" is not whitespace, so the message-start rule fails.
    expect(resolveSkillSlashTrigger('//', 2)).toBeNull();
  });
});
