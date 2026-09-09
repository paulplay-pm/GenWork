import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { store } from '../store';
import { addMessage, setCurrentSession, setMessageWindow } from '../store/slices/genworkSlice';
import {
  type GenWorkMessage,
  type GenWorkSession,
  GenWorkSessionStatusValue,
} from '../types/genwork';
import { genworkService } from './genwork';

const makeMessages = (count: number): GenWorkMessage[] => Array.from(
  { length: count },
  (_, index) => ({
    id: `message-${index}`,
    type: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    timestamp: index,
  }),
);

const makeSession = (
  messages: GenWorkMessage[],
  messagesOffset: number,
  totalMessages: number,
): GenWorkSession => ({
  id: 'session-1',
  title: 'Session 1',
  openclawSessionId: null,
  scheduledTaskId: null,
  status: GenWorkSessionStatusValue.Completed,
  pinned: false,
  pinOrder: null,
  cwd: '/tmp',
  systemPrompt: '',
  modelOverride: '',
  executionMode: 'local',
  activeSkillIds: [],
  agentId: 'main',
  messages,
  messagesOffset,
  totalMessages,
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(() => {
  genworkService.clearSession();
});

afterEach(() => {
  genworkService.clearSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('genworkService.loadSession', () => {
  test('preserves history already loaded before the default 30-message window', async () => {
    const allMessages = makeMessages(39);
    const defaultPageSession = makeSession(allMessages.slice(9), 9, 39);
    store.dispatch(setCurrentSession(makeSession(allMessages, 0, 39)));

    const getSession = vi.fn(async () => ({ success: true, session: defaultPageSession }));
    const getSessionMessages = vi.fn(async () => ({
      success: true,
      messages: allMessages,
      offset: 0,
      total: 39,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession,
          getSessionMessages,
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    const result = await genworkService.loadSession('session-1', {
      preserveLoadedRange: true,
    });

    expect(getSessionMessages).toHaveBeenCalledWith({
      sessionId: 'session-1',
      offset: 0,
      limit: 39,
    });
    expect(result?.messages).toHaveLength(39);
    expect(result?.messagesOffset).toBe(0);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(39);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(0);
  });

  test('does not request another message page when no earlier history was loaded', async () => {
    const allMessages = makeMessages(39);
    const defaultPageSession = makeSession(allMessages.slice(9), 9, 39);
    store.dispatch(setCurrentSession(defaultPageSession));

    const getSessionMessages = vi.fn();
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(async () => ({ success: true, session: defaultPageSession })),
          getSessionMessages,
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    await genworkService.loadSession('session-1', { preserveLoadedRange: true });

    expect(getSessionMessages).not.toHaveBeenCalled();
  });

  test('keeps the existing history view when preserving the loaded page fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const allMessages = makeMessages(39);
    const fullyLoadedSession = makeSession(allMessages, 0, 39);
    const defaultPageSession = makeSession(allMessages.slice(9), 9, 39);
    store.dispatch(setCurrentSession(fullyLoadedSession));

    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(async () => ({ success: true, session: defaultPageSession })),
          getSessionMessages: vi.fn(async () => {
            throw new Error('message page unavailable');
          }),
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    const result = await genworkService.loadSession('session-1', {
      preserveLoadedRange: true,
    });

    expect(result).toStrictEqual(fullyLoadedSession);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(39);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('keeping the existing view'),
      expect.any(Error),
    );
  });

  test('does not overwrite history that advances while a preserved page is loading', async () => {
    const allMessages = makeMessages(39);
    const messagesWithLiveUpdate = makeMessages(40);
    const defaultPageSession = makeSession(allMessages.slice(9), 9, 39);
    store.dispatch(setCurrentSession(makeSession(allMessages, 0, 39)));

    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(async () => ({ success: true, session: defaultPageSession })),
          getSessionMessages: vi.fn(async () => {
            store.dispatch(setMessageWindow({
              sessionId: 'session-1',
              messages: messagesWithLiveUpdate,
              messagesOffset: 0,
              totalMessages: 40,
            }));
            return {
              success: true,
              messages: allMessages,
              offset: 0,
              total: 39,
            };
          }),
          remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
        },
      },
    });

    const result = await genworkService.loadSession('session-1', {
      preserveLoadedRange: true,
    });

    expect(result?.messages).toHaveLength(40);
    expect(result?.totalMessages).toBe(40);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(40);
  });
});

describe('genworkService.loadMessageWindowAroundIndex', () => {
  test('only applies the newest concurrent window request for a session', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(35, 85), 35, 120)));

    const resolvers = new Map<number, (value: {
      success: boolean;
      messages: GenWorkMessage[];
      offset: number;
      total: number;
    }) => void>();
    const getSessionMessages = vi.fn((options: { offset?: number }) => new Promise<{
      success: boolean;
      messages: GenWorkMessage[];
      offset: number;
      total: number;
    }>(resolve => {
      resolvers.set(options.offset ?? 0, resolve);
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessages },
      },
    });

    const olderRequest = genworkService.loadMessageWindowAroundIndex('session-1', 20);
    const newerRequest = genworkService.loadMessageWindowAroundIndex('session-1', 110);
    resolvers.get(70)?.({
      success: true,
      messages: allMessages.slice(70, 120),
      offset: 70,
      total: 120,
    });
    await expect(newerRequest).resolves.toBe(true);
    resolvers.get(0)?.({
      success: true,
      messages: allMessages.slice(0, 50),
      offset: 0,
      total: 120,
    });

    await expect(olderRequest).resolves.toBe(false);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(70);
    expect(store.getState().cowork.currentSession?.messages.map(message => message.id)).toEqual(
      allMessages.slice(70).map(message => message.id),
    );
  });

  test('does not apply a response after the requesting search target becomes stale', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(70), 70, 120)));

    let resolveMessages!: (value: {
      success: boolean;
      messages: GenWorkMessage[];
      offset: number;
      total: number;
    }) => void;
    const getSessionMessages = vi.fn(() => new Promise<{
      success: boolean;
      messages: GenWorkMessage[];
      offset: number;
      total: number;
    }>(resolve => {
      resolveMessages = resolve;
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessages },
      },
    });

    let isRequestCurrent = true;
    const loadPromise = genworkService.loadMessageWindowAroundIndex('session-1', 20, {
      isRequestCurrent: () => isRequestCurrent,
    });
    isRequestCurrent = false;
    resolveMessages({
      success: true,
      messages: allMessages.slice(0, 50),
      offset: 0,
      total: 120,
    });

    await expect(loadPromise).resolves.toBe(false);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(70);
    expect(store.getState().cowork.currentSession?.messages.map(message => message.id)).toEqual(
      allMessages.slice(70).map(message => message.id),
    );
  });

  test('does not apply a successful page that omits the expected search target', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(70), 70, 120)));
    const getSessionMessages = vi.fn(async () => ({
      success: true,
      messages: allMessages.slice(0, 50),
      offset: 0,
      total: 120,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessages },
      },
    });

    await expect(genworkService.loadMessageWindowAroundIndex('session-1', 20, {
      expectedMessageId: 'message-no-longer-available',
    })).resolves.toBe(false);

    expect(getSessionMessages).toHaveBeenCalledTimes(1);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(70);
    expect(store.getState().cowork.currentSession?.messages.map(message => message.id)).toEqual(
      allMessages.slice(70).map(message => message.id),
    );
  });

  test('does not let an older window response roll back a live message total', async () => {
    const allMessages = makeMessages(121);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(70, 120), 70, 120)));

    let resolveMessages!: (value: {
      success: boolean;
      messages: GenWorkMessage[];
      offset: number;
      total: number;
    }) => void;
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionMessages: vi.fn(() => new Promise(resolve => {
            resolveMessages = resolve;
          })),
        },
      },
    });

    const loadPromise = genworkService.loadMessageWindowAroundIndex('session-1', 20);
    store.dispatch(addMessage({ sessionId: 'session-1', message: allMessages[120] }));
    resolveMessages({
      success: true,
      messages: allMessages.slice(0, 50),
      offset: 0,
      total: 120,
    });

    await expect(loadPromise).resolves.toBe(true);
    expect(store.getState().cowork.currentSession?.totalMessages).toBe(121);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(0);
    expect(store.getState().cowork.detachedTailMessagesBySessionId['session-1']?.[50]?.id)
      .toBe('message-120');
  });

  test('accepts a lower authoritative total when the timeline shrank without a live race', async () => {
    const allMessages = makeMessages(10);
    store.dispatch(setCurrentSession(makeSession(allMessages, 0, 12)));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionMessages: vi.fn(async () => ({
            success: true,
            messages: allMessages,
            offset: 0,
            total: 10,
          })),
        },
      },
    });

    await expect(genworkService.loadMessageWindowAroundIndex('session-1', 9)).resolves.toBe(true);
    expect(store.getState().cowork.currentSession?.totalMessages).toBe(10);
  });
});

