import { Bot } from 'lucide-react';
import type { JSX } from 'react';

import { AGENT_COLORS, AGENT_GLYPHS, GLYPH_ICON } from '../agentTile';
import { fill, t } from '../types';

interface IconColorPickerProps {
  icon: string;
  iconColor: number;
  onPick: (glyph: string) => void;
  onColor: (color: number) => void;
}

/** Popover rendered under the drawer's icon tile (parent must be
 *  `position: relative`): a 4×2 grid of the 8 offered glyphs plus an
 *  8-swatch color row. Writes the selection back through onPick/onColor. */
export function IconColorPicker({ icon, iconColor, onPick, onColor }: IconColorPickerProps): JSX.Element {
  return (
    <div className="absolute left-0 top-full z-50 mt-2 w-56 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-3 shadow-lg">
      <div className="grid grid-cols-4 gap-1.5">
        {AGENT_GLYPHS.map(g => {
          // All 8 AGENT_GLYPHS have entries in GLYPH_ICON; Bot is a safe
          // fallback for any unknown glyph value.
          const Glyph = GLYPH_ICON[g] ?? Bot;
          return (
            <button
              key={g}
              type="button"
              aria-label={g}
              aria-pressed={icon === g}
              onClick={() => onPick(g)}
              className={`flex h-10 w-10 items-center justify-center rounded-lg border ${
                icon === g
                  ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]'
                  : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              <Glyph className="h-5 w-5" />
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        {AGENT_COLORS.map((c, i) => (
          <button
            key={c}
            type="button"
            aria-label={fill(t('agentmgmt.icon.color'), { n: i + 1 })}
            onClick={() => onColor(i)}
            style={{ background: c }}
            className={`h-6 w-6 rounded-full ${iconColor === i ? 'ring-2 ring-[var(--accent-primary)] ring-offset-1' : ''}`}
          />
        ))}
      </div>
    </div>
  );
}
