import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { authApi } from '../../api/auth';
import { fetchSsoBindings, startSsoBinding, unbindSsoBinding } from '../../api/ssoBindings';
import { useAuth } from '../../auth/useAuth';
import { t } from '../../i18n';
import type { SsoConnectionWithBinding } from './types';

/** Toast fan-out: no useToast hook in the web per ruling 7b. */
const showToast = (message: string, kind: 'success' | 'error' = 'success'): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: { kind, message } }));
};

const TABS = ['all', 'bound', 'unbound'] as const;
type Tab = (typeof TABS)[number];

const tabLabelKey = (tab: Tab): string =>
  tab === 'all' ? 'ssoBindings.tabAll' : tab === 'bound' ? 'ssoBindings.tabBound' : 'ssoBindings.tabUnbound';

/**
 * SSO account binding page: lists org SSO connections with per-row bind/unbind
 * affordances, search and tab filters, and a status pill (`{bound}/{total}`).
 *
 * `orgName` is resolved from `claims.orgId` via the public `/auth/orgs`
 * listing (the desktop's `MeProfile` does not carry `orgName`, see ruling
 * 15). The bind flow now goes through `POST /me/sso-binding/start`
 * (with `returnTarget: 'web'`) and assigns the returned `authorizeUrl`,
 * so the post-bind redirect lands on the web SPA's
 * `/auth/sso/bind-callback`. Unbind goes through `DELETE /me/sso-binding`
 * and refetches the list.
 */
