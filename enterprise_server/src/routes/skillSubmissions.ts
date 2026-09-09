import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import type { TxClient } from '../db/testDb';
import { parseSkillZip, SkillZipError } from '../lib/skillZip';
import { skillStoreDir } from '../lib/stateDir';
import { type SkillScope,UNCATEGORIZED } from '../models/skillMarketplaceView';
import { AuditAction } from '../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../shared/permissionPoints';

/**
 * Member skill submissions + the admin review queue (Task 8).
 *
 * A MEMBER (requireAuth, gated by the org's `members_can_submit_skills`
 * toggle) POSTs a base64 skill zip plus metadata into `skill_submissions`;
 * an ADMIN (PP.SkillView to list, PP.SkillEdit to approve/reject) reviews
 * it. Approve publishes the zip as a real skill (a colliding skill_id is
 * suffixed `-2`, `-3`, …; the submitted scope is sanitized and brought
 * over; the staged zip is moved into the skill's store dir) and links the
 * submission. Withdraw is author-only.
 *
 * Every org-scoped query is guarded to the caller's `claims.orgId`: a
 * foreign id 404s, never 500s or leaks.
 */

export const SUBMISSION_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** Local copy of T4's scope schema (the admin route keeps its own). */
const scopeSchema = z.object({
  allCompany: z.boolean().optional().default(false),
  deptIds: z.array(z.string()).optional().default([]),
  userIds: z.array(z.string()).optional().default([]),
});

/** `zip` is the base64 of the skill archive; metadata is optional. */
const submissionSchema = z.object({
  desc: z.string().max(200).optional(),
  nameZh: z.string().optional(),
  icon: z.string().optional(),
  scope: scopeSchema,
  zip: z.string().min(1),
});

/** The cfg JSONB stored on the row: what was submitted (scope raw — it is
 * sanitized only at approve, against the approving org's departments/users). */
interface SubmissionCfg {
  zip: { fileName: string; fileSize: number; sha256: string };
  scope: SkillScope;
  nameZh?: string;
  icon?: string;
}

interface SubmissionRow {
  id: string;
  name: string;
  desc: string | null; // the SQL column is the quoted reserved word "desc"
  author_id: string;
  version: string;
  submitted_at: Date;
  status: SubmissionStatus;
  reject_reason: string | null;
  cfg: SubmissionCfg;
  approved_skill_id: string | null;
}

/** Wire form (camelCase — the SPA's `Submission` contract). */
interface SubmissionView {
  id: string;
  name: string;
  desc: string | null;
  authorId: string;
  version: string;
  submittedAt: string;
  status: SubmissionStatus;
  rejectReason: string | null;
  cfg: SubmissionCfg;
  approvedSkillId: string | null;
}

// `"desc"` is a reserved word — keep it quoted in every statement.
const SUBMISSION_COLUMNS = `id, name, "desc", author_id, version, submitted_at, status,
  reject_reason, cfg, approved_skill_id`;

function toView(r: SubmissionRow): SubmissionView {
  return {
    id: r.id,
    name: r.name,
    desc: r.desc,
    authorId: r.author_id,
    version: r.version,
    submittedAt: r.submitted_at.toISOString(),
    status: r.status,
    rejectReason: r.reject_reason,
    cfg: r.cfg,
    approvedSkillId: r.approved_skill_id,
  };
}

/** Fetch the submission iff it belongs to the caller's org (cross-org guard:
 * a foreign id 404s instead of leaking existence). */
