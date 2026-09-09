import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('OpenClaw aborted tool run exit patch', () => {
  test('carries upstream #94412 while the pinned version predates v2026.6.11', () => {
    expectPatchContains('openclaw-stop-loop-after-aborted-tool-run.patch', [
      'const stopIfAborted = async (): Promise<boolean> => {',
      'new Error("Agent run aborted")',
      'await emit({ type: "turn_end", message: abortedMessage, toolResults: [] });',
      'does not request another model turn after a tool aborts the run',
      'does not request another model turn when an async turn hook aborts the run',
      'expect(streamCalls).toBe(1)',
    ]);
  });
});
