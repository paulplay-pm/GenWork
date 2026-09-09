import { createSelector } from '@reduxjs/toolkit';

import { SESSION_AGNOSTIC_PERMISSION_SESSION_ID } from '../../../shared/genwork/constants';
import type { GenWorkMessage } from '../../types/genwork';
import type { RootState } from '../index';

const EMPTY_COWORK_MESSAGES: GenWorkMessage[] = [];

// --- Primitive (identity) selectors ---
// These return stable references for primitive values or existing object refs,
// so useSelector's default === check is enough to skip re-renders.

export const selectCoworkSessions = (state: RootState) => state.cowork.sessions;
export const selectCurrentSessionId = (state: RootState) => state.cowork.currentSessionId;
export const selectCurrentSession = (state: RootState) => state.cowork.currentSession;
export const selectSessionNavigationTargetId = (
  state: RootState,
) => state.cowork.sessionNavigationTargetId;
export const selectIsStreaming = (state: RootState) => state.cowork.isStreaming;
export const selectIsCoworkActive = (state: RootState) => state.cowork.isCoworkActive;
export const selectRemoteManaged = (state: RootState) => state.cowork.remoteManaged;
export const selectCoworkConfig = (state: RootState) => state.cowork.config;
export const selectDraftPrompts = (state: RootState) => state.cowork.draftPrompts;
export const selectPendingPermissions = (state: RootState) => state.cowork.pendingPermissions;
export const selectUnreadSessionIds = (state: RootState) => state.cowork.unreadSessionIds;
export const selectCompletedUnreadSessionIds = (
  state: RootState,
) => state.cowork.completedUnreadSessionIds;

// --- Derived (memoized) selectors ---
// These compute new values from the store and use createSelector to avoid
// returning new object references when the inputs haven't changed.

export const selectAgentEngine = createSelector(
  selectCoworkConfig,
  (config) => config.agentEngine,
);

export const selectIsOpenClawEngine = createSelector(
  selectAgentEngine,
  (engine) => engine === 'openclaw',
);

export const selectCurrentMessages = createSelector(
  selectCurrentSession,
  (session) => session?.messages ?? null,
);

const selectCurrentSessionDetachedTailMessages = (state: RootState): GenWorkMessage[] => {
  const sessionId = state.cowork.currentSession?.id;
  return sessionId
    ? state.cowork.detachedTailMessagesBySessionId[sessionId] ?? EMPTY_COWORK_MESSAGES
    : EMPTY_COWORK_MESSAGES;
};

export const selectCurrentMessagesWithDetachedTail = createSelector(
  selectCurrentMessages,
  selectCurrentSessionDetachedTailMessages,
  (messages, detachedTailMessages) => {
    if (!messages) return EMPTY_COWORK_MESSAGES;
    if (detachedTailMessages.length === 0) return messages;
    const detachedById = new Map(detachedTailMessages.map(message => [message.id, message]));
    const loadedIds = new Set(messages.map(message => message.id));
    return [
      ...messages.map(message => detachedById.get(message.id) ?? message),
      ...detachedTailMessages.filter(message => !loadedIds.has(message.id)),
    ];
  },
);

export const selectCurrentMessagesLength = createSelector(
  selectCurrentMessages,
  (messages) => messages?.length ?? 0,
);

export const selectLastMessageContent = createSelector(
  selectCurrentMessages,
  (messages) => {
    if (!messages || messages.length === 0) return undefined;
    return messages[messages.length - 1]?.content;
  },
);

export const selectFirstPendingPermission = createSelector(
  selectPendingPermissions,
  (permissions) => permissions[0] ?? null,
);

export const selectFirstCurrentSessionPendingPermission = createSelector(
  selectPendingPermissions,
  selectCurrentSessionId,
  (permissions, currentSessionId) => {
    const sessionScoped = currentSessionId
      ? permissions.find((permission) => permission.sessionId === currentSessionId)
      : undefined;
    if (sessionScoped) return sessionScoped;
    // Session-agnostic requests carry a sentinel sessionId that never matches a
    // real session; they must surface wherever the user is or they silently
    // time out (the runtime auto-denies after 120s).
    return permissions.find(
      (permission) => permission.sessionId === SESSION_AGNOSTIC_PERMISSION_SESSION_ID
    ) ?? null;
  },
);

export const selectPendingPermissionSessionIds = createSelector(
  selectPendingPermissions,
  (permissions) => permissions.map((permission) => permission.sessionId),
);
