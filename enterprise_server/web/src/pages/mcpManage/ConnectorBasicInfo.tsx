import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import { connectorApi } from '../../api/connectors';
import { t } from '../../i18n';
import type { ConnectorFormState } from './ConnectorDrawer';
import { fill } from './types';

/** Internal/reserved-address detection for the client-side URL validation
 * (mirrors the backend's outbound policy). */
export const INTERNAL_URL_RE =
  /localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.|\.internal/;

/** Auth modes whose credentials would ride the wire in the clear without HTTPS. */
const PLAINTEXT_RISK_MODES = ['user-oauth', 'shared-key', 'client-creds'];

interface Props {
  mode: 'create' | 'edit';
  connectorId?: string;
  state: ConnectorFormState;
  onChange: (patch: Partial<ConnectorFormState>) => void;
  categories: { id: string; name: string }[];
  /** Called after a completed server probe (edit mode) so the caller can
   * refetch the connector row — the test persists `last_test_*` and, on
   * success, syncs the tool manifest. Without this the drawer's tool list
   * and publish working-copy would stay on the pre-test (stale) manifest. */
  onTested?: () => void;
}

interface TestResult {
  ok: boolean;
  text: string;
}

type UrlHint = { kind: 'info' | 'warn' | 'ok'; text: string };

