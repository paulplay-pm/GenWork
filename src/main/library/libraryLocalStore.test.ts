import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryFavoriteScope,
  LibraryItemKind,
  LibraryOrigin,
  LibraryRelationKind,
} from '../../shared/library/constants';
import type { LibraryArtifactCandidate } from '../../shared/library/types';
import { LibraryLocalStore } from './libraryLocalStore';
import { initializeLibraryTables } from './libraryMigrations';

describe('LibraryLocalStore', () => {
  let db: Database.Database;
  let store: LibraryLocalStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE genwork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        agent_id TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    initializeLibraryTables(db);
    initializeLibraryTables(db);
    store = new LibraryLocalStore(db);
  });

  afterEach(() => db.close());

  const insertSession = (id: string, title: string, updatedAt: number) => {
    db.prepare(`
      INSERT INTO genwork_sessions (id, title, cwd, agent_id, updated_at)
      VALUES (?, ?, '/workspace', 'main', ?)
    `).run(id, title, updatedAt);
  };

  const candidate = (
    sessionId: string,
    relatedAt: number,
    relationKind = LibraryRelationKind.Modified,
  ): LibraryArtifactCandidate => ({
    sessionId,
    messageId: `message-${sessionId}`,
    sessionArtifactId: `artifact-${sessionId}`,
    filePath: '/workspace/report.pdf',
    detectedType: LibraryArtifactType.Document,
    relationKind,
    relatedAt,
    origin: LibraryOrigin.Conversation,
  });

  const indexedFile = (mtime: number, origin = LibraryOrigin.Conversation) => ({
    pathKey: '/workspace/report.pdf',
    filePath: '/workspace/report.pdf',
    fileName: 'report.pdf',
    extension: '.pdf',
    artifactType: LibraryArtifactType.Document,
    category: LibraryCategory.Document,
    sizeBytes: 128,
    fileMtimeMs: mtime,
    availability: LibraryAvailability.Available,
    origin,
    verifiedAt: mtime,
  });

  const upsertLinkedFile = (
    file = indexedFile(100),
    relation = candidate('session-1', 100),
  ) => {
    const item = store.upsertFile(file, relation);
    if (!item) throw new Error('Expected a visible task-linked artifact.');
    return item;
  };

  const deleteSession = (sessionId: string) => {
    db.transaction(() => {
      db.prepare('DELETE FROM library_artifact_sessions WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM genwork_sessions WHERE id = ?').run(sessionId);
    })();
  };

  test('keeps one artifact with many sessions and resolves the latest valid session', () => {
    insertSession('session-1', 'First session', 100);
    insertSession('session-2', 'Latest session', 200);

    const first = upsertLinkedFile(indexedFile(100), candidate('session-1', 100));
    const second = upsertLinkedFile(indexedFile(200), candidate('session-2', 200));

    expect(second.itemId).toBe(first.itemId);
    expect(store.list().list).toHaveLength(1);
    expect(store.list().list[0]).toMatchObject({
      relatedSessionCount: 2,
      latestSession: { sessionId: 'session-2', title: 'Latest session' },
    });

    deleteSession('session-2');
    expect(store.list().list[0].latestSession.sessionId).toBe('session-1');
  });

  test('hides an artifact after its last task is deleted while preserving index and favorite', () => {
    insertSession('session-1', 'Only task', 100);
    const item = upsertLinkedFile();
    store.setFavorite({
      ownerScope: LibraryFavoriteScope.LocalDevice,
      itemKind: LibraryItemKind.LocalArtifact,
      itemId: item.itemId,
      favorite: true,
    });

    deleteSession('session-1');

    expect(store.list()).toMatchObject({
      list: [],
      counts: { total: 0, available: 0, missing: 0 },
    });
    expect(store.list({ favoritesOnly: true }).list).toEqual([]);
    expect(store.getDetail(item.itemId)).toBeNull();
    expect(store.getItem(item.itemId)).toMatchObject({
      itemId: item.itemId,
      isFavorite: true,
      relatedSessionCount: 0,
    });
    expect(store.getItem(item.itemId)?.latestSession).toBeUndefined();
    expect(store.resolvePath(item.itemId)).toBe('/workspace/report.pdf');
  });

  test('batch reads visible items and reports hidden or unknown identifiers', () => {
    insertSession('session-1', 'Visible task', 100);
    const visible = upsertLinkedFile();
    const hidden = store.upsertFile({
      ...indexedFile(200, LibraryOrigin.Manual),
      pathKey: '/workspace/hidden.pdf',
      filePath: '/workspace/hidden.pdf',
      fileName: 'hidden.pdf',
    });

    expect(store.getVisibleItems([visible.itemId, hidden.itemId, 'unknown'])).toEqual({
      items: [expect.objectContaining({ itemId: visible.itemId })],
      unavailableItemIds: [hidden.itemId, 'unknown'],
    });
  });

  test('restores the same indexed artifact and favorite when a new task links the file', () => {
    insertSession('session-1', 'Deleted task', 100);
    const item = upsertLinkedFile();
    store.setFavorite({
      ownerScope: LibraryFavoriteScope.LocalDevice,
      itemKind: LibraryItemKind.LocalArtifact,
      itemId: item.itemId,
      favorite: true,
    });
    deleteSession('session-1');
    insertSession('session-2', 'Replacement task', 200);

    const restored = upsertLinkedFile(indexedFile(200), candidate('session-2', 200));

    expect(restored).toMatchObject({
      itemId: item.itemId,
      isFavorite: true,
      relatedSessionCount: 1,
      latestSession: { sessionId: 'session-2', title: 'Replacement task' },
    });
    expect(store.list({ favoritesOnly: true }).list).toHaveLength(1);
  });

  test('shows artifacts carrying obsolete hidden metadata from an older local database', () => {
    insertSession('session-1', 'Session', 100);
    const item = upsertLinkedFile();
    db.exec('ALTER TABLE library_local_artifacts ADD COLUMN hidden_at INTEGER');
    db.prepare('UPDATE library_local_artifacts SET hidden_at = ? WHERE id = ?')
      .run(100, item.itemId);

    expect(store.list().list).toHaveLength(1);
  });

  test('keeps the strongest relation kind while updating the latest relation metadata', () => {
    insertSession('session-1', 'Session', 100);
    const item = upsertLinkedFile(
      indexedFile(100),
      candidate('session-1', 100, LibraryRelationKind.Created),
    );
    upsertLinkedFile(
      indexedFile(200),
      candidate('session-1', 200, LibraryRelationKind.Referenced),
    );

    expect(store.getDetail(item.itemId)?.sessions[0]).toMatchObject({
      relationKind: LibraryRelationKind.Created,
      lastRelatedAt: 200,
    });
  });

  test('hides missing files from normal results and removes their local favorite', () => {
    insertSession('session-1', 'Session', 100);
    const item = upsertLinkedFile();
    store.setFavorite({
      ownerScope: LibraryFavoriteScope.LocalDevice,
      itemKind: LibraryItemKind.LocalArtifact,
      itemId: item.itemId,
      favorite: true,
    });

    expect(store.markMissing(item.itemId, 200)).toBe(true);
    expect(store.list().list).toHaveLength(0);
    expect(store.getItem(item.itemId)).toMatchObject({
      availability: LibraryAvailability.Missing,
      isFavorite: false,
    });
  });

  test('isolates local favorites and paginates deterministically', () => {
    insertSession('session-1', 'Session', 100);
    const first = upsertLinkedFile();
    upsertLinkedFile({
      ...indexedFile(200),
      pathKey: '/workspace/slides.pptx',
      filePath: '/workspace/slides.pptx',
      fileName: 'slides.pptx',
      extension: '.pptx',
      category: LibraryCategory.Slides,
    }, {
      ...candidate('session-1', 200),
      filePath: '/workspace/slides.pptx',
    });
    store.setFavorite({
      ownerScope: LibraryFavoriteScope.LocalDevice,
      itemKind: LibraryItemKind.LocalArtifact,
      itemId: first.itemId,
      favorite: true,
    });

    const pageOne = store.list({ pageSize: 1 });
    const pageTwo = store.list({ pageSize: 1, cursor: pageOne.nextCursor });
    expect(pageOne.hasMore).toBe(true);
    expect(pageTwo.list).toHaveLength(1);
    expect(pageTwo.list[0].itemId).not.toBe(pageOne.list[0].itemId);
    expect(store.list({ favoritesOnly: true }).list.map(item => item.itemId)).toEqual([first.itemId]);
  });

  test('applies task visibility before pagination so hidden rows cannot create short pages', () => {
    insertSession('session-1', 'Task', 100);
    const hidden = store.upsertFile(indexedFile(400, LibraryOrigin.Manual));
    const newest = upsertLinkedFile({
      ...indexedFile(300),
      pathKey: '/workspace/newest.pdf',
      filePath: '/workspace/newest.pdf',
      fileName: 'newest.pdf',
    }, {
      ...candidate('session-1', 300),
      filePath: '/workspace/newest.pdf',
    });
    const oldest = upsertLinkedFile({
      ...indexedFile(200),
      pathKey: '/workspace/oldest.pdf',
      filePath: '/workspace/oldest.pdf',
      fileName: 'oldest.pdf',
    }, {
      ...candidate('session-1', 200),
      filePath: '/workspace/oldest.pdf',
    });

    const pageOne = store.list({ pageSize: 1 });
    const pageTwo = store.list({ pageSize: 1, cursor: pageOne.nextCursor });

    expect(pageOne.list.map(item => item.itemId)).toEqual([newest.itemId]);
    expect(pageOne.hasMore).toBe(true);
    expect(pageTwo.list.map(item => item.itemId)).toEqual([oldest.itemId]);
    expect(pageTwo.hasMore).toBe(false);
    expect(store.getItem(hidden.itemId)).not.toBeNull();
    expect(store.list().counts.total).toBe(2);
  });

  test('rejects a late relation when its task no longer exists', () => {
    const stored = store.upsertFile(indexedFile(100, LibraryOrigin.Manual));

    const rejected = store.upsertFile(indexedFile(200), candidate('deleted-session', 200));

    expect(rejected).toBeNull();
    expect(store.list().list).toEqual([]);
    expect(store.getItem(stored.itemId)).toMatchObject({
      itemId: stored.itemId,
      sortTime: 100,
      relatedSessionCount: 0,
    });
    const relationCount = db.prepare(`
      SELECT COUNT(*) AS count FROM library_artifact_sessions
    `).get() as { count: number };
    expect(relationCount.count).toBe(0);
  });
});
