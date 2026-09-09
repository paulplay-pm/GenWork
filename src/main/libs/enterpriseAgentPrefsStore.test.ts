import BetterSqlite3 from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

import { EnterpriseAgentPrefsStore } from './enterpriseAgentPrefsStore';

let db: BetterSqlite3.Database;
let store: EnterpriseAgentPrefsStore;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS enterprise_agent_prefs (
    enterprise_agent_id TEXT PRIMARY KEY,
    working_directory TEXT NOT NULL DEFAULT '',
    model_ref TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );`);
  store = new EnterpriseAgentPrefsStore(db);
});

describe('EnterpriseAgentPrefsStore', () => {
  test('upsert + get round-trip', () => {
    expect(store.get('a')).toBe('');
    store.upsert('a', '/tmp/work');
    expect(store.get('a')).toBe('/tmp/work');
  });

  test('remove deletes the row', () => {
    store.upsert('a', '/tmp/x');
    store.remove('a');
    expect(store.get('a')).toBe('');
  });

  test('upsert overwrites and updates updated_at', async () => {
    store.upsert('a', '/first');
    const first = db.prepare('SELECT updated_at AS u FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?').get('a') as { u: number };
    await new Promise(r => setTimeout(r, 5));
    store.upsert('a', '/second');
    const second = db.prepare('SELECT working_directory AS wd FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?').get('a') as { wd: string };
    expect(second.wd).toBe('/second');
    const row = db.prepare('SELECT updated_at AS u FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?').get('a') as { u: number };
    expect(row.u).toBeGreaterThanOrEqual(first.u);
  });

  test('getModel/setModel round-trip and coexist with working_directory', () => {
    store.setModel('ent-1', 'genwork/opus-4');
    expect(store.getModel('ent-1')).toBe('genwork/opus-4');
    store.upsert('ent-1', '/some/dir');
    expect(store.get('ent-1')).toBe('/some/dir');
    expect(store.getModel('ent-1')).toBe('genwork/opus-4'); // preserved across upsert
  });
});
