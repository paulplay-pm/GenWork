import { ArrowLeftIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useState } from 'react';
import { type TypedUseSelectorHook,useDispatch, useSelector } from 'react-redux';

import type { SsoConnectionWithBinding } from '../../../shared/sso/binding';
import { i18nService } from '../../services/i18n';
import type { AppDispatch } from '../../store';
import {
  fetchSsoBindings,
  setActiveTab,
  setBusy,
  setSearchQuery,
  type SsoBindingsState,
  type SsoBindingsTab,
  startSsoBinding,
  unbindSsoConnection,
} from '../../store/slices/ssoBindingsSlice';

type SsoBindingsRootState = { ssoBindings: SsoBindingsState };

const useAppDispatch: () => AppDispatch = useDispatch;
const useAppSelector: TypedUseSelectorHook<SsoBindingsRootState> = useSelector;

const showToast = (message: string): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const formatError = (key: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  // Mirror i18nService.t's key-as-fallback behaviour for the {error} slot when
  // Task 8 has not yet added the binding keys. The template lives in the
  // dictionary; missing keys fall back to the key string. We append the raw
  // error so the user always sees something useful even before the keys do.
  return `${i18nService.t(key)}: ${message}`;
};

const LETTER_COLORS = [
  'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
  'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400',
];

const pickLetterColor = (name: string): string => {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return LETTER_COLORS[hash % LETTER_COLORS.length];
};

const BrandTile: React.FC<{ name: string; logoUrl: string | null }> = ({ name, logoUrl }) => {
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt=""
        className="h-10 w-10 shrink-0 rounded-lg object-cover"
        data-testid="sso-row-logo"
      />
    );
  }
  const letter = name.charAt(0).toUpperCase() || '?';
  return (
    <div
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-semibold ${pickLetterColor(name)}`}
      data-testid="sso-row-letter"
    >
      {letter}
    </div>
  );
};

const StatusBadge: React.FC<{ bound: boolean }> = ({ bound }) => (
  <span
    data-testid={bound ? 'sso-status-bound' : 'sso-status-unbound'}
    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
      bound
        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
        : 'bg-surface-raised text-secondary'
    }`}
  >
    {bound ? i18nService.t('ssoBindings.statusBound') : i18nService.t('ssoBindings.statusUnbound')}
  </span>
);

interface SsoRowProps {
  connection: SsoConnectionWithBinding;
  busy: boolean;
  globalBusy: boolean;
  onBind: (id: string) => void;
  onUnbind: () => void;
}

