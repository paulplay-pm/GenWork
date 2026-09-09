import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import {
  getCoworkParentSessionId,
  isCoworkSessionBoundToIm,
  resolveCoworkSessionIdByOpenClawSessionKey,
  resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey,
} from './openclawLocalSessionResolver';

const dbs: Database.Database[] = [];

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  dbs.push(db);
  db.exec(`
    CREATE TABLE genwork_sessions (
      id TEXT PRIMARY KEY,
      openclaw_session_id TEXT,
      parent_session_id TEXT
    );
    CREATE TABLE subagent_runs (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      session_key TEXT,
      child_cowork_session_id TEXT,
      agent_id TEXT,
      task TEXT,
      label TEXT,
      status TEXT,
      created_at INTEGER,
      ended_at INTEGER
    );
    CREATE TABLE im_session_mappings (
      cowork_session_id TEXT
    );
  `);
  return db;
};

const insertSession = (
  db: Database.Database,
  id: string,
  openclawSessionId: string | null = null,
  parentSessionId: string | null = null,
) => {
  db.prepare('INSERT INTO genwork_sessions (id, openclaw_session_id, parent_session_id) VALUES (?, ?, ?)')
    .run(id, openclawSessionId, parentSessionId);
};

const insertSubagentRun = (
  db: Database.Database,
  id: string,
  parentSessionId: string | null,
  sessionKey: string | null = null,
) => {
  db.prepare(`INSERT INTO subagent_runs
    (id, parent_session_id, session_key, child_cowork_session_id, agent_id, task, label, status, created_at, ended_at)
    VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 'running', 0, NULL)`).run(id, parentSessionId, sessionKey);
};

afterEach(() => {
  while (dbs.length > 0) {
    dbs.pop()?.close();
  }
});

describe('openclaw local session resolver', () => {
  test('resolves managed desktop session keys across agents', () => {
    const db = createDb();
    insertSession(db, 'session-1');

    expect(resolveCoworkSessionIdByOpenClawSessionKey(
      db,
      'agent:qa-reviewer:genwork:session-1',
    )).toBe('session-1');
  });

  test('resolves materialized subagent child session keys', () => {
    const db = createDb();
    insertSession(db, 'parent-1');
    insertSession(db, 'child-1', 'agent:qa-reviewer:subagent:run-1', 'parent-1');

    expect(resolveCoworkSessionIdByOpenClawSessionKey(
      db,
      'agent:qa-reviewer:subagent:run-1',
    )).toBe('child-1');
    expect(getCoworkParentSessionId(db, 'child-1')).toBe('parent-1');
  });

  test('rejects IM-bound sessions and descendants for desktop callbacks', () => {
    const db = createDb();
    insertSession(db, 'im-parent');
    insertSession(db, 'im-child', 'agent:qa-reviewer:subagent:run-2', 'im-parent');
    db.prepare('INSERT INTO im_session_mappings (cowork_session_id) VALUES (?)').run('im-parent');

    expect(isCoworkSessionBoundToIm(db, 'im-child')).toBe(true);
    expect(resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey(
      db,
      'agent:qa-reviewer:subagent:run-2',
    )).toBe(null);
  });

  test('resolves subagent child session via subagent_runs back-pointer when genwork_sessions row missing', () => {
    const db = createDb();
    insertSession(db, 'parent-1');
    insertSubagentRun(db, 'run-1', 'parent-1', 'agent:qa-reviewer:subagent:run-1');

    expect(resolveCoworkSessionIdByOpenClawSessionKey(
      db,
      'agent:qa-reviewer:subagent:run-1',
    )).toBe('parent-1');
  });

  test('prefers genwork_sessions row over subagent_runs back-pointer when both exist', () => {
    const db = createDb();
    insertSession(db, 'parent-1');
    insertSession(db, 'child-1', 'agent:qa-reviewer:subagent:run-1', 'parent-1');
    insertSubagentRun(db, 'run-1', 'parent-1', 'agent:qa-reviewer:subagent:run-1');

    expect(resolveCoworkSessionIdByOpenClawSessionKey(
      db,
      'agent:qa-reviewer:subagent:run-1',
    )).toBe('child-1');
  });

  test('returns null for subagent key with no back-pointer and no session row', () => {
    const db = createDb();
    insertSession(db, 'parent-1');

    expect(resolveCoworkSessionIdByOpenClawSessionKey(
      db,
      'agent:qa-reviewer:subagent:unknown',
    )).toBe(null);
  });
});
