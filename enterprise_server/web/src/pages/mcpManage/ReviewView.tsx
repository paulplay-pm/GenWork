import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import dayjs from 'dayjs';

import type { Submission, SubmissionStatus } from '../../api/connectors';
import type { UserRow } from '../../api/users';
import { t } from '../../i18n';
import { fill } from './types';
import { RejectReasonModal } from './RejectReasonModal';
import { ReviewDetailDrawer } from './ReviewDetailDrawer';
import { STATUS_TAG, authorInfo } from './reviewShared';

type StatusFilter = SubmissionStatus | 'all';

interface Props {
  /** The full submission list (unfiltered); the status chips filter client-side. */
  submissions: Submission[];
  members: UserRow[];
  /** Approve: the page performs `approveSubmission` + invalidation + toast. */
  onApprove: (id: string) => Promise<void> | void;
  /** Reject: the page performs `rejectSubmission(id, reason)` + invalidation + toast. */
  onReject: (id: string, reason: string) => Promise<void> | void;
}

/**
 * The 连接器审核 tab: status filter chips (each with its count; 全部 has no
 * count, matching the prototype), the submissions table, and the detail
 * drawer + forced rejection-reason modal. Row actions: 待审核 → 通过 · 驳回;
 * anything else → 详情. Row click opens the detail drawer.
 */
export function ReviewView(p: Props): JSX.Element {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<SubmissionStatus, number> = { pending: 0, approved: 0, rejected: 0, withdrawn: 0 };
    for (const s of p.submissions) c[s.status] += 1;
    return c;
  }, [p.submissions]);

  const visible = filter === 'all' ? p.submissions : p.submissions.filter((s) => s.status === filter);
  const detail = detailId ? (p.submissions.find((s) => s.id === detailId) ?? null) : null;
  const rejectSub = rejectId ? (p.submissions.find((s) => s.id === rejectId) ?? null) : null;

  const chips: { value: StatusFilter; label: string }[] = [
    { value: 'pending', label: t('mcp.status.pending') },
    { value: 'approved', label: t('mcp.status.approved') },
    { value: 'rejected', label: t('mcp.status.rejected') },
    { value: 'withdrawn', label: t('mcp.status.withdrawn') },
    { value: 'all', label: t('mcp.all') },
  ];

  const approve = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await p.onApprove(id);
      setDetailId(null);
    } catch {
      // The page surfaced the error toast; keep the drawer open for a retry.
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (id: string, reason: string): Promise<void> => {
    setBusyId(id);
    try {
      await p.onReject(id, reason);
      setRejectId(null);
      setDetailId(null);
    } catch {
      // The page surfaced the error toast; keep the modal open for a retry.
    } finally {
      setBusyId(null);
    }
  };

  const chipCls = (on: boolean): string =>
    `inline-flex items-center rounded-full border px-3.5 py-1.5 text-[13px] transition ${on
      ? 'border-[var(--text-primary)] bg-[var(--text-primary)] font-medium text-white'
      : 'border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)]'}`;

  const btnSm = 'rounded-[6px] px-2.5 py-1 text-[12.5px] disabled:opacity-50';

  return (
    <div>
      <p className="mb-3.5 text-[13px] text-[var(--text-tertiary)]">{t('mcp.review.intro')}</p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {chips.map((chip) => {
          const on = filter === chip.value;
          return (
            <button key={chip.value} type="button" onClick={() => setFilter(chip.value)} className={chipCls(on)}>
              {chip.label}
              {chip.value !== 'all' && (
                <span className={`ml-1 text-[12px] ${on ? 'text-white/80' : 'text-[var(--text-tertiary)]'}`}>
                  （{counts[chip.value as SubmissionStatus]}）
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-secondary)]">
        <table className="w-full min-w-[880px] border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b border-[var(--border-default)] bg-[var(--bg-tertiary)]/60 text-left text-[12.5px] font-medium text-[var(--text-tertiary)]">
              <th className="w-[18%] px-4 py-2.5">{t('mcp.review.col.name')}</th>
              <th className="w-[24%] px-4 py-2.5">{t('mcp.review.col.desc')}</th>
              <th className="w-[12%] px-4 py-2.5">{t('mcp.review.col.author')}</th>
              <th className="w-[7%] px-4 py-2.5">{t('mcp.review.col.version')}</th>
              <th className="w-[13%] px-4 py-2.5">{t('mcp.review.col.submittedAt')}</th>
              <th className="w-[9%] px-4 py-2.5">{t('mcp.review.col.status')}</th>
              <th className="w-[17%] px-4 py-2.5 text-right">{t('mcp.review.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-[13.5px] text-[var(--text-tertiary)]">
                  {t('mcp.review.emptyFiltered')}
                </td>
              </tr>
            ) : (
              visible.map((s) => {
                const author = authorInfo(s.authorId, p.members);
                const busy = busyId === s.id;
                return (
                  <tr
                    key={s.id}
                    onClick={() => setDetailId(s.id)}
                    className="cursor-pointer border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-tertiary)]/50"
                  >
                    <td className="px-4 py-3 font-semibold text-[var(--text-primary)]">{s.name}</td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">
                      {s.desc ?? '—'}
                      {s.status === 'rejected' && s.rejectReason && (
                        <div className="mt-1 text-[12px] text-[var(--danger-primary)]">
                          {fill(t('mcp.review.rejectReasonLabel'), { reason: s.rejectReason })}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-[var(--text-primary)]">{author.name}</div>
                      {author.dept && (
                        <div className="text-[11.5px] text-[var(--text-tertiary)]">{author.dept}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12.5px] text-[var(--text-primary)]">{s.version}</td>
                    <td className="px-4 py-3 text-[12.5px] text-[var(--text-secondary)]">
                      {dayjs(s.submittedAt).format('YYYY-MM-DD HH:mm')}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-[18px] ${STATUS_TAG[s.status].cls}`}>
                        {t(STATUS_TAG[s.status].key)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {s.status === 'pending' ? (
                        <span onClick={(e) => e.stopPropagation()} className="inline-flex gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void approve(s.id)}
                            className={`${btnSm} bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary-hover)]`}
                          >
                            {t('mcp.review.approve')}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setRejectId(s.id)}
                            className={`${btnSm} border border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]`}
                          >
                            {t('mcp.review.actionReject')}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setDetailId(s.id); }}
                          className={`${btnSm} border border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]`}
                        >
                          {t('mcp.review.detail')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {detail && (
        <ReviewDetailDrawer
          submission={detail}
          members={p.members}
          busy={busyId === detail.id}
          escDisabled={rejectId !== null}
          onClose={() => setDetailId(null)}
          onApprove={approve}
          onRejectRequest={setRejectId}
        />
      )}

      <RejectReasonModal
        open={rejectSub !== null}
        name={rejectSub?.name ?? ''}
        busy={rejectId !== null && busyId !== null}
        onCancel={() => setRejectId(null)}
        onConfirm={(reason) => (rejectId ? reject(rejectId, reason) : Promise.resolve())}
      />
    </div>
  );
}
