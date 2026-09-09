import { Plus, RefreshCw } from 'lucide-react';
import type { JSX } from 'react';

import type { ModelView } from '../../api/models';
import { EmptyState } from '../../components/EmptyState';
import { t } from '../../i18n';
import { ModelTableRow } from './ModelTableRow';

interface Props {
  models: ModelView[];
  canManage: boolean;
  busy: boolean;
  onRefresh: () => void;
  /** Opens the model drawer in add mode. */
  onAdd: () => void;
  /** Opens the model drawer in edit mode for the given model. */
  onEdit: (model: ModelView) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
}

/**
 * Model table for the selected provider. Adding and editing both go through
 * the single `ModelDrawer` (the page wires `onAdd`/`onEdit` to it); the
 * row is display-only.
 */
export function ModelList({
  models,
  canManage,
  busy,
  onRefresh,
  onAdd,
  onEdit,
  onDelete,
  onToggleEnabled,
}: Props): JSX.Element {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          {t('providersModels.model.list')} ({models.length})
        </h3>
        {canManage && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('providersModels.model.refresh')}
            </button>
            <button
              type="button"
              onClick={onAdd}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--accent-primary)] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-primary-hover)] disabled:opacity-50 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('providersModels.model.add')}
            </button>
          </div>
        )}
      </div>

      {models.length === 0 ? (
        <div className="p-6">
          <EmptyState
            title={t('providersModels.empty.title')}
            description={t('providersModels.empty.description')}
          />
        </div>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-xs uppercase text-[var(--text-tertiary)]">
              <th className="px-4 py-2 font-medium">{t('providersModels.model.colName')}</th>
              <th className="px-4 py-2 font-medium">{t('providersModels.model.colType')}</th>
              <th className="px-4 py-2 font-medium">{t('providersModels.model.colCtx')}</th>
              <th className="px-4 py-2 font-medium">{t('providersModels.header.enabled')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('providersModels.model.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <ModelTableRow
                key={m.id}
                model={m}
                canManage={canManage}
                busy={busy}
                onEdit={onEdit}
                onDelete={onDelete}
                onToggleEnabled={onToggleEnabled}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
