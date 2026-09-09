import type { JSX } from 'react';
import type { AuthMode6, Transport2 } from '../../api/connectors';
import { t } from '../../i18n';
import { ConnectorAuthFields } from './ConnectorAuthFields';
import type { ConnectorFormState } from './ConnectorDrawer';

/** All six auth modes, in display order. */
export const AUTH_MODES: AuthMode6[] = [
  'none',
  'shared-key',
  'user-key',
  'user-oauth',
  'client-creds',
  'sso',
];

/** i18n key for each mode's short label (reused by the select and the
 * destructive auth-mode-switch confirm). */
export const AUTH_MODE_LABEL: Record<AuthMode6, string> = {
  'none': 'mcp.auth.none',
  'shared-key': 'mcp.auth.sharedKey',
  'user-key': 'mcp.auth.userKey',
  'user-oauth': 'mcp.auth.userOAuth',
  'client-creds': 'mcp.auth.clientCreds',
  'sso': 'mcp.auth.sso',
};

const AUTH_HINT_KEY: Record<AuthMode6, string> = {
  'none': 'mcp.authHint.none',
  'shared-key': 'mcp.authHint.sharedKey',
  'user-key': 'mcp.authHint.userKey',
  'user-oauth': 'mcp.authHint.userOAuth',
  'client-creds': 'mcp.authHint.clientCreds',
  'sso': 'mcp.authHint.sso',
};

/** Modes SSE transport cannot carry (the backend 400s on these combos). */
export const SSE_INCOMPATIBLE_AUTH_MODES: AuthMode6[] = ['user-oauth', 'client-creds', 'sso'];

interface Props {
  mode: 'create' | 'edit';
  state: ConnectorFormState;
  onChange: (patch: Partial<ConnectorFormState>) => void;
  /** Pre-formatted "configured by / at" metadata (null in create mode). */
  secretMeta: { by: string; time: string } | null;
  /** Which stored secrets exist (drives the masked placeholders). */
  hasSecret: { apiKey: boolean; clientSecret: boolean };
}

/** 连接配置 section: transport + auth mode (with SSE coupling) + the
 * mode-specific auth fields + timeout/retry. */
export function ConnectorConnConfig(p: Props): JSX.Element {
  const inputCls =
    'w-full rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent-primary)]';
  const labelCls = 'flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]';
  const req = <span className="text-[var(--danger-primary)]">*</span>;

  /** SSE coupling: picking `sse` resets an incompatible auth mode to `none`. */
  const onTransportChange = (v: Transport2): void => {
    if (v === 'sse' && SSE_INCOMPATIBLE_AUTH_MODES.includes(p.state.authMode)) {
      p.onChange({ transport: v, authMode: 'none' });
    } else {
      p.onChange({ transport: v });
    }
  };

  return (
    <section className="mt-5 border-t border-dashed border-[var(--border-default)] pt-4">
      <h4 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {t('mcpDrawer.connConfig')}
      </h4>
      <div className="grid grid-cols-2 gap-3.5">
        <label className={`col-span-2 ${labelCls}`}>
          {t('mcp.transport')} {req}
          <select
            className={inputCls}
            aria-label={t('mcp.transport')}
            value={p.state.transport}
            onChange={(e) => onTransportChange(e.target.value as Transport2)}
          >
            <option value="http">{t('mcpDrawer.transport.http')}</option>
            <option value="sse">{t('mcpDrawer.transport.sse')}</option>
          </select>
          <span className="text-xs text-[var(--text-tertiary)]">
            {p.state.transport === 'sse'
              ? t('mcpDrawer.transportHint.sse')
              : t('mcpDrawer.transportHint.http')}
          </span>
        </label>

        <label className={`col-span-2 ${labelCls}`}>
          {t('mcp.auth')} {req}
          <select
            className={inputCls}
            aria-label={t('mcp.auth')}
            value={p.state.authMode}
            onChange={(e) => p.onChange({ authMode: e.target.value as AuthMode6 })}
          >
            {AUTH_MODES.map((m) => (
              <option
                key={m}
                value={m}
                disabled={p.state.transport === 'sse' && SSE_INCOMPATIBLE_AUTH_MODES.includes(m)}
              >
                {t(AUTH_MODE_LABEL[m])}
              </option>
            ))}
          </select>
          <span className="text-xs text-[var(--text-tertiary)]">{t(AUTH_HINT_KEY[p.state.authMode])}</span>
        </label>

        <div className="col-span-2">
          <ConnectorAuthFields
            mode={p.mode}
            authMode={p.state.authMode}
            state={p.state}
            onChange={p.onChange}
            hasSecret={p.hasSecret}
            secretMeta={p.secretMeta}
          />
        </div>

        <label className={labelCls}>
          {t('mcp.timeout')}
          <input
            className={inputCls}
            aria-label={t('mcp.timeout')}
            type="number"
            min={5}
            max={300}
            value={p.state.timeoutSeconds}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              p.onChange({ timeoutSeconds: Number.isFinite(n) ? n : 0 });
            }}
          />
          <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.timeout.hint')}</span>
        </label>
        <label className={labelCls}>
          {t('mcpDrawer.retry')}
          <input
            className={inputCls}
            aria-label={t('mcpDrawer.retry')}
            type="number"
            min={0}
            max={5}
            value={p.state.retryCount}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              p.onChange({ retryCount: Number.isFinite(n) ? n : 0 });
            }}
          />
          <span className="text-xs text-[var(--text-tertiary)]">{t('mcpDrawer.retry.hint')}</span>
        </label>
      </div>
    </section>
  );
}
