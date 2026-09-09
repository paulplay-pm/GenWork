// web/src/components/UserSsoBindingCell.tsx
// Tiny per-row fetcher for the UsersPage SSO-binding column. Each instance
// owns a `useQuery` keyed by `userId`, so the loader state stays localized
// to the row and a slow / failing fetch doesn't block the whole table.
// 404 (cross-org / missing user) is normalized to "Unbound" by
// `getUserSsoBinding`; the cell never shows an error toast for that case.

import { useQuery } from '@tanstack/react-query';
import type { JSX } from 'react';

import { getUserSsoBinding, type SsoBinding } from '../api/sso';
import { t } from '../i18n';

interface Props {
  userId: string;
}

/** Truncate an SSO external id to the first 16 chars with an ellipsis. */
function trimExternalId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

/** "Feishu · ou_abc1234567…" — connection name plus a truncated external
 *  id. Falls back to "Unbound" when the row has no binding or the fetch
 *  failed. */
export function UserSsoBindingCell({ userId }: Props): JSX.Element {
  const q = useQuery<SsoBinding | null>({
    queryKey: ['user-sso-binding', userId],
    queryFn: () => getUserSsoBinding(userId),
    staleTime: 30_000,
  });
  if (q.isPending) return <span className="text-[var(--text-tertiary)]">…</span>;
  const b = q.data;
  if (!b) return <span className="text-[var(--text-tertiary)]">{t('sso.binding.unbound')}</span>;
  return (
    <span className="text-[var(--text-primary)]">
      {b.connectionName}
      <span className="ml-1 font-mono text-xs text-[var(--text-tertiary)]">
        · {trimExternalId(b.externalId)}
      </span>
    </span>
  );
}