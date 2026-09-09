import { describe, expect, test } from 'vitest';

import { APP_UPDATE_URL_UNTRUSTED_ERROR } from '../../shared/appUpdate/constants';
import {
  assertTrustedWindowsInstallerUrl,
  isPrivateHostname,
  isSecureWindowsInstallerOrigin,
  validateWindowsInstallerUrl,
  WindowsInstallerUrlPolicyFailure,
} from './appUpdateUrlPolicy';

describe('Windows installer URL policy', () => {
  test.each([
    'https://downloads.example.com/releases/GenWork.EXE?channel=prod',
    'https://replacement-cdn.example.net/releases/GenWork.exe',
  ])('accepts a transport-safe HTTPS exe URL without pinning its origin: %s', url => {
    expect(validateWindowsInstallerUrl(url)).toMatchObject({ trusted: true });
  });

  test.each([
    ['http://downloads.example.com/setup.exe', WindowsInstallerUrlPolicyFailure.InsecureProtocol],
    [
      'https://user:secret@downloads.example.com/setup.exe',
      WindowsInstallerUrlPolicyFailure.CredentialsPresent,
    ],
    [
      'https://downloads.example.com/setup.exe#open',
      WindowsInstallerUrlPolicyFailure.FragmentPresent,
    ],
    [
      'https://downloads.example.com:8443/setup.exe',
      WindowsInstallerUrlPolicyFailure.UnapprovedPort,
    ],
    [
      'https://downloads.example.com/setup.dmg',
      WindowsInstallerUrlPolicyFailure.InvalidExtension,
    ],
  ])('rejects %s', (url, reason) => {
    expect(validateWindowsInstallerUrl(url)).toEqual({
      trusted: false,
      reason,
    });
  });

  test('validates dynamic receipt origins without treating them as an allowlist', () => {
    expect(isSecureWindowsInstallerOrigin('https://downloads.example.com')).toBe(true);
    expect(isSecureWindowsInstallerOrigin('https://replacement-cdn.example.net')).toBe(true);
    expect(isSecureWindowsInstallerOrigin('http://downloads.example.com')).toBe(false);
    expect(isSecureWindowsInstallerOrigin('https://downloads.example.com:8443')).toBe(false);
  });

  test('throws the stable cross-process error marker', () => {
    expect(() =>
      assertTrustedWindowsInstallerUrl('http://downloads.example.com/setup.exe'),
    ).toThrow(APP_UPDATE_URL_UNTRUSTED_ERROR);
  });
});

describe('Windows installer URL policy — trusted origins', () => {
  const enterpriseOrigin = 'http://192.168.10.5:8787';

  test('rejects public http even when trusted origin is configured', () => {
    const r = validateWindowsInstallerUrl('http://example.com/Installer.exe', {
      trustedOrigins: [enterpriseOrigin],
    });
    expect(r).toEqual({ trusted: false, reason: 'insecure-protocol' });
  });

  test('rejects trusted origin whose host is public (defense in depth)', () => {
    const r = validateWindowsInstallerUrl('http://updates.example.com/Installer.exe', {
      trustedOrigins: ['http://updates.example.com'],
    });
    expect(r).toEqual({ trusted: false, reason: 'insecure-protocol' });
  });

  test('accepts trusted origin on a private ipv4 host over http', () => {
    const r = validateWindowsInstallerUrl('http://192.168.10.5/dl/installer.exe', {
      trustedOrigins: [enterpriseOrigin],
    });
    expect(r.trusted).toBe(true);
  });

  test('accepts trusted origin on localhost', () => {
    const r = validateWindowsInstallerUrl('http://localhost:8787/dl/installer.exe', {
      trustedOrigins: ['http://localhost:8787'],
    });
    expect(r.trusted).toBe(true);
  });

  test('still enforces extension even with trusted origin', () => {
    const r = validateWindowsInstallerUrl('http://192.168.10.5/dl/not-exe.txt', {
      trustedOrigins: [enterpriseOrigin],
    });
    expect(r).toEqual({ trusted: false, reason: 'invalid-extension' });
  });

  test('still rejects credentials, fragment, port, and untrusted origin without trustedOrigins', () => {
    const r1 = validateWindowsInstallerUrl('https://user:pass@updates.example.com/i.exe');
    expect(r1).toEqual({ trusted: false, reason: 'credentials-present' });
    const r2 = validateWindowsInstallerUrl('https://updates.example.com/i.exe#frag');
    expect(r2).toEqual({ trusted: false, reason: 'fragment-present' });
    const r3 = validateWindowsInstallerUrl('https://updates.example.com:8443/i.exe');
    expect(r3).toEqual({ trusted: false, reason: 'unapproved-port' });
    const r4 = validateWindowsInstallerUrl('http://192.168.10.5/i.exe', { trustedOrigins: ['http://other.example.com'] });
    expect(r4).toEqual({ trusted: false, reason: 'insecure-protocol' });
  });

  test('isPrivateHostname recognises RFC1918, loopback, and localhost', () => {
    expect(isPrivateHostname('localhost')).toBe(true);
    expect(isPrivateHostname('127.0.0.1')).toBe(true);
    expect(isPrivateHostname('10.1.2.3')).toBe(true);
    expect(isPrivateHostname('172.16.0.1')).toBe(true);
    expect(isPrivateHostname('192.168.1.1')).toBe(true);
    expect(isPrivateHostname('8.8.8.8')).toBe(false);
    expect(isPrivateHostname('updates.example.com')).toBe(false);
  });
});
