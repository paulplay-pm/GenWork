import type { JSX } from 'react';

import { Switch } from '../../components/Switch';
import { t } from '../../i18n';

interface Props {
  enabled: boolean;
  canManage: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}

/**
 * "服务商已启用 / 已停用" slide-switch row, matching the prototype's
 * `switch-row`. Renders for any selected provider; the toggle is disabled for
 * read-only users (`canManage=false`) or while a mutation is in flight.
 */
export function ProviderEnableSwitch({
  enabled,
  canManage,
  busy,
  onToggle,
}: Props): JSX.Element {
  const title = enabled
    ? t('providersModels.enable.titleOn')
    : t('providersModels.enable.titleOff');
  const hint = enabled
    ? t('providersModels.enable.hintOn')
    : t('providersModels.enable.hintOff');

  return (
    <div
      className={`flex items-center justify-between rounded-[var(--radius-md)] border px-4 py-3 ${
        enabled
          ? 'border-[var(--border-subtle)] bg-[var(--bg-secondary)]'
          : 'border-[var(--warning-light)] bg-[var(--warning-light)]/40'
      }`}
    >
      <div className="flex flex-col">
        <span className="text-sm font-medium text-[var(--text-primary)]">{title}</span>
        <span className="text-xs text-[var(--text-secondary)]">{hint}</span>
      </div>
      <Switch
        checked={enabled}
        disabled={!canManage || busy}
        onChange={onToggle}
        label={t('providersModels.enable.switch')}
      />
    </div>
  );
}
