import { describe, expect, test } from 'vitest';

import {
  BrowserNetworkMode,
  BrowserProfileMode,
  normalizeBrowserCdpUrl,
  normalizeBrowserHostnameList,
  normalizeBrowserHostnamePolicyList,
  normalizeBrowserWebAccessConfig,
} from './constants';

describe('browser web access constants', () => {
  test('normalizes hostname lists into browser URL entries', () => {
    expect(normalizeBrowserHostnameList([
      ' https://Example.com/docs ',
      'example.com:443',
      '*.Internal.local/path',
      'localhost:123',
      'anthropic.com',
      'https://api.baidu.com/path',
      '',
      'https://Example.com/other',
    ])).toEqual([
      'https://www.example.com',
      'https://www.example.com:443',
      '*.internal.local',
      'https://localhost:123',
      'https://www.anthropic.com',
      'https://api.baidu.com',
    ]);
  });

  test('builds hostname policy lists from browser URL entries', () => {
    expect(normalizeBrowserHostnamePolicyList([
      'https://www.baidu.com',
      'https://localhost:123',
      '*.internal.local',
      'https://api.baidu.com/path',
    ])).toEqual(['www.baidu.com', 'localhost', '*.internal.local', 'api.baidu.com']);
  });

  test('accepts only HTTP and WebSocket CDP URLs', () => {
    expect(normalizeBrowserCdpUrl('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222');
    expect(normalizeBrowserCdpUrl('wss://browser.example.com')).toBe('wss://browser.example.com');
    expect(normalizeBrowserCdpUrl('file:///tmp/browser')).toBeUndefined();
    expect(normalizeBrowserCdpUrl('127.0.0.1:9222')).toBeUndefined();
  });

  test('normalizes browser web access config values', () => {
    const config = normalizeBrowserWebAccessConfig({
      browserEnabled: false,
      profileMode: BrowserProfileMode.User,
      networkMode: BrowserNetworkMode.Strict,
      allowedHostnames: ['https://Localhost:8443/a'],
      blockedHostnames: ['tracking.example/path'],
      cdpUrl: 'ftp://browser.example.com',
      remoteCdpTimeoutMs: -1,
      webFetch: {
        enabled: false,
        followGlobalProxy: false,
        timeoutSeconds: 30,
        readability: false,
      },
    });

    expect(config.browserEnabled).toBe(false);
    expect(config.profileMode).toBe(BrowserProfileMode.User);
    expect(config.networkMode).toBe(BrowserNetworkMode.Strict);
    expect(config.allowedHostnames).toEqual(['https://localhost:8443']);
    expect(config.blockedHostnames).toEqual(['https://tracking.example']);
    expect(config.cdpUrl).toBeUndefined();
    expect(config.remoteCdpTimeoutMs).toBeUndefined();
    expect(config.webFetch).toMatchObject({
      enabled: false,
      followGlobalProxy: false,
      timeoutSeconds: 30,
      readability: false,
    });
  });
});
