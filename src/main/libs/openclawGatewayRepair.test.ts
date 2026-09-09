import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import {
  backupOpenClawConfig,
  getOpenClawGatewayRepairBusyError,
  OPENCLAW_GATEWAY_REPAIR_BUSY_ERROR,
  resolveOpenClawConfigBackupPath,
} from './openclawGatewayRepair';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genwork-openclaw-repair-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backupOpenClawConfig renames openclaw.json to the preferred backup path', () => {
  const dir = makeTempDir();
  const configPath = path.join(dir, 'openclaw.json');
  const backupPath = path.join(dir, 'openclaw-bak.json');
  fs.writeFileSync(configPath, '{"gateway":{"mode":"local"}}\n', 'utf8');

  const result = backupOpenClawConfig(configPath);

  expect(result).toEqual({
    originalPath: configPath,
    backupPath,
  });
  expect(fs.existsSync(configPath)).toBe(false);
  expect(fs.readFileSync(backupPath, 'utf8')).toBe('{"gateway":{"mode":"local"}}\n');
});

test('resolveOpenClawConfigBackupPath uses a timestamped path when the preferred backup exists', () => {
  const dir = makeTempDir();
  const configPath = path.join(dir, 'openclaw.json');
  const existing = new Set([
    path.join(dir, 'openclaw-bak.json'),
  ]);

  const backupPath = resolveOpenClawConfigBackupPath(
    configPath,
    (filePath) => existing.has(filePath),
    new Date('2026-06-05T09:08:07'),
  );

  expect(backupPath).toBe(path.join(dir, 'openclaw-bak-20260605-090807.json'));
});

test('resolveOpenClawConfigBackupPath never overwrites timestamped backups', () => {
  const dir = makeTempDir();
  const configPath = path.join(dir, 'openclaw.json');
  const existing = new Set([
    path.join(dir, 'openclaw-bak.json'),
    path.join(dir, 'openclaw-bak-20260605-090807.json'),
  ]);

  const backupPath = resolveOpenClawConfigBackupPath(
    configPath,
    (filePath) => existing.has(filePath),
    new Date('2026-06-05T09:08:07'),
  );

  expect(backupPath).toBe(path.join(dir, 'openclaw-bak-20260605-090807-2.json'));
});

test('backupOpenClawConfig returns the original path when openclaw.json is missing', () => {
  const dir = makeTempDir();
  const configPath = path.join(dir, 'openclaw.json');

  const result = backupOpenClawConfig(configPath);

  expect(result).toEqual({ originalPath: configPath });
  expect(fs.existsSync(configPath)).toBe(false);
});

test('getOpenClawGatewayRepairBusyError rejects active gateway workloads', () => {
  expect(getOpenClawGatewayRepairBusyError(true)).toBe(OPENCLAW_GATEWAY_REPAIR_BUSY_ERROR);
  expect(getOpenClawGatewayRepairBusyError(false)).toBeNull();
});
