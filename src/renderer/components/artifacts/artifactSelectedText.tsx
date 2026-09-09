import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type CoworkSelectedTextSnippet,
  CoworkSelectedTextSource,
} from '../../../shared/genwork/selectedText';
import { i18nService } from '../../services/i18n';
import type { Artifact } from '../../types/artifact';

export interface ArtifactSelectedTextContext {
  enabled: boolean;
  onAddSelectedText: (snippet: CoworkSelectedTextSnippet) => void;
}

const SELECTED_TEXT_ACTION_HALF_WIDTH = 72;
const SELECTED_TEXT_ACTION_SUPPRESS_MS = 250;

const nodeToElement = (node: Node): Element | null => (
  node instanceof Element ? node : node.parentElement
);

const getSelectionAnchorRect = (range: Range): DOMRect => {
  const lineRects = Array.from(range.getClientRects())
    .filter(rect => rect.width > 0 && rect.height > 0);
  return lineRects[0] ?? range.getBoundingClientRect();
};

const getSelectedTextActionLeft = (rect: DOMRect, container: HTMLDivElement): number => {
  const containerRect = container.getBoundingClientRect();
  const selectionCenterX = rect.left - containerRect.left + rect.width / 2;
  return Math.min(
    container.clientWidth - SELECTED_TEXT_ACTION_HALF_WIDTH,
    Math.max(SELECTED_TEXT_ACTION_HALF_WIDTH, selectionCenterX),
  );
};

const getSelectedTextActionTop = (
  rect: DOMRect,
  container: HTMLDivElement,
): number => {
  const containerRect = container.getBoundingClientRect();
  const rawTop = container.scrollTop + rect.top - containerRect.top - 42;
  const minTop = container.scrollTop + 8;
  const maxTop = container.scrollTop + container.clientHeight - 48;
  return Math.min(maxTop, Math.max(minTop, rawTop));
};

const logArtifactSelectedTextDiagnostic = (message: string): void => {
  console.debug(`[ArtifactSelectedText] ${message}`);
  window.electron?.log?.fromRenderer?.('debug', 'ArtifactSelectedText', message);
};

export function useArtifactSelectedTextAction(options: {
  artifact: Artifact;
  sourceType: typeof CoworkSelectedTextSource.ArtifactMarkdown | typeof CoworkSelectedTextSource.ArtifactText;
  selectedTextContext?: ArtifactSelectedTextContext;
}) {
  const { artifact, selectedTextContext, sourceType } = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const suppressSelectedTextActionUntilRef = useRef(0);
  const [selectedTextAction, setSelectedTextAction] = useState<{
    text: string;
    left: number;
    top: number;
  } | null>(null);

  const closeSelectedTextAction = useCallback((closeOptions: {
    clearSelection?: boolean;
    suppressNextMouseUp?: boolean;
  } = {}) => {
    if (closeOptions.suppressNextMouseUp) {
      suppressSelectedTextActionUntilRef.current = Date.now() + SELECTED_TEXT_ACTION_SUPPRESS_MS;
    }
    if (closeOptions.clearSelection) {
      window.getSelection()?.removeAllRanges();
    }
    setSelectedTextAction(null);
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!selectedTextContext?.enabled) return;
    if (Date.now() < suppressSelectedTextActionUntilRef.current) return;
    suppressSelectedTextActionUntilRef.current = 0;

    const container = containerRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      closeSelectedTextAction();
      return;
    }

    const range = selection.getRangeAt(0);
    const startElement = nodeToElement(range.startContainer);
    const endElement = nodeToElement(range.endContainer);
    const text = selection.toString().trim();
    if (!text || !startElement || !endElement || !container.contains(startElement) || !container.contains(endElement)) {
      closeSelectedTextAction();
      return;
    }

    const rect = getSelectionAnchorRect(range);
    setSelectedTextAction({
      text,
      left: getSelectedTextActionLeft(rect, container),
      top: getSelectedTextActionTop(rect, container),
    });
    logArtifactSelectedTextDiagnostic(
      `prepared an add-to-chat action for ${sourceType} artifact ${artifact.id}; selected ${text.length} characters`,
    );
  }, [artifact.id, closeSelectedTextAction, selectedTextContext?.enabled, sourceType]);

  const handleAddSelectedText = useCallback(() => {
    if (!selectedTextAction || !selectedTextContext?.enabled) return;
    selectedTextContext.onAddSelectedText({
      id: `selected-text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: selectedTextAction.text,
      sourceId: artifact.id,
      sourceType,
      artifactId: artifact.id,
      sourceTitle: artifact.fileName || artifact.title,
      ...(artifact.filePath ? { sourcePath: artifact.filePath } : {}),
      createdAt: Date.now(),
    });
    closeSelectedTextAction({ clearSelection: true });
  }, [artifact.fileName, artifact.filePath, artifact.id, artifact.title, closeSelectedTextAction, selectedTextAction, selectedTextContext, sourceType]);

  useEffect(() => {
    closeSelectedTextAction({ clearSelection: true });
  }, [artifact.id, closeSelectedTextAction]);

  useEffect(() => {
    if (!selectedTextContext?.enabled) {
      closeSelectedTextAction({ clearSelection: true });
    }
  }, [closeSelectedTextAction, selectedTextContext?.enabled]);

  useEffect(() => {
    if (!selectedTextAction) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-cowork-selected-text-action]')) {
        return;
      }
      closeSelectedTextAction({ clearSelection: true, suppressNextMouseUp: true });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSelectedTextAction({ clearSelection: true });
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeSelectedTextAction, selectedTextAction]);

  const actionButton = selectedTextAction ? (
    <button
      type="button"
      data-cowork-selected-text-action
      onClick={handleAddSelectedText}
      className="absolute z-40 -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-popover transition-colors hover:bg-surface-raised"
      style={{ left: selectedTextAction.left, top: selectedTextAction.top }}
    >
      {i18nService.t('coworkSelectedTextAddToChat')}
    </button>
  ) : null;

  return {
    actionButton,
    containerRef,
    handleMouseUp,
  };
}
