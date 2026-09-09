import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';

import { auditStore } from '../audit/auditStore';
import { requireAuth, requirePermission } from '../auth/middleware';
import { pool } from '../db/pool';
import { AuditAction } from '../shared/enterpriseServerConstants';
import { PermissionPoint as PP } from '../shared/permissionPoints';
import { encryptConnectorSecrets } from '../vault/connectorSecret';
import {
  connectorCfgSchema,
  createConnectorFromCfg,
  missingAuthField,
  orgFromQuery,
  sseOauthCombination,
} from './mcpConnectors';

/**
 * Member connector submissions + the admin review queue (Task 13).
 *
 * A MEMBER (requireAuth, gated by the org's `members_can_submit_connectors`
 * toggle) POSTs a connector config into `mcp_connector_submissions`; an ADMIN
 * (PP.McpView to list, PP.McpEdit to approve/reject) reviews it. Approve
 * publishes the config as a real connector by reusing the create path
 * (`createConnectorFromCfg`, `onKeyCollision:'suffix'`), records a versions
 * snapshot, and links the submission. Withdraw is author-only.
 *
 * Every org-scoped query is guarded to the caller's `claims.orgId`: a foreign
 * org/row 404s (or 400 org_mismatch on `?orgId=`), never 500s or leaks.
 */

export const SUBMISSION_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

interface SubmissionRow {
  id: string;
  name: string;
  desc: string | null; // the SQL column is the quoted reserved word "desc"
  author_id: string;
  version: string;
  submitted_at: Date;
  status: SubmissionStatus;
  reject_reason: string | null;
  cfg: Record<string, unknown>;
  approved_connector_id: string | null;
}

/** Wire form (camelCase — the SPA's `Submission` contract, Task 12). */
interface SubmissionView {
  id: string;
  name: string;
  desc: string | null;
  authorId: string;
  version: string;
  submittedAt: string;
  status: SubmissionStatus;
  rejectReason: string | null;
  cfg: Record<string, unknown>;
  approvedConnectorId: string | null;
}

// `"desc"` is a reserved word — keep it quoted in every statement.
const SUBMISSION_COLUMNS = `id, name, "desc", author_id, version, submitted_at, status,
  reject_reason, cfg, approved_connector_id`;

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
    approvedConnectorId: r.approved_connector_id,
  };
}

/** Fetch the submission iff it belongs to the caller's org (cross-org guard:
 * a foreign id 404s instead of leaking existence). */
async function loadSubmission(id: string, orgId: string): Promise<SubmissionRow | null> {
  const r = await pool.query<SubmissionRow>(
    `SELECT ${SUBMISSION_COLUMNS} FROM mcp_connector_submissions WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );
  return r.rowCount ? r.rows[0] : null;
}

export const mcpSubmissionsRoutes = new Hono();

/** A member submits a connector config to the review queue. Gated by the
 * org's `members_can_submit_connectors` toggle and validated with the SAME
 * rules as the admin create route (minus org-mismatch — the org comes from
 * the token). The cfg is stored as submitted (secrets are encrypted only when
 * the connector is actually built, on approve). */
mcpSubmissionsRoutes.post('/admin/mcp-connectors/submissions', requireAuth, async c => {
  const claims = c.get('claims');
  const org = await pool.query<{ members_can_submit_connectors: boolean }>(
    'SELECT members_can_submit_connectors FROM orgs WHERE id = $1',
    [claims.orgId],
  );
  if (org.rowCount === 0 || !org.rows[0].members_can_submit_connectors) {
    return c.json({ error: 'submission_disabled' }, 403);
  }
  const parsed = connectorCfgSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const cfg = parsed.data;
  if (sseOauthCombination(cfg.transport, cfg.authMode)) {
    return c.json({ error: 'sse_oauth_not_supported' }, 400);
  }
  const missing = missingAuthField(cfg.authMode, cfg.authConfig);
  if (missing) return c.json({ error: 'missing_auth_field', field: missing }, 400);

  const id = randomUUID();
  const name = cfg.nameZh || cfg.nameEn || cfg.serverKey;
  await pool.query(
    `INSERT INTO mcp_connector_submissions
       (id, org_id, name, "desc", author_id, version, status, cfg)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
    [id, claims.orgId, name, cfg.description ?? null, claims.sub, cfg.version, JSON.stringify(cfg)],
  );
  await auditStore.write({
    orgId: claims.orgId, userId: claims.sub,
    action: AuditAction.McpSubmissionSubmit, targetType: 'submission', targetId: id,
    payload: { serverKey: cfg.serverKey, authMode: cfg.authMode },
  });
  return c.json({ id }, 201);
});

/** The review queue: rows for the caller's org, `submitted_at DESC`, optional
 * `?status=` filter. `counts` are the org-wide per-status totals (the filter
 * is ignored when counting) so the SPA's status chips show the whole queue. */
