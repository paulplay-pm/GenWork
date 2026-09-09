import { RefreshCw } from 'lucide-react';
import type { JSX } from 'react';

import type { ProviderKeyView } from '../../api/providers';
import { brandColor, providerDisplayName } from '../../data/providerCatalog';
import { t } from '../../i18n';

interface Props {
  provider: ProviderKeyView;
  canManage: boolean;
  /** Disable the actions while a mutation (test / save) is in flight. */
  busy: boolean;
  onTest: (id: string) => void;
  onSave: (id: string) => void;
}

/**
 * Top-of-detail header for a selected provider: 48px brand square, name,
 * 内置/自定义 tag, and the Base URL. Right side holds 测试连接 (ghost) and
 * 保存 (primary). Deleting a provider now lives on the rail row.
 */
export function ProviderHeaderBar({
  provider,
  canManage,
  busy,
  onTest,
  onSave,
}: Props): JSX.Element {
  const name = provider.label ?? providerDisplayName(provider.provider);
  return (
    <div className="flex items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-xl font-semibold text-white"
          style={{ backgroundColor: brandColor(provider.provider) }}
        >
          {name.charAt(0)}
        </span>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
              {name}
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                provider.is_builtin
                  ? 'bg-[var(--accent-light)] text-[var(--accent-primary)]'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
              }`}
            >
              {provider.is_builtin
                ? t('providersModels.rail.builtin')
                : t('providersModels.rail.custom')}
            </span>
          </div>
          <span className="truncate font-mono text-xs text-[var(--text-tertiary)]">
            {provider.endpoint || t('providersModels.test.noEndpoint')}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => onTest(provider.id)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t('providersModels.header.test')}
        </button>
        {canManage && (
          <button
            type="button"
            onClick={() => onSave(provider.id)}
            disabled={busy}
            className="rounded-[var(--radius-sm)] bg-[var(--accent-primary)] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[var(--accent-primary-hover)] disabled:opacity-50 transition-colors"
          >
            {t('providersModels.header.save')}
          </button>
        )}
      </div>
    </div>
  );
}
