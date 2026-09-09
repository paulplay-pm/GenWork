import { ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useMemo, useState } from 'react';

import { bucketCount, reportConversationBlockAction } from './conversationAnalytics';
import { computeDiffStats, type DiffStats, extractDiffFromToolInput } from './DiffView';
import {
  type ActivityChunkEntry,
  type ConsolidatedItem,
  getActivityCurrentActionText,
  getActivityGroupHeaderLabel,
  getActivityGroupSummary,
  isMediaGenerateRunning,
  isMediaStatusPollRunning,
  normalizeToolName,
} from './messageDisplayUtils';

// Aggregate +N/-N line stats across the group's edit/write steps, shown in
// the collapsed header like the Claude Code app. Null when no step changed
// file content.
const getActivityGroupDiffStats = (items: ConsolidatedItem[]): DiffStats | null => {
  let added = 0;
  let removed = 0;
  let hasStats = false;
  for (const item of items) {
    if (item.type !== 'tool_group') continue;
    const rawName = item.group.toolUse.metadata?.toolName;
    const toolName = typeof rawName === 'string' ? rawName : undefined;
    const toolInput = item.group.toolUse.metadata?.toolInput;
    const diffs = extractDiffFromToolInput(toolName, toolInput);
    if (diffs && diffs.length > 0) {
      for (const diff of diffs) {
        const stats = computeDiffStats(diff.oldStr, diff.newStr);
        added += stats.added;
        removed += stats.removed;
      }
      hasStats = true;
      continue;
    }
    // Write tools create content wholesale; count their lines as additions.
    const normalized = toolName ? normalizeToolName(toolName) : '';
    if ((normalized === 'write' || normalized === 'writefile') && typeof toolInput?.content === 'string') {
      const content = toolInput.content;
      added += content.length === 0 ? 0 : content.split('\n').length;
      hasStats = true;
    }
  }
  return hasStats && (added > 0 || removed > 0) ? { added, removed } : null;
};

// Mirrors turnHasSelfIndicatingActivity: whether the step still carries its
// own running state. While live, the header shimmers and the turn-level
// activity indicator stays hidden; in quiet gaps the header goes static and
// the indicator takes over, keeping a single animation on screen.
const isItemLive = (item: ConsolidatedItem): boolean => {
  if (item.type === 'tool_group') {
    return !item.group.toolResult
      || isMediaGenerateRunning(item.group)
      || isMediaStatusPollRunning(item.group);
  }
  if (item.type === 'media_polling_group') {
    return !item.group.isComplete;
  }
  return item.type === 'assistant' && Boolean(item.message.metadata?.isStreaming);
};

/**
 * Collapses a run of consecutive agent work items (tool calls, thinking,
 * media polling) behind a single summary line, following the Codex /
 * Claude Code app pattern: while streaming the header mirrors the latest
 * step; once done it becomes a natural-language summary ("Ran 3 commands,
 * read 2 files"). Expanding reveals a card with one row per step, and each
 * row can be expanded again for full detail. Tool errors stay on their own
 * step row (Codex app behavior); they do not color or expand this header.
 */
const ActivityGroupBlock: React.FC<{
  entries: ActivityChunkEntry[];
  isStreamingTail?: boolean;
  renderEntry: (
    entry: ActivityChunkEntry,
    options?: { initiallyExpanded?: boolean },
  ) => React.ReactNode;
}> = ({ entries, isStreamingTail = false, renderEntry }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const items = useMemo(() => entries.map((entry) => entry.item), [entries]);
  const summary = useMemo(() => getActivityGroupSummary(items), [items]);
  const diffStats = useMemo(() => getActivityGroupDiffStats(items), [items]);

  const lastItem = items[items.length - 1];
  const showLiveAction = isStreamingTail && isItemLive(lastItem);
  const headerLabel = showLiveAction
    ? getActivityCurrentActionText(lastItem)
    : getActivityGroupHeaderLabel(items);

  const handleToggle = () => {
    const nextExpanded = !isExpanded;
    reportConversationBlockAction({
      actionType: nextExpanded ? 'activity_group_expand' : 'activity_group_collapse',
      blockType: 'activity_group',
      params: {
        stepCount: summary.stepCount,
        stepCountBucket: bucketCount(summary.stepCount),
        itemCount: entries.length,
        isStreaming: isStreamingTail,
      },
    });
    setIsExpanded(nextExpanded);
  };

  return (
    <div className="py-1">
      <button
        onClick={handleToggle}
        className="flex max-w-full items-center gap-1.5 text-left group"
        aria-expanded={isExpanded}
      >
        <span className={`min-w-0 truncate text-sm text-secondary group-hover:text-foreground transition-colors ${
          showLiveAction ? 'shimmer-text' : ''
        }`}>
          {headerLabel}
        </span>
        {!showLiveAction && diffStats && (
          <span className="text-sm tabular-nums flex-shrink-0">
            <span className="text-green-600 dark:text-green-400">+{diffStats.added}</span>
            {' '}
            <span className="text-red-500 dark:text-red-400">-{diffStats.removed}</span>
          </span>
        )}
        <ChevronRightIcon
          className={`h-3.5 w-3.5 text-muted group-hover:text-secondary flex-shrink-0 transition-transform duration-200 ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
      </button>
      {isExpanded && (
        <div className="mt-2 w-full overflow-hidden rounded-lg border border-border divide-y divide-border">
          {entries.map((entry) => renderEntry(entry, { initiallyExpanded: entries.length === 1 }))}
        </div>
      )}
    </div>
  );
};

export default ActivityGroupBlock;