describe('genworkService.loadMoreMessages', () => {
  test('ignores an older page when search navigation replaces the window in flight', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(50, 100), 50, 120)));
    let resolveOlderPage!: (value: {
      success: boolean;
      messages: GenWorkMessage[];
      offset: number;
      total: number;
    }) => void;
    let requestCount = 0;
    const getSessionMessages = vi.fn(() => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise(resolve => {
          resolveOlderPage = resolve;
        });
      }
      return Promise.resolve({
        success: true,
        messages: allMessages.slice(0, 50),
        offset: 0,
        total: 120,
      });
    });
    vi.stubGlobal('window', {
      electron: { cowork: { getSessionMessages } },
    });

    const olderPagePromise = genworkService.loadMoreMessages('session-1');
    await expect(genworkService.loadMessageWindowAroundIndex('session-1', 20)).resolves.toBe(true);
    resolveOlderPage({
      success: true,
      messages: allMessages.slice(0, 50),
      offset: 0,
      total: 120,
    });

    await expect(olderPagePromise).resolves.toBe(false);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(0);
    expect(store.getState().cowork.currentSession?.messages.map(message => message.id)).toEqual(
      allMessages.slice(0, 50).map(message => message.id),
    );
  });
});

describe('genworkService.loadNewerMessages', () => {
  test('appends the page after the current message window', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(20, 70), 20, 120)));
    const getSessionMessages = vi.fn(async () => ({
      success: true,
      messages: allMessages.slice(70, 120),
      offset: 70,
      total: 120,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessages },
      },
    });

    await expect(genworkService.loadNewerMessages('session-1')).resolves.toBe(true);

    expect(getSessionMessages).toHaveBeenCalledWith({
      sessionId: 'session-1',
      offset: 70,
      limit: 50,
    });
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(100);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(20);
    const loadedMessages = store.getState().cowork.currentSession?.messages ?? [];
    expect(loadedMessages[loadedMessages.length - 1]?.id).toBe('message-119');
  });

  test('ignores a newer page when navigation replaced the active window while loading', async () => {
    const allMessages = makeMessages(120);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(20, 70), 20, 120)));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionMessages: vi.fn(async () => {
            store.dispatch(setMessageWindow({
              sessionId: 'session-1',
              messages: allMessages.slice(0, 50),
              messagesOffset: 0,
              totalMessages: 120,
            }));
            return {
              success: true,
              messages: allMessages.slice(70, 120),
              offset: 70,
              total: 120,
            };
          }),
        },
      },
    });

    await expect(genworkService.loadNewerMessages('session-1')).resolves.toBe(false);
    expect(store.getState().cowork.currentSession?.messagesOffset).toBe(0);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(50);
    const loadedMessages = store.getState().cowork.currentSession?.messages ?? [];
    expect(loadedMessages[loadedMessages.length - 1]?.id).toBe('message-49');
  });

  test('keeps a middle window contiguous when live tail messages arrive before pagination', async () => {
    const allMessages = makeMessages(121);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(20, 70), 20, 120)));
    store.dispatch(addMessage({ sessionId: 'session-1', message: allMessages[120] }));

    expect(store.getState().cowork.currentSession?.messages).toHaveLength(50);
    expect(store.getState().cowork.currentSession?.totalMessages).toBe(121);

    const getSessionMessages = vi.fn(async (options: {
      sessionId: string;
      limit?: number;
      offset?: number;
    }) => ({
      success: true,
      messages: options.offset === 70
        ? allMessages.slice(70, 120)
        : allMessages.slice(120, 121),
      offset: options.offset,
      total: 121,
    }));
    vi.stubGlobal('window', {
      electron: {
        cowork: { getSessionMessages },
      },
    });

    await expect(genworkService.loadNewerMessages('session-1')).resolves.toBe(true);
    await expect(genworkService.loadNewerMessages('session-1')).resolves.toBe(true);

    expect(getSessionMessages).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      offset: 70,
      limit: 50,
    });
    expect(getSessionMessages).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      offset: 120,
      limit: 1,
    });
    expect(store.getState().cowork.currentSession?.messages.map(message => message.id)).toEqual(
      allMessages.slice(20).map(message => message.id),
    );
    expect(store.getState().cowork.detachedTailMessagesBySessionId['session-1']).toBeUndefined();
  });

  test('returns false when a newer page contains no new message ids', async () => {
    const allMessages = makeMessages(121);
    store.dispatch(setCurrentSession(makeSession(allMessages.slice(20, 120), 20, 121)));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionMessages: vi.fn(async () => ({
            success: true,
            messages: [allMessages[119]],
            offset: 120,
            total: 121,
          })),
        },
      },
    });

    await expect(genworkService.loadNewerMessages('session-1')).resolves.toBe(false);
    expect(store.getState().cowork.currentSession?.messages).toHaveLength(100);
  });
});