async function loadSubmission(id: string, orgId: string): Promise<SubmissionRow | null> {
  const r = await pool.query<SubmissionRow>(
    `SELECT ${SUBMISSION_COLUMNS} FROM skill_submissions WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );
  return r.rowCount ? r.rows[0] : null;
}

/** Remove the submission's staged zip dir (`__sub_<id>`). Best-effort: a
 * missing dir is fine (already cleaned, or never staged on this host), and a
 * failure to clean must never break the review flow — it only leaks a small
 * file. Called AFTER a successful approve commit, and on reject/withdraw, so
 * no staged zip survives a decided submission and a rolled-back approve keeps
 * its zip for a retry. Swallows (and logs) a real fs error: at the approve
 * call site the transaction has already committed, so throwing here would 500
 * a successful publish for no benefit. */
function removeStagedZip(id: string): void {
  try {
    rmSync(skillStoreDir(`__sub_${id}`), { recursive: true, force: true });
  } catch (error) {
    console.warn(`[SkillSubmissions] failed to remove staged zip __sub_${id}; leaked on disk:`, error);
  }
}

/** Same rules as `sanitizeScope` in skillMarketplaceAdmin (drop dept/user ids
 * that do not exist in the org; keep allCompany) but run on the given query
 * client. The approve path calls it with the TX client: `sanitizeScope` reads
 * through the module pool, and a pool query issued while `pool.transaction`
 * is open deadlocks under the pglite test pool (single serialized queue). */
async function sanitizeScopeOn(
  db: TxClient,
  scope: SkillScope,
  orgId: string,
): Promise<SkillScope> {
  const deptR = scope.deptIds.length
    ? await db.query<{ id: string }>(
      'SELECT id FROM departments WHERE org_id = $1 AND id = ANY($2)', [orgId, scope.deptIds])
    : { rows: [] as { id: string }[] };
  const userR = scope.userIds.length
    ? await db.query<{ id: string }>(
      'SELECT id FROM users WHERE org_id = $1 AND id = ANY($2)', [orgId, scope.userIds])
    : { rows: [] as { id: string }[] };
  return {
    allCompany: scope.allCompany,
    deptIds: deptR.rows.map((r) => r.id),
    userIds: userR.rows.map((r) => r.id),
  };
}

/** Publish the skill from a submission's stored cfg: re-parse the staged zip
 * (name/version/zip metadata come from the BYTES, never from the row), suffix
 * a colliding skill_id (`-2`, `-3`, …), sanitize the submitted scope, insert
 * the skill row into the org's reserved bucket, and copy the staged zip into
 * the skill's store dir. Runs inside the caller's transaction.
 *
 * The SOURCE staged dir (`__sub_<id>`) is deliberately NOT deleted here: these
 * fs ops are not transactional, so deleting the source before the tx commits
 * would leave a rolled-back approval with no staged zip — and the `existsSync`
 * guard below would 404, permanently wedging the submission. The caller
 * deletes it only after a successful commit (and on reject/withdraw). */
async function createSkillFromCfg(
  orgId: string,
  cfg: { zip: { fileName: string; fileSize: number; sha256: string }; scope: SkillScope; nameZh?: string; icon?: string },
  args: { id: string; createdBy: string; tx: TxClient },
): Promise<{ id: string; name: string } | { error: string }> {
  const storedZip = join(skillStoreDir(`__sub_${args.id}`), 'skill.zip');
  if (!existsSync(storedZip)) return { error: 'not_found' };
  let parsed: ReturnType<typeof parseSkillZip>;
  try {
    parsed = parseSkillZip(readFileSync(storedZip));
  } catch (e) {
    if (e instanceof SkillZipError) return { error: e.code };
    throw e;
  }
  let name = parsed.name;
  let n = 2;
  while (
    (await args.tx.query(
      'SELECT 1 FROM skill_marketplace_skills WHERE skill_id = $1 AND org_id = $2',
      [name, orgId],
    )).rowCount
  ) {
    name = `${parsed.name}-${n}`;
    n++;
  }
  const scope = await sanitizeScopeOn(args.tx, cfg.scope ?? { allCompany: false, deptIds: [], userIds: [] }, orgId);
  await args.tx.query(
    `INSERT INTO skill_marketplace_skills
       (skill_id, name_en, name_zh, description_en, description_zh, icon, version,
        category_id, source_json, org_id, scope, zip_file_name, zip_file_size, zip_sha256,
        enabled, created_by, updated_by)
     VALUES ($1,$1,$2,$3,$3,$4,$5,$6,'{}'::jsonb,$7,$8::jsonb,$9,$10,$11,TRUE,$12,$12)`,
    [name, cfg.nameZh ?? null, parsed.name, cfg.icon ?? null, parsed.version,
     UNCATEGORIZED, orgId, JSON.stringify(scope), parsed.fileName, parsed.size,
     parsed.sha256, args.createdBy],
  );
  // Copy the staged zip into the skill's own store dir (drop any stale copy).
  // The source staged dir is left in place — see the function doc: it is
  // removed by the caller after the transaction commits (or on reject/withdraw).
  rmSync(skillStoreDir(name), { recursive: true, force: true });
  mkdirSync(skillStoreDir(name), { recursive: true });
  copyFileSync(storedZip, join(skillStoreDir(name), 'skill.zip'));
  return { id: name, name };
}

export const skillSubmissionsRoutes = new Hono();

/** A member submits a skill zip to the review queue. Gated by the org's
 * `members_can_submit_skills` toggle; the zip is base64 in the body. The
 * scope is stored AS SUBMITTED (raw) — it is sanitized at approve. */
skillSubmissionsRoutes.post('/api/admin/skill-marketplace/submissions', requireAuth, async c => {
  const claims = c.get('claims');
  const org = await pool.query<{ members_can_submit_skills: boolean }>(
    'SELECT members_can_submit_skills FROM orgs WHERE id = $1',
    [claims.orgId],
  );
  if (org.rowCount === 0 || !org.rows[0].members_can_submit_skills) {
    return c.json({ error: 'submission_disabled' }, 403);
  }
  const parsed = submissionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const b = parsed.data;
  const buf = Buffer.from(b.zip, 'base64');
  let zip: ReturnType<typeof parseSkillZip>;
  try {
    zip = parseSkillZip(buf);
  } catch (e) {
    if (e instanceof SkillZipError) return c.json({ error: e.code }, e.code === 'too_large' ? 413 : 400);
    throw e;
  }
  const id = randomUUID();
  // nameZh/icon are included only when present (undefined drops on stringify).
  const cfg = JSON.stringify({
    zip: { fileName: zip.fileName, fileSize: zip.size, sha256: zip.sha256 },
    scope: b.scope,
    nameZh: b.nameZh,
    icon: b.icon,
  });
  await pool.query(
    `INSERT INTO skill_submissions
       (id, org_id, name, "desc", author_id, version, status, cfg)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
    [id, claims.orgId, zip.name, b.desc ?? null, claims.sub, zip.version, cfg],
  );
  const staged = skillStoreDir(`__sub_${id}`);
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, 'skill.zip'), buf);
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.SkillSubmissionSubmit, targetType: 'submission', targetId: id,
    payload: { name: zip.name, version: zip.version },
  });
  return c.json({ id }, 201);
});

