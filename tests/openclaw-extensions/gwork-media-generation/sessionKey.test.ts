import { describe, expect, test } from 'vitest';

import { isGenworkDesktopSessionKey } from '../../../openclaw-extensions/genwork-media-generation/sessionKey';

describe('genwork-media-generation session key gating', () => {
  test('allows main agent desktop sessions', () => {
    expect(isGenworkDesktopSessionKey('agent:main:genwork:session-1')).toBe(true);
  });

  test('allows non-main agent desktop sessions', () => {
    expect(isGenworkDesktopSessionKey('agent:creative-agent:genwork:session-2')).toBe(true);
  });

  test('allows materialized subagent child sessions', () => {
    expect(isGenworkDesktopSessionKey('agent:creative-agent:subagent:run-1')).toBe(true);
  });

  test('allows legacy desktop sessions', () => {
    expect(isGenworkDesktopSessionKey('genwork:session-3')).toBe(true);
  });

  test('rejects channel and malformed session keys', () => {
    expect(isGenworkDesktopSessionKey('agent:creative-agent:dingtalk-connector:direct:user-1')).toBe(false);
    expect(isGenworkDesktopSessionKey('')).toBe(false);
    expect(isGenworkDesktopSessionKey('agent::genwork:session-4')).toBe(false);
    expect(isGenworkDesktopSessionKey('agent:creative-agent:genwork:')).toBe(false);
    expect(isGenworkDesktopSessionKey('agent:creative-agent')).toBe(false);
  });
});