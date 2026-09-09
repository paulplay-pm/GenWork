import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { genworkService } from './genwork';

type CoworkServiceInternals = {
  initialized: boolean;
  setupStreamListeners: () => void;
  setupOpenClawEngineListeners: () => void;
};

const internals = genworkService as unknown as CoworkServiceInternals;

beforeEach(() => {
  vi.useFakeTimers();
  genworkService.destroy();
  vi.spyOn(internals, 'setupStreamListeners').mockImplementation(() => undefined);
  vi.spyOn(internals, 'setupOpenClawEngineListeners').mockImplementation(() => undefined);
});

afterEach(() => {
  genworkService.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('initialization settles after isolated IPC rejection and timeout', async () => {
  vi.spyOn(genworkService, 'loadConfig').mockRejectedValue(new Error('config unavailable'));
  vi.spyOn(genworkService, 'loadSessions').mockImplementation(
    () => new Promise<void>(() => undefined),
  );
  vi.spyOn(genworkService, 'loadOpenClawEngineStatus').mockResolvedValue(null);

  const initialization = genworkService.init();
  await vi.advanceTimersByTimeAsync(12_001);

  await expect(initialization).resolves.toBeUndefined();
  expect(internals.initialized).toBe(true);
});