/** The review queue: rows for the caller's org, `submitted_at DESC`, optional
 * `?status=` filter. `counts` are the org-wide per-status totals (the filter
 * is ignored when counting) so the SPA's status chips show the whole queue. */
skillSubmissionsRoutes.get('/api/admin/skill-marketplace/submissions', requirePermission(PP.SkillView), async c => {
  const claims = c.get('claims');
  const org = claims.orgId; // org comes from the token ONLY (no ?orgId=).
  const status = c.req.query('status');
  const rows = status
    ? await pool.query<SubmissionRow>(
        `SELECT ${SUBMISSION_COLUMNS} FROM skill_submissions
         WHERE org_id = $1 AND status = $2 ORDER BY submitted_at DESC`,
        [org, status],
      )
    : await pool.query<SubmissionRow>(
        `SELECT ${SUBMISSION_COLUMNS} FROM skill_submissions
         WHERE org_id = $1 ORDER BY submitted_at DESC`,
        [org],
      );
  const counts: Record<SubmissionStatus, number> = {
    pending: 0, approved: 0, rejected: 0, withdrawn: 0,
  };
  const countRes = await pool.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM skill_submissions
     WHERE org_id = $1 GROUP BY status`,
    [org],
  );
  for (const row of countRes.rows) {
    if ((SUBMISSION_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as SubmissionStatus] = row.n;
    }
  }
  return c.json({ submissions: rows.rows.map(toView), counts });
});

/** Approve: publish the submitted zip as a skill (reusing the stored cfg — a
 * colliding skill_id is suffixed `-2`, `-3`, …; the scope is sanitized and
 * brought over), mark the submission approved, and link the new skill. The
 * whole publish + link + audit runs in one transaction. */
skillSubmissionsRoutes.post(
  '/api/admin/skill-marketplace/submissions/:id/approve',
  requirePermission(PP.SkillEdit),
  async c => {
    const claims = c.get('claims');
    const id = c.req.param('id');
    const sub = await loadSubmission(id, claims.orgId);
    if (!sub) return c.json({ error: 'not_found' }, 404);
    if (sub.status !== 'pending') return c.json({ error: 'not_pending' }, 409);

    const result = await pool.transaction(async tx => {
      const created = await createSkillFromCfg(claims.orgId, sub.cfg, {
        id, createdBy: claims.sub, tx,
      });
      if ('error' in created) return created;
      await tx.query(
        `UPDATE skill_submissions
         SET status = 'approved', approved_skill_id = $1
         WHERE id = $2 AND org_id = $3`,
        [created.id, id, claims.orgId],
      );
      await auditStore.write({
        orgId: claims.orgId, userId: claims.sub,
        action: AuditAction.SkillSubmissionApprove, targetType: 'submission', targetId: id,
        payload: { name: created.id, authorId: sub.author_id },
        tx,
      });
      return { id: created.id, name: created.name };
    });
    if ('error' in result) {
      return c.json({ error: result.error }, result.error === 'not_found' ? 404 : 400);
    }
    // The transaction committed and the zip is copied into the skill's store
    // dir — now safe to drop the staged copy. On a rolled-back approve the
    // transaction rejects before reaching here, so the staged zip is kept for
    // a retry (see the createSkillFromCfg doc on why this cannot happen
    // pre-commit).
    removeStagedZip(id);
    return c.json({ ok: true, id: result.id });
  },
);

/** Reject: requires a non-empty `reason`; the submission is decided. */
skillSubmissionsRoutes.post(
  '/api/admin/skill-marketplace/submissions/:id/reject',
  requirePermission(PP.SkillEdit),
  async c => {
    const claims = c.get('claims');
    const id = c.req.param('id');
    const sub = await loadSubmission(id, claims.orgId);
    if (!sub) return c.json({ error: 'not_found' }, 404);
    if (sub.status !== 'pending') return c.json({ error: 'not_pending' }, 409);

    let body: { reason?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return c.json({ error: 'reason_required' }, 400);

    await pool.query(
      `UPDATE skill_submissions SET status = 'rejected', reject_reason = $1
       WHERE id = $2 AND org_id = $3`,
      [reason, id, claims.orgId],
    );
    // Decided: the staged zip is no longer needed.
    removeStagedZip(id);
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub,
      action: AuditAction.SkillSubmissionReject, targetType: 'submission', targetId: id,
      payload: { name: sub.name, reason },
    });
    return c.json({ ok: true });
  },
);

/** Withdraw: only the AUTHOR of a still-pending submission (an admin who is
 * not the author is refused). */
skillSubmissionsRoutes.post(
  '/api/admin/skill-marketplace/submissions/:id/withdraw',
  requireAuth,
  async c => {
    const claims = c.get('claims');
    const id = c.req.param('id');
    const sub = await loadSubmission(id, claims.orgId);
    if (!sub) return c.json({ error: 'not_found' }, 404);
    if (claims.sub !== sub.author_id) return c.json({ error: 'forbidden' }, 403);
    if (sub.status !== 'pending') return c.json({ error: 'not_pending' }, 409);

    await pool.query(
      `UPDATE skill_submissions SET status = 'withdrawn' WHERE id = $1 AND org_id = $2`,
      [id, claims.orgId],
    );
    // Decided (author-initiated): the staged zip is no longer needed.
    removeStagedZip(id);
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub,
      action: AuditAction.SkillSubmissionWithdraw, targetType: 'submission', targetId: id,
      payload: { name: sub.name },
    });
    return c.json({ ok: true });
  },
);
