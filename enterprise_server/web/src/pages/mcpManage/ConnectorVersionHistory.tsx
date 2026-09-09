import type { JSX } from 'react';
import { useState } from 'react';
import dayjs from 'dayjs';

import type { VersionRow } from '../../api/connectors';
import { connectorApi } from '../../api/connectors';
import type { UserRow } from '../../api/users';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/toastStore';
import { t } from '../../i18n';
import { fill } from './types';

interface Props {
  connectorId: string;
  versions: VersionRow[];
  members: UserRow[];
  /** Called after a successful rollback so the caller can refetch list + versions. */
  onInvalidated: () => void;
}

/** 版本历史: one row per recorded version (version, note, author, time,
 * `current` badge) with a rollback action (disabled on the current row).
 * Rollback goes through a destructive confirm. */
export function ConnectorVersionHistory(p: Props): JSX.Element {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmVersion, setConfirmVersion] = useState<string | null>(null);

  const authorName = (id: string | null): string => {
    if (!id) return '—';
    const m = p.members.find((x) => x.id === id);
    return m?.display_name || m?.username || id;
  };

  const doRollback = async (version: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await connectorApi.rollback(p.connectorId, version);
      toast.success(fill(t('mcpDrawer.toast.rolledBack'), { version }));
      p.onInvalidated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (p.versions.length === 0) {
    return <p className="text-[12.5px] text-[var(--text-tertiary)]">{t('mcpDrawer.versions.empty')}</p>;
  }

  return (
    <>
      <div className="flex flex-col gap-1.5">
        {p.versions.map((v) => (
          <div key={v.id} className="flex items-center gap-3 rounded-[7px] bg-[var(--bg-tertiary)] px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12.5px] font-semibold text-[var(--text-primary)]">
                  {v.version}
                </span>
                {v.current && (
                  <span className="rounded-full bg-[var(--accent-primary)]/15 px-1.5 py-px text-[11px] text-[var(--accent-primary)]">
                    {t('mcp.version.current')}
                  </span>
                )}
              </div>
              <div className="truncate text-[12px] text-[var(--text-tertiary)]">
                {v.note ? `${v.note} · ` : ''}
                {authorName(v.createdBy)} · {dayjs(v.createdAt).format('YYYY-MM-DD HH:mm')}
              </div>
            </div>
            <button
              type="button"
              disabled={v.current || busy}
              onClick={() => setConfirmVersion(v.version)}
              className="shrink-0 rounded-[6px] border border-[var(--border-default)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
            >
              {t('mcp.version.rollback')}
            </button>
          </div>
        ))}
      </div>
      {/* z-[110] wrapper so the confirm stacks above the drawer's z-[101]
          aside (ConfirmDialog's own overlay is z-50). */}
      <div className="relative z-[110]">
        <ConfirmDialog
          open={confirmVersion !== null}
          title={t('mcpDrawer.versions.rollbackTitle')}
          message={
            confirmVersion ? fill(t('mcpDrawer.versions.rollbackConfirm'), { version: confirmVersion }) : ''
          }
          confirmLabel={t('mcpDrawer.versions.rollbackConfirmBtn')}
          cancelLabel={t('mcp.cancel')}
          destructive
          onConfirm={() => {
            const v = confirmVersion;
            setConfirmVersion(null);
            if (v) void doRollback(v);
          }}
          onCancel={() => setConfirmVersion(null)}
        />
      </div>
    </>
  );
}
