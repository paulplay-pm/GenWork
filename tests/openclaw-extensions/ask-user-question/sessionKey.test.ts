import { describe, expect, test } from 'vitest';

import { isAskUserQuestionCandidateSessionKey } from '../../../openclaw-extensions/ask-user-question/sessionKey';

describe('ask-user-question session key gating', () => {
  test('allows desktop sessions across agents', () => {
    expect(isAskUserQuestionCandidateSessionKey('agent:main:genwork:session-1')).toBe(true);
    expect(isAskUserQuestionCandidateSessionKey('agent:qa-reviewer:genwork:session-2')).toBe(true);
  });

  test('allows materialized subagent session candidates', () => {
    expect(isAskUserQuestionCandidateSessionKey('agent:qa-reviewer:subagent:run-1')).toBe(true);
  });

  test('allows legacy desktop sessions', () => {
    expect(isAskUserQuestionCandidateSessionKey('genwork:session-3')).toBe(true);
  });

  test('rejects channel and malformed session keys', () => {
    expect(isAskUserQuestionCandidateSessionKey('agent:qa-reviewer:feishu:direct:user-1')).toBe(false);
    expect(isAskUserQuestionCandidateSessionKey('agent:qa-reviewer:dingtalk-connector:direct:user-1')).toBe(false);
    expect(isAskUserQuestionCandidateSessionKey('agent::genwork:session-4')).toBe(false);
    expect(isAskUserQuestionCandidateSessionKey('agent:qa-reviewer:genwork:')).toBe(false);
    expect(isAskUserQuestionCandidateSessionKey('')).toBe(false);
  });
});
