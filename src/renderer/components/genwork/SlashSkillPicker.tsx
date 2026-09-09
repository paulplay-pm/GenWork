import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { Skill } from '../../types/skill';
import SkillIconTile from '../skills/SkillIconTile';

interface SlashSkillPickerProps {
  /** Full skill list (enabled + disabled); the picker shows enabled only. */
  skills: Skill[];
  /** Live filter typed after the "/". */
  filter: string;
  /** Caret pixel position to anchor the picker above. */
  position: { top: number; left: number };
  onSelect: (skill: Skill) => void;
  onDismiss: () => void;
}

/**
 * Caret-anchored, single-select list of enabled skills opened by typing "/"
 * at the start of a prompt. Mirrors MediaMentionPicker's shell (portal +
 * keyboard nav + click-outside) but lists skills, grouped Mine → Built-in
 * exactly like the ⚇ skills popover, and selects on click/Enter.
 */
const SlashSkillPicker: React.FC<SlashSkillPickerProps> = ({
  skills,
  filter,
  position,
  onSelect,
  onDismiss,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Mirror of selectedIndex for synchronous reads (keyboard stepping). The DOM
  // scroll event updates state asynchronously, so a rapid ↑/↓ sequence could
  // otherwise read a stale index.
  const selectedIndexRef = useRef(0);
  // The scrollTop the keyboard last set to scroll an item into view. Recognized
  // in handleListScroll so that programmatic scroll doesn't recompute the
  // highlight from position (which, near the bottom, would snap back and clobber
  // the keyboard's selection). -1 means "no pending programmatic scroll".
  const programmaticScrollTopRef = useRef(-1);
  const setSelected = useCallback((i: number) => {
    selectedIndexRef.current = i;
    setSelectedIndex(i);
  }, []);

  const { mySkills, builtInSkills, totalCount } = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const matches = (skill: Skill) => {
      if (!query) return true;
      const name = skillService.getLocalizedSkillName(skill.id, skill.name);
      const description = skillService.getLocalizedSkillDescription(
        skill.id, skill.name, skill.description,
      );
      return name.toLowerCase().includes(query) || description.toLowerCase().includes(query);
    };
    const enabled = skills.filter(skill => skill.enabled).filter(matches);
    const mine = enabled
      .filter(skill => !skill.isBuiltIn)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const builtIn = enabled.filter(skill => skill.isBuiltIn);
    return { mySkills: mine, builtInSkills: builtIn, totalCount: mine.length + builtIn.length };
  }, [skills, filter]);

  const flatItems = useMemo(() => [...mySkills, ...builtInSkills], [mySkills, builtInSkills]);

  // Reset to the top when the filter changes (list re-sorts).
  useEffect(() => {
    setSelected(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [filter, setSelected]);

  // Clamp when the visible count shrinks (filter narrows the list).
  useEffect(() => {
    setSelected(Math.min(selectedIndexRef.current, Math.max(flatItems.length - 1, 0)));
  }, [flatItems.length, setSelected]);

  // The highlight is driven purely by the list's scroll position: it is the
  // item at the TOP of the visible area. Scrolling therefore steps the
  // highlight forward/backward one item at a time (continuous "scroll-select")
  // and never forces the scroll back, so there is no jump. When scrolled all
  // the way down, the last item can't reach the top edge, so select it so the
  // tail rows stay reachable.
  const handleListScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const options = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
    if (options.length === 0) return;
    // This scroll was set by scrollToIndex (keyboard). The keyboard already
    // picked the authoritative index; recomputing from position would snap the
    // highlight back to the topmost visible item, so stand down.
    if (
      programmaticScrollTopRef.current >= 0 &&
      Math.abs(list.scrollTop - programmaticScrollTopRef.current) < 1
    ) {
      programmaticScrollTopRef.current = -1;
      return;
    }
    programmaticScrollTopRef.current = -1;
    const listTop = list.getBoundingClientRect().top;
    let active = 0;
    for (let i = 0; i < options.length; i++) {
      if (options[i]!.getBoundingClientRect().bottom > listTop + 1) {
        active = i;
        break;
      }
    }
    setSelected(active);
  }, [setSelected]);

  // Scroll the highlighted item into view for keyboard navigation, minimally:
  // nudge the list only when the item would leave the TOP or BOTTOM of the
  // visible window. This makes the highlight travel down the rows in place, and
  // only scroll the list once you reach the edge (then the next item scrolls
  // into view) — no aligning every item to the top, which is what made the
  // cursor look pinned to the top row. Records the exact scrollTop so
  // handleListScroll recognizes this programmatic scroll and stands down.
  const scrollToIndex = useCallback((target: number) => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`#slash-skill-${target}`);
    if (!list || !el) return;
    const listTop = list.getBoundingClientRect().top;
    const elTop = el.getBoundingClientRect().top;
    const elBottom = elTop + el.offsetHeight;
    const listBottom = listTop + list.clientHeight;
    // Bring it down if it's above the top edge; bring it up if it's below the
    // bottom edge. No-op when it's already fully visible (the common case).
    let desired = list.scrollTop;
    if (elTop < listTop) desired += elTop - listTop;
    else if (elBottom > listBottom) desired += elBottom - listBottom;
    if (Math.abs(desired - list.scrollTop) > 1) {
      programmaticScrollTopRef.current = desired;
      list.scrollTop = desired;
    }
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(selectedIndexRef.current + 1, flatItems.length - 1);
      setSelected(next);
      scrollToIndex(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(selectedIndexRef.current - 1, 0);
      setSelected(prev);
      scrollToIndex(prev);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const selected = flatItems[selectedIndexRef.current];
      if (selected) onSelect(selected);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss();
    }
  }, [flatItems, onSelect, onDismiss, scrollToIndex, setSelected]);

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

  const renderSkill = (skill: Skill, index: number) => {
    const isSelected = index === selectedIndex;
    return (
      <button
        id={`slash-skill-${index}`}
        key={skill.id}
        role="option"
        aria-selected={isSelected}
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          onSelect(skill);
        }}
        className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors ${
          isSelected
            ? 'bg-primary/10 dark:bg-primary/20'
            : 'hover:bg-[#F7F8FC] dark:hover:bg-white/5'
        }`}
      >
        <SkillIconTile
          icon={skillService.getSkillIcon(skill.id)}
          className="h-7 w-7 shrink-0 rounded-md"
          iconClassName="h-4 w-4"
        />
        <span className={`min-w-0 flex-1 truncate text-sm font-medium ${
          isSelected ? 'text-primary dark:text-primary' : 'text-foreground'
        }`}>
          {skillService.getLocalizedSkillName(skill.id, skill.name)}
        </span>
      </button>
    );
  };

  const pickerWidth = 240;
  const left = Math.max(8, Math.min(position.left, window.innerWidth - pickerWidth - 8));
  const bottom = window.innerHeight - position.top + 4;

  let flatIndex = -1;

  return createPortal(
    <div
      ref={containerRef}
      role="listbox"
      aria-activedescendant={`slash-skill-${selectedIndex}`}
      className="overflow-hidden rounded-lg border border-[#E8EBF4] bg-white p-1 shadow-lg dark:border-white/10 dark:bg-neutral-900 dark:shadow-black/40"
      style={{ position: 'fixed', left, bottom, width: pickerWidth, zIndex: 10000 }}
    >
      {totalCount === 0 ? (
        <div className="px-3 py-4 text-center text-sm text-secondary">
          {i18nService.t('noSkillsAvailable')}
        </div>
      ) : (
        <div ref={listRef} onScroll={handleListScroll} className="max-h-[240px] overflow-y-auto">
          {mySkills.length > 0 && (
            <>
              <div className="px-2 pt-1 pb-1 text-[10px] font-semibold text-secondary">
                {i18nService.t('skillGroupMine')}
              </div>
              {mySkills.map((skill) => {
                flatIndex += 1;
                return renderSkill(skill, flatIndex);
              })}
            </>
          )}
          {builtInSkills.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-[10px] font-semibold text-secondary">
                {i18nService.t('skillGroupBuiltIn')}
              </div>
              {builtInSkills.map((skill) => {
                flatIndex += 1;
                return renderSkill(skill, flatIndex);
              })}
            </>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
};

export default SlashSkillPicker;
