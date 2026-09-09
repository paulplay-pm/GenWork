import { describe, expect, test } from 'vitest';

import {
  parseEnterpriseUpdate,
  parseYoudaoUpdate,
  pickPlatformUrl,
} from '../../../src/main/libs/appUpdateResponseParsers';

describe('parseYoudaoUpdate', () => {
  test('returns null on code !== 0', () => {
    expect(parseYoudaoUpdate({ code: 1 })).toBeNull();
  });

  test('returns null when no value or version', () => {
    expect(parseYoudaoUpdate({ code: 0 })).toBeNull();
    expect(parseYoudaoUpdate({ code: 0, data: {} })).toBeNull();
    expect(parseYoudaoUpdate({ code: 0, data: { value: {} } })).toBeNull();
  });

  test('extracts version, date, changeLog with ch → zh alias', () => {
    const r = parseYoudaoUpdate({
      code: 0,
      data: {
        value: {
          version: '1.2.0',
          date: '2026-08-27',
          changeLog: {
            ch: { title: '中文', content: ['a', 'b'] },
            en: { title: 'English', content: ['x'] },
          },
          macArm: { url: 'https://cdn.example.com/a.dmg' },
        },
      },
    });
    expect(r?.latestVersion).toBe('1.2.0');
    expect(r?.date).toBe('2026-08-27');
    expect(r?.changeLog.zh.title).toBe('中文');
    expect(r?.changeLog.zh.content).toEqual(['a', 'b']);
    expect(r?.changeLog.en.title).toBe('English');
    expect(r?.changeLog.en.content).toEqual(['x']);
    expect(r?.macArmUrl).toBe('https://cdn.example.com/a.dmg');
    expect(r?.macIntelUrl).toBeNull();
    expect(r?.windowsX64Url).toBeNull();
  });

  test('exposes both macIntel and macArm URLs (coordinator picks)', () => {
    const r = parseYoudaoUpdate({
      code: 0,
      data: {
        value: {
          version: '1',
          macIntel: { url: 'https://x/i.dmg' },
          macArm: { url: 'https://x/a.dmg' },
        },
      },
    });
    expect(r?.macArmUrl).toBe('https://x/a.dmg');
    expect(r?.macIntelUrl).toBe('https://x/i.dmg');
  });

  test('returns null mac* URLs when none provided', () => {
    const r = parseYoudaoUpdate({ code: 0, data: { value: { version: '1' } } });
    expect(r?.macIntelUrl).toBeNull();
    expect(r?.macArmUrl).toBeNull();
    expect(r?.windowsX64Url).toBeNull();
  });
});

describe('parseEnterpriseUpdate', () => {
  test('returns null when latest !== true', () => {
    expect(parseEnterpriseUpdate({ latest: false })).toBeNull();
    expect(parseEnterpriseUpdate({})).toBeNull();
  });

  test('returns null when version missing or empty after trim', () => {
    expect(parseEnterpriseUpdate({ latest: true })).toBeNull();
    expect(parseEnterpriseUpdate({ latest: true, version: '   ' })).toBeNull();
  });

  test('returns shape with all platform URLs', () => {
    const r = parseEnterpriseUpdate({
      latest: true,
      version: '2.0.0',
      date: '2026-08-27T00:00:00Z',
      changeLog: { zh: { title: '中', content: ['a'] }, en: { title: 'en', content: ['x'] } },
      macArm: { url: 'https://cdn.example.com/a.dmg' },
      windowsX64: { url: 'https://cdn.example.com/w.exe' },
    });
    expect(r?.latestVersion).toBe('2.0.0');
    expect(r?.date).toBe('2026-08-27T00:00:00Z');
    expect(r?.changeLog.zh.title).toBe('中');
    expect(r?.changeLog.zh.content).toEqual(['a']);
    expect(r?.changeLog.en.title).toBe('en');
    expect(r?.changeLog.en.content).toEqual(['x']);
    expect(r?.macArmUrl).toBe('https://cdn.example.com/a.dmg');
    expect(r?.macIntelUrl).toBeNull();
    expect(r?.windowsX64Url).toBe('https://cdn.example.com/w.exe');
  });

  test('null URLs when no platform field is present', () => {
    const r = parseEnterpriseUpdate({ latest: true, version: '1.0.0' });
    expect(r?.macIntelUrl).toBeNull();
    expect(r?.macArmUrl).toBeNull();
    expect(r?.windowsX64Url).toBeNull();
  });

  test('returns null when version is whitespace-only', () => {
    expect(parseEnterpriseUpdate({ latest: true, version: '\t\n' })).toBeNull();
  });
});

describe('pickPlatformUrl', () => {
  const sample = {
    macIntelUrl: 'https://cdn/i.dmg',
    macArmUrl: 'https://cdn/a.dmg',
    windowsX64Url: 'https://cdn/w.exe',
  };

  test('returns null on unsupported platforms (linux)', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      expect(pickPlatformUrl(sample)).toBeNull();
    }
  });

  test('returns correct macArm on darwin/arm64', () => {
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(pickPlatformUrl(sample)).toBe('https://cdn/a.dmg');
    }
  });

  test('returns correct macIntel on darwin/x64', () => {
    if (process.platform === 'darwin' && process.arch === 'x64') {
      expect(pickPlatformUrl(sample)).toBe('https://cdn/i.dmg');
    }
  });

  test('returns windowsX64 on win32', () => {
    if (process.platform === 'win32') {
      expect(pickPlatformUrl(sample)).toBe('https://cdn/w.exe');
    }
  });
});