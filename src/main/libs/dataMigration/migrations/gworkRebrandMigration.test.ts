import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from 'vitest';

import {
  adoptLegacySqliteFile,
  runGenworkRebrandMigration,
} from './genworkRebrandMigration';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT
    );
    CREATE TABLE cowork_messages (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE cowork_session_capsules (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE cowork_config (
      key TEXT PRIMARY KEY
    );
    CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  db.prepare(
    `INSERT INTO cowork_sessions (id, claude_session_id) VALUES (?, ?)`,
  ).run('s1', 'openclaw-sess-1');
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)`,
  ).run('genwork:user', '"alice"');
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)`,
  ).run('cowork:window', '"main"');
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)`,
  ).run('app_config', '"{}"');
  return db;
}

describe('runGenworkRebrandMigration', () => {
  test('renames cowork_* tables and claude_session_id column', () => {
    const db = freshDb();
    const result = runGenworkRebrandMigration(db, '/tmp/whatever');
    expect(result.renamedTables).toEqual(
      expect.arrayContaining([
        'cowork_sessions',
        'cowork_messages',
        'cowork_config',
        'cowork_session_capsules',
      ]),
    );
    expect(result.renamedColumns).toEqual([
      { table: 'genwork_sessions', from: 'claude_session_id', to: 'openclaw_session_id' },
    ]);
    const cols = db
      .prepare(`PRAGMA table_info('genwork_sessions')`)
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('openclaw_session_id');
    db.close();
  });

  test('rewrites kv keys with genwork: / cowork: prefixes', () => {
    const db = freshDb();
    runGenworkRebrandMigration(db, '/tmp/whatever');
    const rows = db.prepare(`SELECT key FROM kv ORDER BY key`).all() as Array<{
      key: string;
    }>;
    expect(rows.map((r) => r.key)).toEqual([
      'app_config',
      'genwork:user',
      'genwork:window',
    ]);
    db.close();
  });

  test('is idempotent — running twice does not error', () => {
    const db = freshDb();
    runGenworkRebrandMigration(db, '/tmp/whatever');
    const second = runGenworkRebrandMigration(db, '/tmp/whatever');
    expect(second.renamedTables).toEqual([]);
    expect(second.renamedColumns).toEqual([]);
    expect(second.renamedKvKeys).toEqual([]);
    db.close();
  });
});

describe('adoptLegacySqliteFile', () => {
  test('renames genwork.sqlite from the legacy Genwork UserData dir into the current UserData dir', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'genwork-mig-home-'));
    const legacyDir = (() => {
      switch (process.platform) {
        case 'darwin':
          return path.join(fakeHome, 'Library', 'Application Support', 'Genwork');
        case 'win32':
          return path.join(fakeHome, 'AppData', 'Roaming', 'Genwork');
        default:
          return path.join(fakeHome, '.config', 'Genwork');
      }
    })();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'genwork.sqlite'), 'legacy');
    fs.writeFileSync(path.join(legacyDir, 'genwork.sqlite-wal'), 'legacy-wal');

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousAppData = process.env.APPDATA;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
    process.env.XDG_CONFIG_HOME = path.join(fakeHome, '.config');

    const currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genwork-mig-current-'));
    try {
      const moved = adoptLegacySqliteFile(currentDir);
      expect(moved).toBe(true);
      expect(fs.existsSync(path.join(currentDir, 'genwork.sqlite'))).toBe(true);
      expect(fs.existsSync(path.join(currentDir, 'genwork.sqlite-wal'))).toBe(true);
      expect(fs.existsSync(path.join(legacyDir, 'genwork.sqlite'))).toBe(false);
      expect(fs.existsSync(path.join(legacyDir, 'genwork.sqlite-wal'))).toBe(false);
    } finally {
      process.env.HOME = previousHome;
      process.env.USERPROFILE = previousUserProfile;
      process.env.APPDATA = previousAppData;
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  test('does not overwrite an existing genwork.sqlite in the current UserData dir', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'genwork-mig-home-'));
    const legacyDir = (() => {
      switch (process.platform) {
        case 'darwin':
          return path.join(fakeHome, 'Library', 'Application Support', 'Genwork');
        case 'win32':
          return path.join(fakeHome, 'AppData', 'Roaming', 'Genwork');
        default:
          return path.join(fakeHome, '.config', 'Genwork');
      }
    })();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'genwork.sqlite'), 'legacy');

    const currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genwork-mig-current-'));
    fs.writeFileSync(path.join(currentDir, 'genwork.sqlite'), 'fresh');

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousAppData = process.env.APPDATA;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
    process.env.XDG_CONFIG_HOME = path.join(fakeHome, '.config');

    try {
      const moved = adoptLegacySqliteFile(currentDir);
      expect(moved).toBe(false);
      expect(fs.readFileSync(path.join(currentDir, 'genwork.sqlite'), 'utf8')).toBe('fresh');
      expect(fs.existsSync(path.join(legacyDir, 'genwork.sqlite'))).toBe(true);
    } finally {
      process.env.HOME = previousHome;
      process.env.USERPROFILE = previousUserProfile;
      process.env.APPDATA = previousAppData;
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });
});
