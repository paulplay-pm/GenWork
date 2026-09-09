import type { JSX } from 'react';
import { useEffect } from 'react';

import type { Connector } from '../../api/connectors';
import { t } from '../../i18n';
import { fill } from './types';

interface Props {
  open: boolean;
  connector: Connector | null;
  busy: boolean;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

/** Delete-impact modal. V1 best-effort impact list: the current scope (who
 * loses access), dependent skills/agents, 90-day audit retention, and
 * immediate revocation of OAuth grants + secrets. */
export function DeleteConnectorModal(p: Props): JSX.Element | null {
  useEffect(() => {
    if (!p.open || p.busy) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') p.onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p.open, p.busy, p.onCancel]);

  if (!p.open || !p.connector) return null;

  const scope = p.connector.scope;
  const scopeText = scope.allCompany
    ? t('mcp.scope.allCompany')
    : scope.deptIds.length + scope.userIds.length === 0
      ? t('mcpDrawer.delete.noScope')
      : fill(t('mcpDrawer.delete.deptCount'), { n: scope.deptIds.length }) +
        (scope.userIds.length > 0
          ? fill(t('mcpDrawer.delete.memberSuffix'), { n: scope.userIds.length })
          : '');
  const name = p.connector.nameZh || p.connector.nameEn || p.connector.serverKey;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40"
      onClick={p.busy ? undefined : p.onCancel}
    >
      <div
        className="w-full max-w-sm rounded-[8px] bg-[var(--bg-secondary)] p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-[15px] font-semibold text-[var(--text-primary)]">
          {fill(t('mcpDrawer.delete.title'), { name })}
        </h2>
        <p className="text-[13px] text-[var(--text-secondary)]">{t('mcpDrawer.delete.intro')}</p>
        <ul className="my-3 list-disc space-y-1.5 pl-5 text-[13px] text-[var(--text-secondary)]">
          <li>{fill(t('mcpDrawer.delete.impactScope'), { scope: scopeText })}</li>
          <li>{t('mcpDrawer.delete.impactDeps')}</li>
          <li>{t('mcpDrawer.delete.impactLogs')}</li>
          <li>{t('mcpDrawer.delete.impactSecret')}</li>
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={p.onCancel}
            disabled={p.busy}
            className="rounded-[6px] border border-[var(--border-default)] px-3.5 py-1.5 text-[13px] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            {t('mcp.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void p.onConfirm()}
            disabled={p.busy}
            className="rounded-[6px] bg-[var(--danger-primary)] px-3.5 py-1.5 text-[13px] text-white hover:opacity-90 disabled:opacity-50"
          >
            {p.busy ? t('common.loading') : t('mcpDrawer.delete.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
