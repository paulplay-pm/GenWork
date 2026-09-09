import { Edit, Trash2 } from 'lucide-react';
import type { JSX } from 'react';

import type { ModelView } from '../../api/models';
import { IconButton } from '../../components/IconButton';
import { Switch } from '../../components/Switch';
import { t } from '../../i18n';
import { ModelTypesBadges, contextLabel } from './modelType';

interface Props {
  model: ModelView;
  canManage: boolean;
  busy: boolean;
  onEdit: (model: ModelView) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
}

/**
 * Single model row in the configured-models table. Display-only: name + mono
 * ID, multi-type badges, formatted context window, an enable switch, and
 * edit / delete actions (editing opens the drawer).
 */
export function ModelTableRow({
  model,
  canManage,
  busy,
  onEdit,
  onDelete,
  onToggleEnabled,
}: Props): JSX.Element {
  const enabled = model.enabled && !model.disabled_by_admin;
  return (
    <tr className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]/40">
      <td className="px-4 py-2.5 text-sm text-[var(--text-primary)]">
        <div className="flex flex-col">
          <span className="font-medium">{model.display_name ?? model.model}</span>
          <span className="font-mono text-xs text-[var(--text-tertiary)]">
            {model.model}
          </span>
        </div>
      </td>
      <td className="px-4 py-2.5">
        <ModelTypesBadges types={model.types} />
      </td>
      <td className="px-4 py-2.5 text-sm text-[var(--text-secondary)]">
        {contextLabel(model.context_window)}
      </td>
      <td className="px-4 py-2.5">
        <Switch
          checked={enabled}
          disabled={!canManage || busy}
          onChange={(next) => onToggleEnabled(model.id, next)}
          label={
            enabled
              ? t('providersModels.header.enabled')
              : t('providersModels.header.disabled')
          }
        />
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center justify-end gap-1">
          {canManage && (
            <>
              <IconButton
                label={t('providersModels.model.actionEdit')}
                onClick={() => onEdit(model)}
                disabled={busy}
              >
                <Edit className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                label={t('common.delete')}
                variant="danger"
                onClick={() => onDelete(model.id)}
                disabled={busy}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
