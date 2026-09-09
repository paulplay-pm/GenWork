import type { JSX } from 'react';

import type { AgentMarketplaceItem } from '../../api/agentMarketplace';
import type { ProviderKeyView } from '../../api/providers';
import { AgentCard } from './AgentCard';
import { t } from './types';

interface Props {
  agents: AgentMarketplaceItem[];
  /** Org providers, passed to each card for the `vendor · modelId` chip. */
  providers?: ProviderKeyView[];
  onToggle: (agent: AgentMarketplaceItem, enabled: boolean) => void;
  onOpen: (agent: AgentMarketplaceItem) => void;
  onDelete: (agent: AgentMarketplaceItem) => void;
  /** agentId whose disable-confirm popover is open (null = none). */
  disableOn: string | null;
  onConfirmDisable: () => void;
  onCancelDisable: () => void;
  /** agentId to flash after a create (null = none). */
  flashId?: string | null;
  /** agentId animating out after a delete (null = none). */
  removingId?: string | null;
}

export function AgentCardGrid({
  agents,
  providers,
  onToggle,
  onOpen,
  onDelete,
  disableOn,
  onConfirmDisable,
  onCancelDisable,
  flashId = null,
  removingId = null,
}: Props): JSX.Element {
  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border-default)] p-10 text-center text-sm text-[var(--text-secondary)]">
        {t('agentmgmt.empty')}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
      {agents.map(a => (
        <AgentCard
          key={a.agentId}
          agent={a}
          providers={providers}
          onToggle={onToggle}
          onOpen={onOpen}
          onDelete={onDelete}
          showDisable={disableOn === a.agentId}
          onConfirmDisable={onConfirmDisable}
          onCancelDisable={onCancelDisable}
          flash={flashId === a.agentId}
          removing={removingId === a.agentId}
        />
      ))}
    </div>
  );
}
