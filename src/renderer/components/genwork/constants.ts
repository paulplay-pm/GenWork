export const CoworkUiEvent = {
  OpenShareOptions: 'genwork:open-share-options',
  SelectSubagent: 'genwork:select-subagent',
  FocusInput: 'genwork:focus-input',
  ShortcutSearch: 'genwork:shortcut:search',
  ShortcutConversationSearch: 'genwork:shortcut:conversation-search',
  ShortcutNewSession: 'genwork:shortcut:new-session',
  ShortcutStopSession: 'genwork:shortcut:stop-session',
  ShortcutToggleArtifacts: 'genwork:shortcut:toggle-artifacts',
  ShortcutSwitchAgent: 'genwork:shortcut:switch-agent',
  ShortcutShowCurrentAgentTasks: 'genwork:shortcut:show-current-agent-tasks',
  ShortcutCollapseCurrentAgentTasks: 'genwork:shortcut:collapse-current-agent-tasks',
  ShortcutOpenAgentTaskSlot: 'genwork:shortcut:open-agent-task-slot',
} as const;

export type CoworkUiEvent = typeof CoworkUiEvent[keyof typeof CoworkUiEvent];

export const CoworkTaskSearchRequestSource = {
  SidebarHeader: 'sidebar_header',
  WindowsTitleBar: 'windows_title_bar',
  KeyboardShortcut: 'keyboard_shortcut',
  UiEvent: 'ui_event',
} as const;

export type CoworkTaskSearchRequestSource =
  typeof CoworkTaskSearchRequestSource[keyof typeof CoworkTaskSearchRequestSource];

export interface CoworkTaskSearchRequestEventDetail {
  source?: CoworkTaskSearchRequestSource;
}

export const CoworkShortcutDirection = {
  Previous: 'previous',
  Next: 'next',
} as const;

export type CoworkShortcutDirection =
  typeof CoworkShortcutDirection[keyof typeof CoworkShortcutDirection];

export interface CoworkOpenShareOptionsEventDetail {
  sessionId: string;
}

export type CoworkSwitchAgentEventDetail = {
  direction: CoworkShortcutDirection;
};

export type CoworkOpenAgentTaskSlotEventDetail = {
  slot: number;
};