mcpSubmissionsRoutes.get('/admin/mcp-connectors/submissions', requirePermission(PP.McpView), async c => {
  const org = orgFromQuery(c);
  if (typeof org !== 'string') return org;
  const status = c.req.query('status');
  const rows = status
    ? await pool.query<SubmissionRow>(
        `SELECT ${SUBMISSION_COLUMNS} FROM mcp_connector_submissions
         WHERE org_id = $1 AND status = $2 ORDER BY submitted_at DESC`,
        [org, status],
      )
    : await pool.query<SubmissionRow>(
        `SELECT ${SUBMISSION_COLUMNS} FROM mcp_connector_submissions
         WHERE org_id = $1 ORDER BY submitted_at DESC`,
        [org],
      );
  const counts: Record<SubmissionStatus, number> = {
    pending: 0, approved: 0, rejected: 0, withdrawn: 0,
  };
  const countRes = await pool.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM mcp_connector_submissions
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

/** Approve: publish the submitted config as a connector (reusing the create
 * path — a colliding server_key is suffixed `-2`, `-3`, …), record the
 * versions snapshot, and mark the submission approved. */
mcpSubmissionsRoutes.post(
  '/admin/mcp-connectors/submissions/:id/approve',
  requirePermission(PP.McpEdit),
  async c => {
    const claims = c.get('claims');
    const id = c.req.param('id');
    const sub = await loadSubmission(id, claims.orgId);
    if (!sub) return c.json({ error: 'not_found' }, 404);
    if (sub.status !== 'pending') return c.json({ error: 'not_pending' }, 409);

    // Defensive: the cfg was validated at submit time, but re-validate before
    // building a connector from a stored row.
    const parsed = connectorCfgSchema.safeParse(sub.cfg);
    if (!parsed.success) return c.json({ error: 'invalid_cfg', issues: parsed.error.issues }, 400);

    const result = await pool.transaction(tx =>
      (async () => {
        const created = await createConnectorFromCfg(claims.orgId, parsed.data, {
          createdBy: claims.sub,
          onKeyCollision: 'suffix',
          tx,
        });
        if ('error' in created) return created;

        // The published version snapshot. `config` is NOT NULL — store the
        // validated submitted cfg, i.e. the config the connector was built from
        // (what a rollback would restore). The authConfig is stored ENCRYPTED
        // (mirroring the live row and the publish path) so no plaintext secret
        // is persisted in the versions table — rollback re-canonicalizes it
        // (decrypt-then-re-encrypt) so either ciphertext or a legacy plaintext
        // snapshot self-heals.
        await tx.query(
          `INSERT INTO mcp_connector_versions
             (id, connector_id, version, note, current, config, created_by)
           VALUES ($1, $2, $3, '审核通过发布', TRUE, $4, $5)`,
          [
            randomUUID(),
            created.id,
            parsed.data.version,
            JSON.stringify({ ...parsed.data, authConfig: encryptConnectorSecrets(parsed.data.authConfig ?? {}) }),
            claims.sub,
          ],
        );
        await tx.query(
          `UPDATE mcp_connector_submissions
           SET status = 'approved', approved_connector_id = $1
           WHERE id = $2 AND org_id = $3`,
          [created.id, id, claims.orgId],
        );
        await auditStore.write({
          orgId: claims.orgId, userId: claims.sub,
          action: AuditAction.McpSubmissionApprove, targetType: 'submission', targetId: id,
          payload: { serverKey: created.serverKey, connectorId: created.id, authorId: sub.author_id },
          tx,
        });
        return { id: created.id, serverKey: created.serverKey };
      })()
    );
    if ('error' in result) return c.json(result, 400);
    return c.json({ ok: true, id: result.id });
  },
);

/** Reject: requires a non-empty `reason`; the submission is decided. */
mcpSubmissionsRoutes.post(
  '/admin/mcp-connectors/submissions/:id/reject',
  requirePermission(PP.McpEdit),
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
      `UPDATE mcp_connector_submissions SET status = 'rejected', reject_reason = $1
       WHERE id = $2 AND org_id = $3`,
      [reason, id, claims.orgId],
    );
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub,
      action: AuditAction.McpSubmissionReject, targetType: 'submission', targetId: id,
      payload: { serverKey: sub.cfg.serverKey ?? null, reason },
    });
    return c.json({ ok: true });
  },
);

/** Withdraw: only the AUTHOR of a still-pending submission (an admin who is
 * not the author is refused). */
mcpSubmissionsRoutes.post(
  '/admin/mcp-connectors/submissions/:id/withdraw',
  requireAuth,
  async c => {
    const claims = c.get('claims');
    const id = c.req.param('id');
    const sub = await loadSubmission(id, claims.orgId);
    if (!sub) return c.json({ error: 'not_found' }, 404);
    if (claims.sub !== sub.author_id) return c.json({ error: 'forbidden' }, 403);
    if (sub.status !== 'pending') return c.json({ error: 'not_pending' }, 409);

    await pool.query(
      `UPDATE mcp_connector_submissions SET status = 'withdrawn' WHERE id = $1 AND org_id = $2`,
      [id, claims.orgId],
    );
    await auditStore.write({
      orgId: claims.orgId, userId: claims.sub,
      action: AuditAction.McpSubmissionWithdraw, targetType: 'submission', targetId: id,
      payload: { serverKey: sub.cfg.serverKey ?? null },
    });
    return c.json({ ok: true });
  },
);