const SsoRow: React.FC<SsoRowProps> = ({ connection, busy, globalBusy, onBind, onUnbind }) => {
  const disabled = busy || globalBusy;
  return (
    <div
      className="flex items-start gap-4 rounded-xl border border-border bg-surface p-4 transition-colors"
      data-testid={`sso-row-${connection.id}`}
    >
      <BrandTile name={connection.name} logoUrl={connection.logoUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-sm font-semibold text-foreground"
            data-testid={`sso-row-name-${connection.id}`}
          >
            {connection.name}
          </span>
          <StatusBadge bound={connection.bound} />
        </div>
        <div className="mt-0.5 truncate text-xs text-secondary">{connection.providerType}</div>
        {connection.bound && connection.externalId ? (
          <div
            className="mt-2 truncate text-xs text-secondary"
            data-testid={`sso-bound-external-${connection.id}`}
          >
            {connection.externalId}
          </div>
        ) : null}
      </div>
      <div className="shrink-0">
        {connection.bound ? (
          <button
            type="button"
            onClick={onUnbind}
            disabled={disabled}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60"
            data-testid={`sso-unbind-btn-${connection.id}`}
          >
            {busy ? i18nService.t('ssoBindings.unbinding') : i18nService.t('ssoBindings.unbind')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onBind(connection.id)}
            disabled={disabled}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid={`sso-bind-btn-${connection.id}`}
          >
            {busy ? i18nService.t('ssoBindings.binding') : i18nService.t('ssoBindings.bind')}
          </button>
        )}
      </div>
    </div>
  );
};

interface SsoBindingsPageProps {
  onBack?: () => void;
}

const SsoBindingsPage: React.FC<SsoBindingsPageProps> = ({ onBack }) => {
  const dispatch = useAppDispatch();
  const { connections, status, searchQuery, activeTab, busyConnectionId } = useAppSelector(
    (s) => s.ssoBindings,
  );
  // Local mirror so the controlled input can hold an in-progress value before
  // the debounce-less setSearchQuery dispatch lands in Redux.
  const [queryInput, setQueryInput] = useState(searchQuery);

  useEffect(() => {
    void dispatch(fetchSsoBindings());
  }, [dispatch]);

  useEffect(() => {
    setQueryInput(searchQuery);
  }, [searchQuery]);

  const filtered = useMemo(() => {
    const q = queryInput.trim().toLowerCase();
    return connections.filter((c) => {
      if (activeTab === 'bound' && !c.bound) return false;
      if (activeTab === 'unbound' && c.bound) return false;
      if (q) {
        const hay = `${c.name} ${c.providerType}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [connections, queryInput, activeTab]);

  const counts = useMemo(() => {
    const bound = connections.filter((c) => c.bound).length;
    return {
      all: connections.length,
      bound,
      unbound: Math.max(connections.length - bound, 0),
    };
  }, [connections]);

  const handleBack = (): void => {
    if (onBack) {
      onBack();
      return;
    }
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
    }
  };

  const handleBind = async (id: string): Promise<void> => {
    dispatch(setBusy(id));
    try {
      await dispatch(startSsoBinding(id)).unwrap();
      void dispatch(fetchSsoBindings());
      showToast(i18nService.t('ssoBindings.bindSucceeded'));
    } catch (e) {
      showToast(formatError('ssoBindings.bindError', e));
    } finally {
      dispatch(setBusy(null));
    }
  };

  const handleUnbind = async (): Promise<void> => {
    dispatch(setBusy('unbind'));
    try {
      await dispatch(unbindSsoConnection()).unwrap();
      void dispatch(fetchSsoBindings());
      showToast(i18nService.t('ssoBindings.unbindSucceeded'));
    } catch (e) {
      showToast(formatError('ssoBindings.unbindError', e));
    } finally {
      dispatch(setBusy(null));
    }
  };

  const handleSearch = (next: string): void => {
    setQueryInput(next);
    dispatch(setSearchQuery(next));
  };

  const handleTab = (next: SsoBindingsTab): void => {
    dispatch(setActiveTab(next));
  };

  const handleRetry = (): void => {
    void dispatch(fetchSsoBindings());
  };

  return (
    <div
      className="flex h-full w-full flex-col bg-surface"
      data-testid="sso-bindings-page"
    >
      <header className="flex items-center gap-3 border-b border-border px-5 py-4">
        <button
          type="button"
          onClick={handleBack}
          aria-label={i18nService.t('ssoBindings.back')}
          className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          data-testid="sso-back-btn"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1
            className="truncate text-base font-semibold text-foreground"
            data-testid="sso-page-title"
          >
            {i18nService.t('ssoBindings.title')}
          </h1>
          <p
            className="truncate text-xs text-secondary"
            data-testid="sso-page-subtitle"
          >
            {i18nService.t('ssoBindings.subtitle')}
          </p>
        </div>
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-raised px-2.5 py-1 text-xs font-medium text-foreground"
          data-testid="sso-page-status-pill"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          {counts.bound}/{counts.all}
        </span>
      </header>

      <div className="flex flex-col gap-3 border-b border-border px-5 py-3">
        <div className="relative">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
          <input
            type="search"
            value={queryInput}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={i18nService.t('ssoBindings.searchPlaceholder')}
            className="w-full rounded-lg border border-border bg-surface-raised py-1.5 pl-8 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-secondary focus:border-primary"
            data-testid="sso-search-input"
          />
        </div>
        <div className="flex items-center gap-1" role="tablist">
          {(['all', 'bound', 'unbound'] as const).map((tab) => {
            const active = activeTab === tab;
            const labelKey =
              tab === 'all'
                ? 'ssoBindings.tabAll'
                : tab === 'bound'
                  ? 'ssoBindings.tabBound'
                  : 'ssoBindings.tabUnbound';
            return (
              <button
                type="button"
                key={tab}
                role="tab"
                aria-selected={active}
                onClick={() => handleTab(tab)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-primary text-white'
                    : 'text-secondary hover:bg-surface-raised hover:text-foreground'
                }`}
                data-testid={`sso-tab-${tab}`}
              >
                {i18nService
                  .t(labelKey)
                  .replace('{n}', String(tab === 'all' ? counts.all : tab === 'bound' ? counts.bound : counts.unbound))}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {status === 'loading' && connections.length === 0 ? (
          <div
            className="flex h-full items-center justify-center text-sm text-secondary"
            data-testid="sso-loading"
          >
            {i18nService.t('ssoBindings.loading')}
          </div>
        ) : status === 'error' ? (
          <div
            className="flex flex-col items-center justify-center gap-3 py-12 text-sm text-secondary"
            data-testid="sso-error"
          >
            <p>{i18nService.t('ssoBindings.errorMessage')}</p>
            <button
              type="button"
              onClick={handleRetry}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90"
              data-testid="sso-error-retry"
            >
              {i18nService.t('ssoBindings.retry')}
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-1 py-12 text-sm text-secondary"
            data-testid="sso-empty"
          >
            <p>{i18nService.t('ssoBindings.emptyHint')}</p>
            {connections.length === 0 ? (
              <p className="text-xs">{i18nService.t('ssoBindings.emptyNoConnections')}</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-testid="sso-list">
            {filtered.map((c) => (
              <SsoRow
                key={c.id}
                connection={c}
                busy={busyConnectionId === c.id}
                globalBusy={busyConnectionId !== null && busyConnectionId !== c.id}
                onBind={handleBind}
                onUnbind={handleUnbind}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default SsoBindingsPage;
export { SsoBindingsPage };