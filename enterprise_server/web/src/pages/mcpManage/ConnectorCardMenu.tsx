import type { JSX } from 'react';
import { useEffect, useRef } from 'react';

import type { Connector } from '../../api/connectors';
import { t } from '../../i18n';

interface Props {
  open: boolean;
  x: number;
  y: number;
  connector: Connector;
  onClose: () => void;
  onEdit: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}

const MENU_W = 176;
const ITEM_H = 34;

/**
 * The `⋯` card menu (mirrors the prototype's `#ctxMenu`): a small fixed
 * popover at the click position with exactly three items —
 * 编辑配置 / 停用·启用 / 删除连接器 (there is deliberately no audit item).
 * Closes on outside click and Escape.
 */
export function ConnectorCardMenu(p: Props): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!p.open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) p.onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') p.onClose();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [p.open, p.onClose]);

  if (!p.open) return null;

  const c = p.connector;
  const left = Math.max(8, Math.min(p.x, window.innerWidth - MENU_W - 8));
  const top = Math.max(8, Math.min(p.y, window.innerHeight - (ITEM_H * 3 + 24)));
  const itemCls = 'flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]';

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[150] rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-secondary)] p-1.5"
      style={{ left, top, width: MENU_W, boxShadow: 'var(--shadow-lg)' }}
    >
      <button
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => { p.onClose(); p.onEdit(c.id); }}
      >
        ✎ {t('page.providersModels.editConfig')}
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => { p.onClose(); p.onToggle(c.id, !c.enabled); }}
      >
        {c.enabled ? '⏸' : '▶'} {c.enabled ? t('mcp.disabled') : t('mcp.enabled')}
      </button>
      <button
        type="button"
        role="menuitem"
        className={`${itemCls} text-[var(--danger-primary)] hover:bg-[var(--danger-primary)]/10`}
        onClick={() => { p.onClose(); p.onDelete(c.id); }}
      >
        🗑 {t('mcp.delete.title')}
      </button>
    </div>
  );
}
