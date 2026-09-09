import { Trash2 } from 'lucide-react';
import type { JSX } from 'react';

import type { AgentMarketplaceItem } from '../../api/agentMarketplace';
import type { ProviderKeyView } from '../../api/providers';
import { Switch } from '../../components/Switch';
import { autoIcon } from '../../lib/autoIcon';
import { GLYPH_ICON, isUrlIcon, tileClass } from './agentTile';
import { modelLabel } from './modelLabel';
import { fill, t } from './types';

interface AgentCardProps {
  agent: AgentMarketplaceItem;
  /** Org providers, used to render the model chip as `vendor · modelId`. */
  providers?: ProviderKeyView[];
  onToggle: (agent: AgentMarketplaceItem, enabled: boolean) => void;
  onOpen: (agent: AgentMarketplaceItem) => void;
  onDelete: (agent: AgentMarketplaceItem) => void;
  /** Light-confirm popover for disabling (anchored to this card's switch). */
  showDisable: boolean;
  onConfirmDisable: () => void;
  onCancelDisable: () => void;
  /** Transient ring after a create flash. */
  flash: boolean;
  /** Animating out after a confirmed delete. */
  removing: boolean;
}

function Chip({ children, accent }: { children: string; accent?: boolean }): JSX.Element {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${accent
        ? 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]'
        : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}
    >
      {children}
    </span>
  );
}

export function AgentCard({ agent, providers, onToggle, onOpen, onDelete, showDisable, onConfirmDisable, onCancelDisable, flash, removing }: AgentCardProps): JSX.Element {
  const disabled = !agent.enabled;
  const Glyph = GLYPH_ICON[agent.icon];
  const model = modelLabel(agent.model, providers);
  return (
    <div
      data-testid="agent-card"
      onClick={() => onOpen(agent)}
      className={`group flex cursor-pointer flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5 transition-colors hover:border-[var(--accent-primary)]/40 ${disabled ? 'opacity-[0.62]' : ''} ${flash ? 'ring-2 ring-[var(--accent-primary)]' : ''} ${removing ? 'translate-x-2 opacity-0 transition-all duration-150' : ''}`}
    >
      {/* header: icon tile + name + enable switch */}
      <div className="flex items-start gap-3">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl text-[20px] ${tileClass(agent.iconColor)}`}>
          {isUrlIcon(agent.icon)
            ? <img src={agent.icon} alt="" className="h-11 w-11 object-cover" />
            : Glyph
              ? <Glyph className="h-5 w-5" />
              : <span>{autoIcon(agent.name)}</span>}
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="truncate text-[15px] font-semibold text-[var(--text-primary)]">{agent.name}</div>
        </div>
        {/* stop propagation so toggling does not open the drawer */}
        <span onClick={(e) => e.stopPropagation()} className="relative">
          <Switch
            checked={agent.enabled}
            onChange={(checked) => onToggle(agent, checked)}
            label={agent.enabled ? t('agentmgmt.toggleOn') : t('agentmgmt.toggleOff')}
          />
          {showDisable ? (
            /* light-confirm popover for disabling; every click here must not
               bubble to the card root (which would open the drawer) */
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-full z-20 mt-1.5 w-56 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 shadow-lg"
            >
              <div className="text-xs leading-relaxed text-[var(--text-secondary)]">{t('agentmgmt.disable.popover')}</div>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onCancelDisable(); }}
                  className="h-7 rounded-md border border-[var(--border-default)] px-2 text-xs text-[var(--text-primary)]"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onConfirmDisable(); }}
                  className="h-7 rounded-md bg-[var(--danger-primary)] px-2 text-xs text-white"
                >
                  {t('agentmgmt.disable.confirm')}
                </button>
              </div>
            </div>
          ) : null}
        </span>
      </div>

      {/* description (2 lines). min-height reserves a full 2-line box even when
         empty so the chips row below aligns across cards with/without text. */}
      <div className="mt-3 min-h-[2.75em] line-clamp-2 text-[13px] leading-snug text-[var(--text-secondary)]">{agent.description}</div>

      {/* count chips. min-height reserves a single chip row even when few, so
         the row height is consistent across cards (one line, 20px). */}
      <div className="mt-3 flex min-h-5 flex-wrap items-center gap-1.5">
        {model ? <Chip>{model}</Chip> : null}
        <Chip>{fill(t('agentmgmt.rolesCount'), { n: agent.allowedRoles.length })}</Chip>
        <Chip>{fill(t('agentmgmt.skillsCount'), { n: agent.skillIds.length })}</Chip>
        {agent.subagentAllowAgentIds.length > 0
          ? <Chip>{fill(t('agentmgmt.subagentsCount'), { n: agent.subagentAllowAgentIds.length })}</Chip>
          : null}
        {disabled ? <Chip accent>{t('agentmgmt.disabledChip')}</Chip> : null}
      </div>

      {/* footer: delete only (right-aligned). mt-auto pins the divider to the
         card's bottom edge so it lines up across cards in a row, even when
         one has an empty description and the other a 2-line one. */}
      <div className="mt-auto flex items-center border-t border-[var(--border-subtle)] pt-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(agent);
          }}
          className="ml-auto inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--danger-primary)]"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('common.delete')}
        </button>
      </div>
    </div>
  );
}
