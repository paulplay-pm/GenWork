import dayjs from 'dayjs';
import type { JSX } from 'react';
import { useEffect } from 'react';

import type { SkillSubmission } from '../../api/skillMarketplace';
import type { UserRow } from '../../api/users';
import { t } from '../../i18n';
import { authorInfo,STATUS_TAG } from './skillReviewShared';
import { fill } from './types';

interface Props {
  submission: SkillSubmission;
  members: UserRow[];
  /** While an approve/reject request for this submission is in flight. */
  busy: boolean;
  /** Suppress the drawer's own Escape handler (the reject-reason modal on
   * top handles Esc while it is open). */
  escDisabled?: boolean;
  onClose: () => void;
  onApprove: (id: string) => Promise<void> | void;
  /** Opens the forced rejection-reason modal (never calls the API itself). */
  onRejectRequest: (id: string) => void;
}

const TAG = 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-[18px]';

/** Defensive read of the free-form `cfg` JSONB: never assume exact keys. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Human-readable byte size for the package row (KB/MB, 1 decimal). */
const fmtSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;

/** Scope text from `cfg.scope` (structured) or a `cfg.depts` name array. */
function scopeText(cfg: Record<string, unknown>): string {
  const scope = cfg.scope;
  if (scope && typeof scope === 'object') {
    const s = scope as { allCompany?: unknown; deptIds?: unknown; userIds?: unknown };
    if (s.allCompany === true) return t('skillmgmt.scope.allCompany');
    const deptIds = Array.isArray(s.deptIds) ? s.deptIds.filter((x): x is string => typeof x === 'string') : [];
    const userIds = Array.isArray(s.userIds) ? s.userIds.filter((x): x is string => typeof x === 'string') : [];
    const n = deptIds.length;
    const m = userIds.length;
    if (n === 0 && m === 0) return t('skillmgmt.scope.emptySummary');
    if (n === 0) return fill(t('skillmgmt.scope.users'), { m });
    if (m === 0) return fill(t('skillmgmt.scope.depts'), { n });
    return fill(t('skillmgmt.scope.deptsAndUsers'), { n, m });
  }
  const depts = Array.isArray(cfg.depts) ? cfg.depts.filter((x): x is string => typeof x === 'string') : [];
  if (depts.length === 0) return t('skillmgmt.scope.emptySummary');
  return depts.join('、');
}

const LABEL = 'text-[12px] font-medium text-[var(--text-tertiary)]';
const VALUE = 'mt-1 text-[13.5px] leading-snug text-[var(--text-primary)]';

/**
 * Right-side drawer for one submission (mirrors the prototype's
 * `openReviewDetail`): status, submitter/time/description, the complete
 * submitted config, the rejection notes when rejected, and the pending-only
 * action footer (取消 / 驳回 / 通过并发布).
 *
 * Data shape note: the server's `cfg` JSONB only holds the zip meta, scope,
 * nameZh, and icon — the name/version/description are TOP-LEVEL
 * `SkillSubmission` fields, so the config section reads those from `s` and
 * only scope/zip from `s.cfg`.
 */
