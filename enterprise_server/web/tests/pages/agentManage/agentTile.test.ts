import { describe, expect, test } from 'vitest';

import { AGENT_COLORS, AGENT_GLYPHS, isUrlIcon, tileClass } from '../../../src/pages/agentManage/agentTile';

describe('agentTile', () => {
  test('has 8 colors and at least 5 glyphs', () => {
    expect(AGENT_COLORS).toHaveLength(8);
    expect(AGENT_GLYPHS.length).toBeGreaterThanOrEqual(5);
  });
  test('isUrlIcon detects http/https/data URLs only', () => {
    expect(isUrlIcon('https://x/y.png')).toBe(true);
    expect(isUrlIcon('data:image/png;base64,AA')).toBe(true);
    expect(isUrlIcon('bot')).toBe(false);
    expect(isUrlIcon('')).toBe(false);
  });
  test('tileClass wraps out-of-range indices into the palette', () => {
    expect(tileClass(9)).toBe(tileClass(9 % 8));
    expect(tileClass(0)).toContain('bg-[');
  });
});
