import { PlusIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

import {
  BrowserNetworkMode,
  BrowserProfileMode,
  type BrowserWebAccessConfig,
  normalizeBrowserHostnameList,
} from '../../../shared/browserWebAccess/constants';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import ThemedSelect from '../ui/ThemedSelect';

interface BrowserWebAccessSettingsProps {
  value: BrowserWebAccessConfig;
  onChange: (value: BrowserWebAccessConfig) => void;
}

const HostnameListTarget = {
  BlockedHostnames: 'blockedHostnames',
} as const;

type HostnameListTarget = typeof HostnameListTarget[keyof typeof HostnameListTarget];

const SettingRow: React.FC<{
  title: string;
  description?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ title, description, control, children }) => (
  <div>
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        {description ? <div className="mt-1 text-sm text-secondary">{description}</div> : null}
        {children ? <div className="mt-3">{children}</div> : null}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  </div>
);

const HostnameList: React.FC<{
  title: string;
  description: string;
  hostnames: string[];
  onAdd: () => void;
  onRemove: (hostname: string) => void;
}> = ({ title, description, hostnames, onAdd, onRemove }) => (
  <section className="space-y-2">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        <p className="mt-1 text-sm text-secondary">{description}</p>
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-surface-raised px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
      >
        <PlusIcon className="h-4 w-4" />
        {i18nService.t('add')}
      </button>
    </div>

    <div className="overflow-hidden rounded-lg border border-border bg-background">
      {hostnames.length > 0 ? (
        hostnames.map((hostname, index) => (
          <div
            key={hostname}
            className={`flex min-h-12 items-center justify-between gap-3 px-3 py-2 ${
              index > 0 ? 'border-t border-border' : ''
            }`}
          >
            <span className="truncate text-sm text-foreground">{hostname}</span>
            <button
              type="button"
              onClick={() => onRemove(hostname)}
              className="rounded-md p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-red-500"
              title={i18nService.t('delete')}
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </div>
        ))
      ) : (
        <div className="px-3 py-3 text-sm text-secondary">
          {i18nService.t('browserHostnameListEmpty')}
        </div>
      )}
    </div>
  </section>
);

const BrowserWebAccessSettings: React.FC<BrowserWebAccessSettingsProps> = ({
  value,
  onChange,
}) => {
  const [hostnameDialogTarget, setHostnameDialogTarget] = useState<HostnameListTarget | null>(null);
  const [hostnameDraft, setHostnameDraft] = useState('');
  const hostnameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hostnameDialogTarget) {
      hostnameInputRef.current?.focus();
    }
  }, [hostnameDialogTarget]);

  const update = (patch: Partial<BrowserWebAccessConfig>) => {
    onChange({
      ...value,
      browserEnabled: true,
      profileMode: BrowserProfileMode.Managed,
      ...patch,
    });
  };

  const updateHostnames = (hostnames: string[]) => {
    update({ blockedHostnames: normalizeBrowserHostnameList(hostnames) });
  };

  const openHostnameDialog = (target: HostnameListTarget) => {
    setHostnameDraft('');
    setHostnameDialogTarget(target);
  };

  const closeHostnameDialog = () => {
    setHostnameDialogTarget(null);
    setHostnameDraft('');
  };

  const normalizedHostnameDraft = normalizeBrowserHostnameList([hostnameDraft])[0] ?? '';
  const currentDialogHostnames = hostnameDialogTarget ? value.blockedHostnames : [];
  const canAddHostname = Boolean(
    hostnameDialogTarget
    && normalizedHostnameDraft
    && !currentDialogHostnames.includes(normalizedHostnameDraft),
  );

  const submitHostnameDialog = () => {
    if (!hostnameDialogTarget || !canAddHostname) {
      return;
    }

    updateHostnames([...currentDialogHostnames, normalizedHostnameDraft]);
    closeHostnameDialog();
  };

  const removeHostname = (hostname: string) => {
    updateHostnames(value.blockedHostnames.filter(item => item !== hostname));
  };

  const hostnameDialogTitle = i18nService.t('browserAddBlockedHostnameTitle');
  const hostnameDialogDescription = i18nService.t('browserAddBlockedHostnameDescription');

  const networkModeDescription = value.networkMode === BrowserNetworkMode.Strict
    ? i18nService.t('browserNetworkStrictDescription')
    : i18nService.t('browserNetworkOpenDescription');

  return (
    <>
      <div className="space-y-8">
        <SettingRow
          title={i18nService.t('browserNetworkSectionTitle')}
          description={networkModeDescription}
          control={(
            <div className="w-[300px]">
              <ThemedSelect
                id="browser-network-mode"
                value={value.networkMode}
                onChange={(mode) => update({ networkMode: mode as BrowserNetworkMode })}
                options={[
                  { value: BrowserNetworkMode.ProxyCompatible, label: i18nService.t('browserNetworkOpen') },
                  { value: BrowserNetworkMode.Strict, label: i18nService.t('browserNetworkStrict') },
                ]}
              />
            </div>
          )}
        />

        <HostnameList
          title={i18nService.t('browserBlockedHostnames')}
          description={i18nService.t('browserBlockedHostnamesDescription')}
          hostnames={value.blockedHostnames}
          onAdd={() => openHostnameDialog(HostnameListTarget.BlockedHostnames)}
          onRemove={removeHostname}
        />

      </div>

      {hostnameDialogTarget ? (
        <Modal
          onClose={closeHostnameDialog}
          onEscape={closeHostnameDialog}
          overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/25"
          className="w-full max-w-[420px] rounded-2xl border border-border bg-background p-5 shadow-modal"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">{hostnameDialogTitle}</h3>
              <p className="mt-2 text-sm text-secondary">{hostnameDialogDescription}</p>
            </div>
            <button
              type="button"
              onClick={closeHostnameDialog}
              className="rounded-md p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>

          <input
            ref={hostnameInputRef}
            type="text"
            value={hostnameDraft}
            onChange={(event) => setHostnameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitHostnameDialog();
              }
            }}
            placeholder={i18nService.t('browserHostnameInputPlaceholder')}
            className="mt-4 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-secondary focus:border-primary focus:ring-1 focus:ring-primary/40"
          />

          <div className="mt-4 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={closeHostnameDialog}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={submitHostnameDialog}
              disabled={!canAddHostname}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-gray-400 disabled:text-white"
            >
              {i18nService.t('add')}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
};

export default BrowserWebAccessSettings;
