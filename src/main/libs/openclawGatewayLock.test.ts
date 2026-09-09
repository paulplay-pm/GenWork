import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  cleanupStaleGatewayLocks,
  GatewayLockCleanupAction,
  parseGatewayLockPayload,
  resolveGatewayLockPathForConfig,
} from './openclawGatewayLock';

const CONFIG_PATH = path.join(os.tmpdir(), 'genwork-lock-test-state', 'openclaw.json');

const expectedHash = (configPath: string): string =>
  crypto.createHash('sha256').update(path.resolve(configPath.trim())).digest('hex').slice(0, 8);

describe('resolveGatewayLockPathForConfig', () => {
  test('replicates the OpenClaw lock file name (sha256 of resolved config path)', () => {
    const lockPath = resolveGatewayLockPathForConfig(CONFIG_PATH, '/locks');
    expect(path.basename(lockPath)).toBe(`gateway.${expectedHash(CONFIG_PATH)}.lock`);
  });

  test('trims the config path before hashing, matching resolveUserPath', () => {
    const padded = `  ${CONFIG_PATH}  `;
    expect(resolveGatewayLockPathForConfig(padded, '/locks')).toBe(
      resolveGatewayLockPathForConfig(CONFIG_PATH, '/locks'),
    );
  });
});

describe('parseGatewayLockPayload', () => {
  test('accepts a valid payload', () => {
    const parsed = parseGatewayLockPayload(
      JSON.stringify({ pid: 1234, createdAt: '2026-08-05T07:40:47.280Z', configPath: CONFIG_PATH }),
    );
    expect(parsed).toEqual({ pid: 1234, configPath: CONFIG_PATH });
  });

  test.each([
    ['empty file', ''],
    ['truncated json', '{"pid": 123'],
    ['missing pid', JSON.stringify({ configPath: CONFIG_PATH })],
    ['non-integer pid', JSON.stringify({ pid: 'abc' })],
    ['non-positive pid', JSON.stringify({ pid: 0 })],
  ])('rejects %s', (_label, raw) => {
    expect(parseGatewayLockPayload(raw)).toBeNull();
  });
});

describe('cleanupStaleGatewayLocks', () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-lock-test-'));
  });

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  const ownLockPath = () => resolveGatewayLockPathForConfig(CONFIG_PATH, lockDir);

  test('returns empty when the lock directory does not exist', () => {
    const missingDir = path.join(lockDir, 'nope');
    expect(cleanupStaleGatewayLocks({ configPath: CONFIG_PATH, lockDir: missingDir })).toEqual([]);
  });

  test('removes our lock when the payload is empty (poisoned by TerminateProcess)', () => {
    fs.writeFileSync(ownLockPath(), '');
    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => true,
    });
    expect(results).toEqual([
      { lockPath: ownLockPath(), action: GatewayLockCleanupAction.RemovedUnreadable },
    ]);
    expect(fs.existsSync(ownLockPath())).toBe(false);
  });

  test('removes our lock when the payload is corrupted', () => {
    fs.writeFileSync(ownLockPath(), '{"pid": 118');
    const results = cleanupStaleGatewayLocks({ configPath: CONFIG_PATH, lockDir });
    expect(results[0]?.action).toBe(GatewayLockCleanupAction.RemovedUnreadable);
    expect(fs.existsSync(ownLockPath())).toBe(false);
  });

  test('removes our lock when the owner pid is dead', () => {
    fs.writeFileSync(ownLockPath(), JSON.stringify({ pid: 11848, createdAt: 'x', configPath: CONFIG_PATH }));
    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => false,
    });
    expect(results).toEqual([
      { lockPath: ownLockPath(), action: GatewayLockCleanupAction.RemovedDeadOwner, ownerPid: 11848 },
    ]);
    expect(fs.existsSync(ownLockPath())).toBe(false);
  });

  test('never touches a lock whose owner pid is alive', () => {
    fs.writeFileSync(ownLockPath(), JSON.stringify({ pid: process.pid, configPath: CONFIG_PATH }));
    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => true,
    });
    expect(results).toEqual([
      { lockPath: ownLockPath(), action: GatewayLockCleanupAction.KeptAliveOwner, ownerPid: process.pid },
    ]);
    expect(fs.existsSync(ownLockPath())).toBe(true);
  });

  test('removes an other-hash lock whose payload points at our config with a dead owner', () => {
    const strayPath = path.join(lockDir, 'gateway.deadbeef.lock');
    fs.writeFileSync(strayPath, JSON.stringify({ pid: 4242, configPath: CONFIG_PATH }));
    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => false,
    });
    expect(results).toEqual([
      { lockPath: strayPath, action: GatewayLockCleanupAction.RemovedDeadOwner, ownerPid: 4242 },
    ]);
    expect(fs.existsSync(strayPath)).toBe(false);
  });

  test('leaves foreign locks alone (different config path or unreadable non-matching hash)', () => {
    const foreignReadable = path.join(lockDir, 'gateway.00000001.lock');
    fs.writeFileSync(foreignReadable, JSON.stringify({ pid: 999999, configPath: '/somewhere/else.json' }));
    const foreignUnreadable = path.join(lockDir, 'gateway.00000002.lock');
    fs.writeFileSync(foreignUnreadable, '');
    const unrelatedFile = path.join(lockDir, 'notes.txt');
    fs.writeFileSync(unrelatedFile, 'keep me');

    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => false,
    });
    expect(results).toEqual([]);
    expect(fs.existsSync(foreignReadable)).toBe(true);
    expect(fs.existsSync(foreignUnreadable)).toBe(true);
    expect(fs.existsSync(unrelatedFile)).toBe(true);
  });
});
