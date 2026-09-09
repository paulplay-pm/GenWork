import type { JSX } from 'react';

import type { ToolEntry } from '../../api/connectors';
import { Switch } from '../../components/Switch';
import { t } from '../../i18n';
import { fill } from './types';

interface Props {
  mode: 'create' | 'edit';
  tools: ToolEntry[];
  toolToggles: Record<string, boolean>;
  onToggle: (name: string, enabled: boolean) => void;
}

/** 工具权限 section. Edit mode renders one row per discovered tool (mono name
 * + desc + a Switch bound to the form's `toolToggles`); `removed` tools (no
 * longer listed by the server) are grayed with a disabled switch. Create mode
 * — or an empty tool list — keeps the explanation block. */
export function ConnectorToolPermissions(p: Props): JSX.Element {
  const showRows = p.mode === 'edit' && p.tools.length > 0;
  return (
    <section className="mt-5 border-t border-dashed border-[var(--border-default)] pt-4">
      <h4 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {p.mode === 'create' ? t('mcpDrawer.tools') : fill(t('mcpDrawer.tools.editTitle'), { n: p.tools.length })}
      </h4>
      {showRows ? (
        <div className="flex flex-col gap-1.5">
          {p.tools.map((tool) => (
            <div
              key={tool.name}
              className={`flex items-center gap-3 rounded-[7px] bg-[var(--bg-tertiary)] px-3 py-2 ${
                tool.removed ? 'opacity-55' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[12.5px] text-[var(--text-primary)]">{tool.name}</span>
                  {tool.removed && (
                    <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                      {t('mcpDrawer.tools.removedHint')}
                    </span>
                  )}
                </div>
                {tool.desc && (
                  <div className="truncate text-[12px] text-[var(--text-tertiary)]">{tool.desc}</div>
                )}
              </div>
              <Switch
                checked={p.toolToggles[tool.name] ?? tool.enabled}
                onChange={(v) => p.onToggle(tool.name, v)}
                disabled={!!tool.removed}
                label={tool.name}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-[7px] bg-[var(--bg-tertiary)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {t('mcpDrawer.tools.createNote')}
        </div>
      )}
    </section>
  );
}
