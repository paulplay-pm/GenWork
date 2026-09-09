import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useState } from 'react';

import { ssoApi } from '../../api/sso';
import { useAuth } from '../../auth/useAuth';
import { Badge } from '../../components/Badge';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { useToast } from '../../components/toastStore';
import { t } from '../../i18n';
import { SSOConnectionDrawer } from './SSOConnectionDrawer';
import type { SsoConnection } from './types';

type DrawerState = { mode: 'create' } | { mode: 'edit'; connection: SsoConnection } | null;

/**
 * SSO / identity-provider connections: the list of org SSO integrations with
 * a create/edit drawer and a soft-disable action. Rows are redacted (no
 * plaintext secrets); the org scope comes from the token's `claims.orgId`.
 */
export function SSOConnectionsPage(): JSX.Element {
  const { claims } = useAuth();
  const orgId = claims?.orgId ?? '';
  const qc = useQueryClient();
  const toast = useToast();

  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [pendingDisable, setPendingDisable] = useState<SsoConnection | null>(null);
  const [disabling, setDisabling] = useState(false);

  const list = useQuery({
    queryKey: ['sso', 'list', orgId],
    queryFn: () => ssoApi.list(),
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['sso', 'list'] });
  };

  const doDisable = async (): Promise<void> => {
    if (!pendingDisable || disabling) return;
    setDisabling(true);
    try {
      await ssoApi.disable(pendingDisable.id);
      invalidate();
      setPendingDisable(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDisabling(false);
    }
  };

  const rows = list.data ?? [];

  return (
    <div className="p-8">
      <PageHeader
        title={t('sso.title')}
        actions={
          <button
            onClick={() => setDrawer({ mode: 'create' })}
            className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white rounded-[var(--radius-md)]"
          >
            {t('sso.create')}
          </button>
        }
      />

      {list.isLoading ? (
        <div className="text-sm text-[var(--text-secondary)]">{t('common.loading')}</div>
      ) : list.isError ? (
        <div className="rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-10 text-center text-sm text-[var(--text-secondary)]">
          {t('common.error')}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-10 text-center text-sm text-[var(--text-secondary)]">
          {t('sso.list.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)] bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] text-left text-[12px] uppercase tracking-wide text-[var(--text-tertiary)]">
                <th className="px-4 py-2.5 font-medium">{t('sso.name.label')}</th>
                <th className="px-4 py-2.5 font-medium">{t('sso.logo.label')}</th>
                <th className="px-4 py-2.5 font-medium">{t('sso.providerType.label')}</th>
                <th className="px-4 py-2.5 font-medium">{t('sso.protocol.label')}</th>
                <th className="px-4 py-2.5 font-medium">{t('sso.sortOrder.label')}</th>
                <th className="px-4 py-2.5 font-medium">{t('sso.enabled.label')}</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-b border-[var(--border-subtle)] last:border-b-0">
                  <td className="px-4 py-2.5 font-medium text-[var(--text-primary)]">{c.name}</td>
                  <td className="px-4 py-2.5">
                    {c.logo_url ? (
                      <img
                        src={c.logo_url}
                        alt=""
                        className="h-6 w-6 rounded object-contain border border-[var(--border-subtle)] bg-white"
                      />
                    ) : (
                      <span className="text-xs text-[var(--text-tertiary)]">built-in</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                    <code className="text-xs">{c.provider_type}</code>
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-secondary)]">{c.protocol}</td>
                  <td className="px-4 py-2.5 text-[var(--text-secondary)]">{c.sort_order}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={c.enabled ? 'success' : 'neutral'}>
                      {t(c.enabled ? 'mcp.enabled' : 'mcp.disabled')}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setDrawer({ mode: 'edit', connection: c })}
                        className="px-3 py-1.5 text-xs rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-hover)]"
                      >
                        {t('sso.edit')}
                      </button>
                      {c.enabled && (
                        <button
                          onClick={() => setPendingDisable(c)}
                          className="px-3 py-1.5 text-xs rounded-md border border-[var(--danger-primary)]/30 text-[var(--danger-primary)] hover:bg-[var(--danger-light)]"
                        >
                          {t('common.delete')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawer && (
        <SSOConnectionDrawer
          mode={drawer.mode}
          orgId={orgId}
          connection={drawer.mode === 'edit' ? drawer.connection : undefined}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            invalidate();
            setDrawer(null);
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDisable !== null}
        title={t('sso.title')}
        message={t('sso.delete.confirm')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={() => {
          void doDisable();
        }}
        onCancel={() => setPendingDisable(null)}
      />
    </div>
  );
}
