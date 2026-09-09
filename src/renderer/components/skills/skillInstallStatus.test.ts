import { describe, expect, test } from 'vitest';

import { resolveInstallStatus } from './skillInstallStatus';

describe('resolveInstallStatus', () => {
  test('revoked wins over installed', () => {
    expect(resolveInstallStatus({ id: 'a', version: '1.0.0' }, { id: 'a', version: '1.0.0', enabled: true }, true)).toBe('disabled');
  });

  test('revoked wins over update_available', () => {
    expect(resolveInstallStatus({ id: 'a', version: '2.0.0' }, { id: 'a', version: '1.0.0', enabled: true }, true)).toBe('disabled');
  });

  test('update_available when remote > local and not revoked', () => {
    expect(resolveInstallStatus({ id: 'a', version: '2.0.0' }, { id: 'a', version: '1.0.0', enabled: true }, false)).toBe('update_available');
  });

  test('not_installed when absent', () => {
    expect(resolveInstallStatus({ id: 'a', version: '1.0.0' }, null, false)).toBe('not_installed');
  });
});
