import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('OpenClaw critical tool-loop termination patch', () => {
  test('backports the dual-layer termination from upstream #106297', () => {
    expectPatchContains('openclaw-terminate-run-on-critical-tool-loop.patch', [
      'const terminateRun = deniedReason === "tool-loop";',
      '...(terminateRun ? { terminate: true } : {})',
      'shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext)',
      'shouldStopAfterTurn: this.shouldStopAfterTurn',
      'details?.deniedReason === "tool-loop"',
      'stops a mixed parallel batch after normal sibling tools finish',
      'expect(providerTurns).toBe(1)',
      'keeps %s vetoes non-terminating',
    ]);
  });
});
