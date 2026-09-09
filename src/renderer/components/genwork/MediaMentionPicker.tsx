import { PhotoIcon, SpeakerWaveIcon, VideoCameraIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  filterMediaLabels,
  type MediaLabel,
  MediaMentionType,
} from './mediaMentionUtils';

interface MediaMentionPickerProps {
  items: MediaLabel[];
  filter: string;
  position: { top: number; left: number };
  onSelect: (item: MediaLabel) => void;
  onDismiss: () => void;
}

const MediaMentionPicker: React.FC<MediaMentionPickerProps> = ({
  items,
  filter,
  position,
  onSelect,
  onDismiss,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => filterMediaLabels(items, filter), [filter, items]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  useEffect(() => {
    setSelectedIndex(i => Math.min(i, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        onSelect(filtered[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss();
    }
  }, [filtered, selectedIndex, onSelect, onDismiss]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onDismiss]);

  if (filtered.length === 0) return null;

  const pickerWidth = 180;
  const left = Math.max(8, Math.min(position.left, window.innerWidth - pickerWidth - 8));
  const bottom = window.innerHeight - position.top + 4;

  return createPortal(
    <div
      ref={containerRef}
      role="listbox"
      aria-activedescendant={`media-mention-${selectedIndex}`}
      className="overflow-hidden rounded-lg border border-[#E8EBF4] bg-white p-1 shadow-lg dark:border-white/10 dark:bg-neutral-900 dark:shadow-black/40"
      style={{ position: 'fixed', left, bottom, width: pickerWidth, zIndex: 10000 }}
    >
      <div className="max-h-[200px] overflow-y-auto">
        {filtered.map((item, idx) => (
          <button
            id={`media-mention-${idx}`}
            key={`${item.mediaType}:${item.index}:${item.attachment.path}`}
            role="option"
            aria-selected={idx === selectedIndex}
            type="button"
            onMouseEnter={() => setSelectedIndex(idx)}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
            className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors ${
              idx === selectedIndex
                ? 'bg-primary/10 text-primary dark:bg-primary/20'
                : 'text-foreground hover:bg-[#F7F8FC] dark:hover:bg-white/5'
            }`}
          >
            <MiniPreview item={item} />
            <span className="truncate font-medium">
              {item.label}
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
};

export default MediaMentionPicker;

const MiniPreview: React.FC<{ item: MediaLabel }> = ({ item }) => {
  const [thumbUrl, setThumbUrl] = useState<string | null>(item.attachment.dataUrl ?? null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);

    if (item.mediaType !== MediaMentionType.Image) {
      setThumbUrl(null);
      return;
    }
    if (item.attachment.dataUrl) {
      setThumbUrl(item.attachment.dataUrl);
      return;
    }
    if (!item.attachment.path || item.attachment.path.startsWith('inline:')) {
      setThumbUrl(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const result = await window.electron?.dialog?.readFileAsDataUrl(item.attachment.path);
        if (!cancelled && result?.success && result.dataUrl) {
          setThumbUrl(result.dataUrl);
        }
      } catch {
        if (!cancelled) setThumbUrl(null);
      }
    })();

    return () => { cancelled = true; };
  }, [item.attachment.dataUrl, item.attachment.path, item.mediaType]);

  if (item.mediaType === MediaMentionType.Image && thumbUrl && !hasError) {
    return (
      <img
        src={thumbUrl}
        alt=""
        className="h-6 w-6 shrink-0 rounded object-cover"
        onError={() => setHasError(true)}
        draggable={false}
      />
    );
  }

  const Icon = item.mediaType === MediaMentionType.Video
    ? VideoCameraIcon
    : item.mediaType === MediaMentionType.Audio
      ? SpeakerWaveIcon
      : PhotoIcon;

  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[#F1F2FA] text-[#777A92] dark:bg-white/10 dark:text-neutral-300">
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
};