/** 基本信息 section: Server Key, URL + 测试连接, names, version, category, description. */
export function ConnectorBasicInfo(p: Props): JSX.Element {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const url = p.state.url.trim();

  // Live URL validation: internal/reserved → warn, non-HTTPS with auth →
  // plaintext-credentials warn, else OK. Re-runs when the URL or auth mode
  // changes.
  const hint: UrlHint = useMemo(() => {
    if (!url) return { kind: 'info', text: t('mcpDrawer.url.hint') };
    if (INTERNAL_URL_RE.test(url)) return { kind: 'warn', text: t('mcpDrawer.url.warnInternal') };
    if (!url.startsWith('https://') && PLAINTEXT_RISK_MODES.includes(p.state.authMode)) {
      return { kind: 'warn', text: t('mcpDrawer.url.warnPlaintext') };
    }
    return { kind: 'ok', text: t('mcpDrawer.url.ok') };
  }, [url, p.state.authMode]);

  const setField = (patch: Partial<ConnectorFormState>): void => {
    p.onChange(patch);
    // A stale test result is misleading once the URL or auth mode changes.
    if (patch.url !== undefined || patch.authMode !== undefined) setResult(null);
  };

  /** Create-mode "test": client-side URL validation only (no server call —
   * the connector does not exist yet). */
  const clientSideTest = (): TestResult => {
    if (!url) return { ok: false, text: t('mcpDrawer.test.noUrl') };
    if (INTERNAL_URL_RE.test(url)) return { ok: false, text: t('mcpDrawer.test.errInternal') };
    if (!url.startsWith('https://') && PLAINTEXT_RISK_MODES.includes(p.state.authMode)) {
      return {
        ok: false,
        text: fill(t('mcpDrawer.test.errPlaintext'), {
          kind: p.state.authMode === 'user-oauth' ? 'OAuth' : 'API Key',
        }),
      };
    }
    return { ok: true, text: t('mcpDrawer.test.ok') };
  };

  const onTest = async (): Promise<void> => {
    if (testing) return;
    if (p.mode === 'create' || !p.connectorId) {
      setResult(clientSideTest());
      return;
    }
    setTesting(true);
    try {
      const res = await connectorApi.test(p.connectorId);
      if (res.status === 'connected') {
        // A real handshake succeeded and the server synced the tool list —
        // surface how many tools are now on the manifest.
        if (p.mode === 'edit') {
          setResult({ ok: true, text: fill(t('mcpDrawer.test.toolsSynced'), { n: res.toolCount ?? 0 }) });
        } else {
          setResult({ ok: true, text: t('mcpDrawer.test.ok') });
        }
      } else {
        // Map the probe's error taxonomy to a localized reason.
        const reason =
          res.error === 'unauthorized'
            ? t('mcpDrawer.test.reasonUnauthorized')
            : res.error === 'connect-error'
              ? t('mcpDrawer.test.reasonConnect')
              : res.error === 'bad_url'
                ? t('mcpDrawer.test.reasonBadUrl')
                : res.error
                  ? /^http_(\d+)$/.test(res.error)
                    ? `HTTP ${res.error.slice(5)}`
                    : res.error
                  : 'unknown';
        setResult({ ok: false, text: fill(t('mcp.test.err'), { msg: reason }) });
      }
    } catch {
      setResult({ ok: false, text: t('common.error') });
    } finally {
      setTesting(false);
    }
    // Server probe complete: let the caller refetch the row so the tool list
    // and the publish working-copy reflect the (possibly synced) manifest.
    p.onTested?.();
  };

  const inputCls =
    'w-full rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent-primary)]';
  const labelCls = 'flex flex-col gap-1 text-[12px] font-medium text-[var(--text-secondary)]';
  const req = <span className="text-[var(--danger-primary)]">*</span>;

  return (
    <section>
      <h4 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {t('mcp.basicInfo')}
      </h4>
      <div className="grid grid-cols-2 gap-3.5">
        <div className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.serverKey')} {req}
          <input
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.serverKey')}
            placeholder={p.mode === 'create' ? t('mcpDrawer.serverKey.placeholder') : undefined}
            value={p.state.serverKey}
            disabled={p.mode === 'edit'}
            onChange={(e) => setField({ serverKey: e.target.value })}
          />
          <span className="text-xs text-[var(--text-tertiary)]">
            {p.mode === 'create' ? t('mcpDrawer.serverKey.hint') : t('mcpDrawer.serverKey.locked')}
          </span>
        </div>

        <div className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.url')} {req}
          <div className="flex gap-2">
            <input
              className={`${inputCls} min-w-0 flex-1 font-mono`}
              aria-label={t('mcpDrawer.url')}
              placeholder={t('mcp.serverUrlPlaceholder')}
              value={p.state.url}
              onChange={(e) => setField({ url: e.target.value })}
            />
            <button
              type="button"
              onClick={() => void onTest()}
              disabled={testing}
              className="shrink-0 rounded-[6px] border border-[var(--border-default)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              {testing ? t('mcp.status.testing') : t('mcp.test')}
            </button>
          </div>
          <span
            className={
              hint.kind === 'warn'
                ? 'text-xs text-[#B45309]'
                : hint.kind === 'ok'
                  ? 'text-xs text-[#047857]'
                  : 'text-xs text-[var(--text-tertiary)]'
            }
          >
            {hint.text}
          </span>
          {result && (
            <span
              className={
                result.ok ? 'text-[12.5px] text-[#047857]' : 'text-[12.5px] text-[#B91C1C]'
              }
            >
              {result.ok ? '✓ ' : '✕ '}
              {result.text}
            </span>
          )}
        </div>

        <label className={labelCls}>
          {t('mcpDrawer.nameEn')}
          <input
            className={inputCls}
            aria-label={t('mcpDrawer.nameEn')}
            placeholder={t('mcpDrawer.nameEn.placeholder')}
            value={p.state.nameEn}
            onChange={(e) => setField({ nameEn: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          {t('mcpDrawer.nameZh')}
          <input
            className={inputCls}
            aria-label={t('mcpDrawer.nameZh')}
            placeholder={t('mcpDrawer.nameZh.placeholder')}
            value={p.state.nameZh}
            onChange={(e) => setField({ nameZh: e.target.value })}
          />
        </label>

        <label className={labelCls}>
          {t('mcpDrawer.version')}
          <input
            className={`${inputCls} font-mono`}
            aria-label={t('mcpDrawer.version')}
            value={p.state.version}
            onChange={(e) => setField({ version: e.target.value })}
          />
        </label>
        <label className={labelCls}>
          {t('mcp.category')}
          <select
            className={inputCls}
            aria-label={t('mcp.category')}
            value={p.state.categoryId}
            onChange={(e) => setField({ categoryId: e.target.value })}
          >
            <option value="">{t('mcp.category.uncategorized')}</option>
            {p.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className={`col-span-2 ${labelCls}`}>
          {t('mcpDrawer.description')}
          <textarea
            className={`${inputCls} resize-none`}
            aria-label={t('mcpDrawer.description')}
            placeholder={t('mcpDrawer.description.placeholder')}
            rows={2}
            maxLength={200}
            value={p.state.description}
            onChange={(e) => setField({ description: e.target.value })}
          />
        </label>
      </div>
    </section>
  );
}