export function SkillReviewDetailDrawer(p: Props): JSX.Element {
  const s = p.submission;
  const author = authorInfo(s.authorId, p.members);
  const zip = (typeof s.cfg.zip === 'object' && s.cfg.zip)
    ? (s.cfg.zip as { fileName?: string; fileSize?: number; sha256?: string })
    : null;

  // Track the stable sub-fields of props (not the whole `p` object) so the
  // Esc listener only rebinds when they change.
  const { escDisabled, onClose } = p;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || escDisabled) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [escDisabled, onClose]);

  const btn = 'rounded-[6px] px-3 py-1.5 text-[13px] disabled:opacity-50';

  return (
    <aside className="fixed inset-y-0 right-0 z-[101] flex w-[560px] max-w-[94vw] flex-col border-l border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-[-8px_0_24px_rgba(15,23,42,0.08)]">
      <header className="flex items-center justify-between border-b border-[var(--border-default)] p-5">
        <h3 className="truncate text-[16px] font-semibold text-[var(--text-primary)]">
          {fill(t('skillmgmt.review.detail.title'), { name: s.name })}
        </h3>
        <button
          type="button"
          onClick={p.onClose}
          aria-label={t('common.close')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-5">
        <div className="mb-4">
          <span className={`${TAG} ${STATUS_TAG[s.status].cls}`}>{t(STATUS_TAG[s.status].key)}</span>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <div>
            <dt className={LABEL}>{t('skillmgmt.review.detail.submitter')}</dt>
            <dd className={VALUE}>
              {author.name}
              {author.dept ? ` · ${author.dept}` : ''}
            </dd>
          </div>
          <div>
            <dt className={LABEL}>{t('skillmgmt.review.col.submittedAt')}</dt>
            <dd className={VALUE}>{dayjs(s.submittedAt).format('YYYY-MM-DD HH:mm')}</dd>
          </div>
          <div className="col-span-2">
            <dt className={LABEL}>{t('skillmgmt.review.col.desc')}</dt>
            <dd className="mt-1 text-[13.5px] leading-snug text-[var(--text-secondary)]">{s.desc ?? '—'}</dd>
          </div>
        </dl>

        <section className="mt-5 border-t border-dashed border-[var(--border-default)] pt-4">
          <h4 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
            {t('skillmgmt.review.detail.config')}
          </h4>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            <div className="col-span-2">
              <dt className={LABEL}>{t('skillmgmt.review.detail.name')}</dt>
              <dd className={VALUE}>{str(s.name) || '—'}</dd>
            </div>
            <div>
              <dt className={LABEL}>{t('skillmgmt.review.detail.version')}</dt>
              <dd className="mt-1 font-mono text-[12.5px] text-[var(--text-primary)]">{str(s.version) || '—'}</dd>
            </div>
            <div>
              <dt className={LABEL}>{t('skillmgmt.review.detail.desc')}</dt>
              <dd className={VALUE}>{s.desc ?? '—'}</dd>
            </div>
            <div className="col-span-2">
              <dt className={LABEL}>{t('skillmgmt.review.detail.scope')}</dt>
              <dd className={VALUE}>{scopeText(s.cfg)}</dd>
            </div>
            <div className="col-span-2">
              <dt className={LABEL}>{t('skillmgmt.review.detail.zip')}</dt>
              <dd className="mt-1 text-[12.5px] text-[var(--text-primary)]">
                {zip && str(zip.fileName) ? (
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="font-mono">{str(zip.fileName)}</span>
                    {typeof zip.fileSize === 'number' && (
                      <span className="text-[var(--text-tertiary)]">{fmtSize(zip.fileSize)}</span>
                    )}
                    {str(zip.sha256) && (
                      <span className="font-mono text-[var(--text-tertiary)]">sha256: {str(zip.sha256).slice(0, 8)}</span>
                    )}
                  </span>
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
        </section>

        {s.status === 'rejected' && s.rejectReason && (
          <section className="mt-5">
            <h4 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              {t('skillmgmt.review.detail.rejectReason')}
            </h4>
            <div className="rounded-[8px] bg-[var(--danger-light)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--danger-primary)]">
              {s.rejectReason}
            </div>
          </section>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-[var(--border-default)] bg-[var(--bg-tertiary)] p-3">
        {s.status === 'pending' ? (
          <>
            <button
              type="button"
              onClick={p.onClose}
              disabled={p.busy}
              className={`${btn} border border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]`}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => p.onRejectRequest(s.id)}
              disabled={p.busy}
              className={`${btn} border border-[var(--border-default)] text-[var(--danger-primary)] hover:bg-[var(--danger-primary)]/10`}
            >
              {t('skillmgmt.review.actionReject')}
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => void p.onApprove(s.id)}
              disabled={p.busy}
              className={`${btn} bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary-hover)]`}
            >
              {p.busy ? t('common.loading') : t('skillmgmt.review.detail.approve')}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={p.onClose}
            className={`${btn} border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]`}
          >
            {t('common.close')}
          </button>
        )}
      </footer>
    </aside>
  );
}
