import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';

import { modelsApi } from '../api/models';
import { usageApi } from '../api/usage';
import { useAuth } from '../auth/useAuth';
import { PageHeader } from '../components/PageHeader';
import { QuotaBar } from '../components/QuotaBar';

export function UsagePage(): JSX.Element {
  const { claims } = useAuth();
  const orgId = claims?.orgId ?? 'default-org';

  const usageQuery = useQuery({
    queryKey: ['usage', 'today'],
    queryFn: () => usageApi.today(),
  });

  const modelsQuery = useQuery({
    queryKey: ['models', orgId],
    queryFn: () => modelsApi.list(orgId),
  });

  const usage = usageQuery.data;
  const models = modelsQuery.data ?? [];

  if (usageQuery.isLoading || modelsQuery.isLoading) {
    return (
      <div className="p-8">
        <PageHeader title="Usage" />
        <div className="text-[var(--text-secondary)]">Loading…</div>
      </div>
    );
  }

  const usedByModel = new Map(usage?.items.map((i) => [i.model_id, i.used]) ?? []);

  return (
    <div className="p-8">
      <PageHeader title="Usage" />
      <p className="text-sm text-[var(--text-secondary)] mb-4">
        Window date: {usage?.window_date ?? '—'}
      </p>
      <div className="space-y-4 max-w-xl">
        {models.map((m) => {
          const used = usedByModel.get(m.id) ?? 0;
          return (
            <div key={m.id} className="bg-[var(--bg-secondary)] p-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-[var(--text-primary)]">{m.display_name ?? m.model}</span>
                <span className="text-xs text-[var(--text-secondary)]">{m.provider}</span>
              </div>
              {m.quota_per_user_per_day !== null ? (
                <QuotaBar used={used} quota={m.quota_per_user_per_day} />
              ) : (
                <div className="text-xs text-[var(--text-tertiary)]">
                  Used: {used.toLocaleString()} tokens (unlimited)
                </div>
              )}
            </div>
          );
        })}
        {models.length === 0 && (
          <div className="text-[var(--text-secondary)] text-sm">No models configured.</div>
        )}
      </div>
    </div>
  );
}