import type { JSX, MouseEvent } from 'react';

import type { AuthMode6, Connector } from '../../api/connectors';
import { Switch } from '../../components/Switch';
import { t } from '../../i18n';
import { fill } from './types';

interface Props {
  c: Connector;
  onOpen: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onMenu: (e: MouseEvent, id: string) => void;
}

/** Map the wire auth-mode value (kebab-case) to its i18n label key (camelCase). */
const AUTH_MODE_LABEL: Record<AuthMode6, string> = {
  none: 'mcp.auth.none',
  'shared-key': 'mcp.auth.sharedKey',
  'user-key': 'mcp.auth.userKey',
  'user-oauth': 'mcp.auth.userOAuth',
  'client-creds': 'mcp.auth.clientCreds',
  sso: 'mcp.auth.sso',
};

const TAG = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-[18px]';

/** Deterministic icon-badge palette (prototype `conn-icon` color pairs). */
const ICON_PALETTE = [
  'bg-sky-50 text-sky-600',
  'bg-emerald-50 text-emerald-600',
  'bg-amber-50 text-amber-600',
  'bg-rose-50 text-rose-600',
  'bg-violet-50 text-violet-600',
  'bg-cyan-50 text-cyan-600',
  'bg-indigo-50 text-indigo-600',
  'bg-slate-100 text-slate-600',
];

/** Display name: Chinese preferred, then English, then the server key. */
export function displayName(c: Connector): string {
  return c.nameZh ?? c.nameEn ?? c.serverKey;
}

function initials(seed: string): string {
  const s = seed.trim();
  return (s.length >= 2 ? s.slice(0, 2) : s).toUpperCase();
}

function iconPaletteCls(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return ICON_PALETTE[h % ICON_PALETTE.length];
}

/** Pretty-print the visibility scope from the structured `scope` field. */
function scopeText(c: Connector): string {
  if (c.scope.allCompany) return t('mcp.scope.allCompany');
  const n = c.scope.deptIds.length;
  const m = c.scope.userIds.length;
  if (n === 0 && m === 0) return t('mcp.scope.unauthorized');
  if (n === 0) return fill(t('mcp.scope.users'), { m });
  if (m === 0) return fill(t('mcp.scope.depts'), { n });
  return fill(t('mcp.scope.deptsAndUsers'), { n, m });
}

/**
 * One connector card of the org-connectors grid. The card body opens the
 * detail view; the enable Switch and the `⋯` menu sit top-right and stop
 * propagation so they never trigger the card click.
 */
export function ConnectorCard({ c, onOpen, onToggle, onMenu }: Props): JSX.Element {
  const name = displayName(c);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(c.id)}
      onKeyDown={(e) => {
        // Only the card itself opens on Enter/Space. Keydown from the inner
        // focusable Switch / ⋯ button bubbles here; without this target check
        // Space on the Switch would toggle AND open, Enter on ⋯ would open the
        // menu AND open the card. The mouse path already stops propagation.
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen(c.id);
        }
      }}
      className={`relative flex cursor-pointer flex-col gap-2.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 text-left transition hover:border-[var(--accent-primary)] hover:shadow-md ${c.enabled ? '' : 'opacity-60'}`}
    >
      {/* Top-right controls: enable switch + ⋯ menu (mirrors the prototype card). */}
      <div className="absolute right-3 top-3 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <Switch
          checked={c.enabled}
          label={c.enabled ? t('mcp.enabled') : t('mcp.disabled')}
          onChange={(v) => onToggle(c.id, v)}
        />
        <button
          type="button"
          aria-label={name}
          className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-[16px] font-bold text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          onClick={(e) => { e.stopPropagation(); onMenu(e, c.id); }}
        >
          ⋯
        </button>
      </div>

      {/* Header: colored initials badge, name + status dot + 启用/停用 tag, mono key. */}
      <div className="flex items-start gap-2.5 pr-16">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] text-[15px] font-semibold ${iconPaletteCls(name)}`}
          aria-hidden
        >
          {initials(name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="truncate text-[14px] text-[var(--text-primary)]">{name}</strong>
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: c.enabled ? 'var(--success-primary)' : '#D1D5DB' }}
              title={c.enabled ? t('mcp.enabled') : t('mcp.disabled')}
            />
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium leading-[18px] ${c.enabled
              ? 'bg-[var(--success-primary)]/15 text-[var(--success-primary)]'
              : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}>
              {c.enabled ? t('mcp.enabled') : t('mcp.disabled')}
            </span>
          </div>
          <code className="mt-0.5 block truncate font-mono text-[11.5px] text-[var(--text-tertiary)]">{c.serverKey}</code>
        </div>
      </div>

      <p className="min-h-[40px] flex-1 line-clamp-2 text-[12.5px] leading-snug text-[var(--text-secondary)]">
        {c.description ?? ''}
      </p>

      {/* Tags: type, auth mode, tool count, draft, auth-pending, scope. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${TAG} ${c.connectorType === 'mcp'
          ? 'bg-cyan-500/10 text-cyan-700'
          : 'bg-violet-500/10 text-violet-700'}`}>
          {c.connectorType === 'mcp' ? t('mcp.typeFilter.mcp') : t('mcp.typeFilter.app')}
        </span>
        <span className={`${TAG} ${c.authMode === 'none'
          ? 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
          : 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]'}`}>
          {t(AUTH_MODE_LABEL[c.authMode])}
        </span>
        <span className={`${TAG} bg-[var(--bg-tertiary)] text-[var(--text-secondary)]`}>
          {fill(t('mcp.tools.count'), { n: c.toolCount })}
        </span>
        {c.hasDraft && (
          <span className={`${TAG} bg-[var(--warning-primary)]/10 text-[var(--warning-primary)]`}>
            {t('mcp.draft.tag')}
          </span>
        )}
        {c.authStatus === 'pending' && (
          <span className={`${TAG} bg-[var(--warning-primary)]/10 text-[var(--warning-primary)]`}>
            {t('mcp.auth.pending')}
          </span>
        )}
        <span className={`${TAG} bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden>
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
            <circle cx="9" cy="7" r="4" />
          </svg>
          {scopeText(c)}
        </span>
      </div>

      {/* Meta row: version only — the org view carries no usage metrics. */}
      <div className="border-t border-[var(--border-subtle)] pt-2.5 text-[12px] text-[var(--text-tertiary)]">
        v{c.version}
      </div>
    </div>
  );
}