export function SsoBindingsPage(): JSX.Element {
  const navigate = useNavigate();
  const { claims } = useAuth();
  const qc = useQueryClient();

  const [orgName, setOrgName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  // Resolve org name from claims.orgId via the public /auth/orgs listing.
  // Ruling 15: MeProfile carries no orgName. Cache the result for the page's
  // lifetime; bail to '' so the 绑定 button stays disabled until the org
  // name lands.
  useEffect(() => {
    let cancelled = false;
    const orgId = claims?.orgId;
    if (!orgId) {
      setOrgName('');
      return;
    }
    authApi
      .listOrgs()
      .then((r) => {
        if (cancelled) return;
        const org = r.orgs.find((o) => o.id === orgId);
        setOrgName(org ? org.name : '');
      })
      .catch(() => {
        if (cancelled) return;
        setOrgName('');
      });
    return () => {
      cancelled = true;
    };
  }, [claims?.orgId]);

  // Post-bind: read sessionStorage + URL flags set by /auth/sso/bind-callback.
  // The IdP redirect lands here after a successful bind, an IdP rejection, or
  // any server-side self_binding error. Dispatch the matching toast and clear
  // the flag so a refresh does not re-dispatch.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem('ssoBindJustSucceeded') === '1') {
      sessionStorage.removeItem('ssoBindJustSucceeded');
      showToast(t('ssoBindings.bindSucceeded'), 'success');
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (!err) return;
    const key =
      err === 'bind_external_id_exists'
        ? 'ssoBindings.bindErrorExternalIdExists'
        : err.startsWith('sso_')
          ? 'ssoBindings.bindErrorCancelled'
          : 'ssoBindings.bindError';
    const message = t(key).replace('{error}', err);
    showToast(message, 'error');
    params.delete('error');
    const cleaned = params.toString();
    const url = window.location.pathname + (cleaned ? '?' + cleaned : '');
    window.history.replaceState({}, '', url);
  }, []);

  const list = useQuery({
    queryKey: ['ssoBindings', claims?.orgId],
    queryFn: fetchSsoBindings,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const connections = useMemo(() => list.data ?? [], [list.data]);
  const counts = useMemo(() => {
    const bound = connections.filter((c) => c.bound).length;
    return { all: connections.length, bound, unbound: connections.length - bound };
  }, [connections]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return connections.filter((c) => {
      if (activeTab === 'bound' && !c.bound) return false;
      if (activeTab === 'unbound' && c.bound) return false;
      if (q && !(c.name.toLowerCase().includes(q) || c.providerType.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [connections, searchQuery, activeTab]);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['ssoBindings'] });
  };

  const startBindMut = useMutation({
    mutationFn: (id: string) => startSsoBinding(id),
    onSuccess: (j) => {
      window.location.assign(j.authorizeUrl);
    },
    onError: (e) => {
      const msg = t('ssoBindings.bindError').replace(
        '{error}',
        e instanceof Error ? e.message : String(e),
      );
      showToast(msg, 'error');
    },
  });

  const onBind = (id: string): void => {
    if (!orgName) return;
    startBindMut.mutate(id);
  };

  const unbindMut = useMutation({
    mutationFn: unbindSsoBinding,
    onMutate: () => setBusyId('unbind'),
    onSuccess: () => {
      showToast(t('ssoBindings.unbindSucceeded'), 'success');
      invalidate();
    },
    onError: (e) => {
      const msg = t('ssoBindings.unbindError').replace(
        '{error}',
        e instanceof Error ? e.message : String(e),
      );
      showToast(msg, 'error');
    },
    onSettled: () => setBusyId(null),
  });

  const onUnbind = (): void => {
    unbindMut.mutate();
  };

  const statusBadge = t('ssoBindings.statusBadge')
    .replace('{bound}', String(counts.bound))
    .replace('{total}', String(counts.all));

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label={t('ssoBindings.back')}
          className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          ← {t('ssoBindings.back')}
        </button>
        <h1 className="text-2xl font-semibold text-[var(--text-primary)] mt-2">{t('ssoBindings.title')}</h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">{t('ssoBindings.subtitle')}</p>
        <div className="mt-3 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--bg-secondary)]">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-success)]" />
          <span className="text-sm text-[var(--text-secondary)]">{statusBadge}</span>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-4 mb-4">
        <input
          type="search"
          placeholder={t('ssoBindings.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 px-3 py-2 text-sm border border-[var(--border-default)] rounded-md bg-white text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/30"
        />
        <div className="flex items-center gap-1" role="tablist">
          {TABS.map((tab) => {
            const active = activeTab === tab;
            const count = tab === 'all' ? counts.all : tab === 'bound' ? counts.bound : counts.unbound;
            const label = t(tabLabelKey(tab)).replace('{n}', String(count));
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 text-sm rounded-md ${
                  active
                    ? 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* List / Loading / Error / Empty */}
      {list.isLoading ? (
        <p className="text-sm text-[var(--text-secondary)] py-6 text-center">{t('ssoBindings.loading')}</p>
      ) : list.isError ? (
        <div className="rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-10 text-center">
          <p className="text-sm text-[var(--text-secondary)]">{t('ssoBindings.errorMessage')}</p>
          <button
            type="button"
            onClick={() => void list.refetch()}
            className="mt-3 px-3 py-1.5 text-sm border border-[var(--border-default)] rounded-md hover:bg-[var(--bg-hover)]"
          >
            {t('ssoBindings.retry')}
          </button>
        </div>
      ) : connections.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-10 text-center">
          <p className="text-sm text-[var(--text-primary)]">{t('ssoBindings.emptyNoConnections')}</p>
          <p className="text-xs text-[var(--text-secondary)] mt-2">{t('ssoBindings.emptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <SsoConnectionRow
              key={c.id}
              connection={c}
              busy={busyId !== null}
              bindPending={startBindMut.isPending}
              hasOrgName={Boolean(orgName)}
              onBind={() => onBind(c.id)}
              onUnbind={onUnbind}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SsoConnectionRow(props: {
  connection: SsoConnectionWithBinding;
  busy: boolean;
  bindPending: boolean;
  hasOrgName: boolean;
  onBind: () => void;
  onUnbind: () => void;
}): JSX.Element {
  const { connection: c, busy, bindPending, hasOrgName, onBind, onUnbind } = props;
  return (
    <div className="flex items-center gap-4 p-4 border border-[var(--border-default)] rounded-lg bg-white">
      <div className="w-10 h-10 rounded bg-[var(--bg-secondary)] flex items-center justify-center text-sm font-medium text-[var(--text-primary)]">
        {c.logoUrl ? (
          <img src={c.logoUrl} alt={c.name} className="w-6 h-6" />
        ) : (
          c.name.charAt(0)
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-[var(--text-primary)]">{c.name}</span>
          <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
            {c.providerType}
          </span>
          {c.bound ? (
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--accent-success)]/10 text-[var(--accent-success)]">
              {t('ssoBindings.statusBound')}
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
              {t('ssoBindings.statusUnbound')}
            </span>
          )}
        </div>
        {c.bound && c.externalId && (
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            {t('ssoBindings.boundAccount').replace('{account}', c.externalId)}
          </p>
        )}
      </div>
      <div>
        {c.bound ? (
          <button
            type="button"
            onClick={onUnbind}
            disabled={busy}
            className="px-3 py-1 text-sm text-[var(--accent-danger)] border border-[var(--accent-danger)]/30 rounded disabled:opacity-50"
          >
            {t('ssoBindings.unbind')}
          </button>
        ) : (
          <button
            type="button"
            onClick={onBind}
            disabled={busy || !hasOrgName || bindPending}
            className="px-3 py-1 text-sm bg-[var(--accent-primary)] text-white rounded disabled:opacity-50"
          >
            {t('ssoBindings.bind')}
          </button>
        )}
      </div>
    </div>
  );
}

/** SSO account binding page ends here. */

export default SsoBindingsPage;
