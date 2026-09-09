import type { JSX } from 'react';

import { Switch } from '../../../components/Switch';
import { IM_CHANNELS } from '../imChannels';

interface ImChannelPickerProps {
  selected: string[];
  onToggle: (id: string) => void;
}

/**
 * The "IM 渠道" tab: one row per IM channel (brand logo + name + a 是否启动
 * switch). Selecting a channel adds its platform id to the agent's
 * `im_channels` set; all-off is valid. Mirrors the SkillPicker row layout.
 */
export function ImChannelPicker({ selected, onToggle }: ImChannelPickerProps): JSX.Element {
  return (
    <ul className="flex flex-col gap-2">
      {IM_CHANNELS.map(c => (
        <li
          key={c.id}
          className="flex items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2.5"
        >
          <img src={c.logo} alt="" aria-hidden className="h-8 w-8 shrink-0 rounded-lg object-cover" />
          <span className="flex-1 text-sm text-[var(--text-primary)]">{c.name}</span>
          <Switch
            checked={selected.includes(c.id)}
            onChange={() => onToggle(c.id)}
            label={c.name}
          />
        </li>
      ))}
    </ul>
  );
}
