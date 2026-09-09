// Route tests for the member-connector submission queue (Task 13).
// Pins: the org toggle gate on submit, the shared validation guards (same as
// the create route), the approve path that builds a connector via the shared
// create logic (colliding server_key → -2/-3 suffix) + the current versions
// snapshot row, reject (forced reason), withdraw (author-only), the camelCase
// wire shape + org-wide counts on the list route, cross-org isolation
// (foreign id 404s), and authz gating (a plain member 403s on admin routes).
//
// The test app mirrors server.ts: mcpSubmissionsRoutes is mounted BEFORE
// mcpConnectorsRoutes, whose GET /admin/mcp-connectors/:id pattern would
// otherwise shadow GET /admin/mcp-connectors/submissions.
import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});

import { Hono } from 'hono';

import { signToken } from '../../src/auth/jwt';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { mcpConnectorsRoutes } from '../../src/routes/mcpConnectors';
import { mcpSubmissionsRoutes } from '../../src/routes/mcpSubmissions';

const PLAINTEXT_KEY = 'sk-live-1234';

const app = new Hono();
app.route('/', mcpSubmissionsRoutes);
app.route('/', mcpConnectorsRoutes);

async function seedOrgs(): Promise<void> {
  await testPool.query(`INSERT INTO orgs(id, name) VALUES ('o1', 'T1'), ('o2', 'T2')`);
}

async function enableSubmissions(orgId: string): Promise<void> {
  await testPool.query('UPDATE orgs SET members_can_submit_connectors = TRUE WHERE id = $1', [orgId]);
}

async function superAdminTok(orgId: string): Promise<string> {
  return signToken({ sub: 'admin', orgId, roles: ['super_admin'] });
}

async function memberTok(sub = 'author'): Promise<string> {
  return signToken({ sub, orgId: 'o1', roles: ['member'] });
}

/** A submission body: the create shape minus `orgId` (org comes from the token). */
function submissionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverKey: 'jira-mcp',
    url: 'https://mcp.example.com/jira',
    nameEn: 'Jira',
    nameZh: 'Jira 连接器',
    version: '1.0.0',
    authMode: 'shared-key',
    authConfig: { apiKey: PLAINTEXT_KEY },
    ...overrides,
  };
}

async function submit(tok: string, body: Record<string, unknown>): Promise<Response> {
  return app.request('/admin/mcp-connectors/submissions', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(tok: string, path: string, body?: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body } : {}),
  });
}

async function get(tok: string, path: string): Promise<Response> {
  return app.request(path, { headers: { authorization: `Bearer ${tok}` } });
}

describe('mcp connector submissions', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('submit: org toggle off (explicit) → 403 submission_disabled, nothing written', async () => {
    await seedOrgs();
    // The default is now TRUE (members may submit); turn it off to pin the gate.
    await testPool.query('UPDATE orgs SET members_can_submit_connectors = FALSE WHERE id = $1', ['o1']);
    const tok = await memberTok();
    const res = await submit(tok, submissionBody());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'submission_disabled' });
    const r = await testPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM mcp_connector_submissions',
    );
    expect(r.rows[0].n).toBe(0);
  });

  test('submit: toggle on → 201 {id}; row is pending with author/name/desc/version/cfg; submit audit', async () => {
    await seedOrgs();
    await enableSubmissions('o1');
    const tok = await memberTok();

    const res = await submit(tok, submissionBody({ description: 'jira connector' }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id.length).toBeGreaterThan(0);

    const row = await testPool.query<{
      status: string; author_id: string; name: string; desc: string | null;
      version: string; cfg: Record<string, unknown>;
    }>(
      `SELECT status, author_id, name, "desc", version, cfg FROM mcp_connector_submissions WHERE id = $1`,
      [id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].status).toBe('pending');
    expect(row.rows[0].author_id).toBe('author');
    expect(row.rows[0].name).toBe('Jira 连接器'); // zh preferred, then en, then serverKey
    expect(row.rows[0].desc).toBe('jira connector');
    expect(row.rows[0].version).toBe('1.0.0');
    expect(row.rows[0].cfg.serverKey).toBe('jira-mcp');
    // The cfg is stored exactly as submitted — no encryption at submit time.
    expect(row.rows[0].cfg.authConfig).toEqual({ apiKey: PLAINTEXT_KEY });

    const audit = await testPool.query<{ user_id: string | null; target_id: string | null }>(
      `SELECT user_id, target_id FROM audit_events
       WHERE action = 'mcp_submission_submit' AND target_type = 'submission'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].target_id).toBe(id);
    expect(audit.rows[0].user_id).toBe('author');
  });

  test('submit: same guards as the create route (sse+oauth, missing secret, bad serverKey); nothing written', async () => {
    await seedOrgs();
    await enableSubmissions('o1');
    const tok = await memberTok();

    const sse = await submit(tok, submissionBody({
      serverKey: 'sse-cc',
      transport: 'sse',
      authMode: 'client-creds',
      authConfig: { clientId: 'cid', clientSecret: 'cs' },
    }));
    expect(sse.status).toBe(400);
    expect(await sse.json()).toEqual({ error: 'sse_oauth_not_supported' });

    const missing = await submit(tok, submissionBody({ authConfig: {} }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'missing_auth_field', field: 'apiKey' });

    const badKey = await submit(tok, submissionBody({ serverKey: 'Bad_Key' }));
    expect(badKey.status).toBe(400);
    expect(((await badKey.json()) as { error?: string }).error).toBe('invalid_body');

    const r = await testPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM mcp_connector_submissions',
    );
    expect(r.rows[0].n).toBe(0);
  });

  test('approve: builds the connector (admin list, masked secret), a current versions row, submission approved; audits', async () => {
    await seedOrgs();
    await enableSubmissions('o1');
    const member = await memberTok();
    const admin = await superAdminTok('o1');
    const { id } = (await (await submit(member, submissionBody())).json()) as { id: string };

    const approve = await post(admin, `/admin/mcp-connectors/submissions/${id}/approve`);
    expect(approve.status).toBe(200);
    const { id: connectorId } = (await approve.json()) as { ok: boolean; id: string };
    expect(connectorId.length).toBeGreaterThan(0);

    // The connector is live in the admin list and the secret is masked.
    const list = (await (await get(admin, '/admin/mcp-connectors?orgId=o1')).json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(connectorId);
    expect(list[0].serverKey).toBe('jira-mcp');
    expect(JSON.stringify(list)).not.toContain(PLAINTEXT_KEY);
    expect((list[0].authConfig as Record<string, unknown>).apiKey).toBe('••••1234');

    // The version snapshot: current:true, note, non-null config.
    const ver = await testPool.query<{ version: string; note: string; current: boolean; config: Record<string, unknown> }>(
      `SELECT version, note, current, config FROM mcp_connector_versions WHERE connector_id = $1`,
      [connectorId],
    );
    expect(ver.rowCount).toBe(1);
    expect(ver.rows[0].version).toBe('1.0.0');
    expect(ver.rows[0].note).toBe('审核通过发布');
    expect(ver.rows[0].current).toBe(true);
    expect(ver.rows[0].config.serverKey).toBe('jira-mcp');
    // The snapshot's authConfig is stored ENCRYPTED (mirrors the live row and
    // the publish path) — no plaintext secret may persist in the versions
    // table, or a pg_dump would leak a live org credential.
    const snapshotAuth = ver.rows[0].config.authConfig as Record<string, unknown>;
    expect(typeof snapshotAuth['__enc__apiKey']).toBe('string');
    expect(snapshotAuth).not.toHaveProperty('apiKey');
    expect(JSON.stringify(ver.rows[0].config)).not.toContain(PLAINTEXT_KEY);

    // The submission is approved and linked to the new connector.
    const sub = await testPool.query<{ status: string; approved_connector_id: string | null }>(
      `SELECT status, approved_connector_id FROM mcp_connector_submissions WHERE id = $1`,
      [id],
    );
    expect(sub.rows[0].status).toBe('approved');
    expect(sub.rows[0].approved_connector_id).toBe(connectorId);

    // Both audit rows: the submission decision + the underlying create.
    const appr = await testPool.query<{ payload: unknown; user_id: string | null }>(
      `SELECT payload, user_id FROM audit_events
       WHERE action = 'mcp_submission_approve' AND target_id = $1`,
      [id],
    );
    expect(appr.rowCount).toBe(1);
    expect(appr.rows[0].user_id).toBe('admin');
    expect((appr.rows[0].payload as Record<string, unknown>).connectorId).toBe(connectorId);
    const created = await testPool.query<{ target_id: string | null }>(
      `SELECT target_id FROM audit_events WHERE action = 'mcp_connector_create'`,
    );
    expect(created.rows).toEqual([{ target_id: connectorId }]);
  });

  test('approve: a colliding server_key is suffixed -2', async () => {
    await seedOrgs();
    await enableSubmissions('o1');
    const member = await memberTok();
    const admin = await superAdminTok('o1');

    // Pre-occupy jira-mcp via the admin create route.
    const create = (body: Record<string, unknown>) =>
      app.request('/admin/mcp-connectors', {
        method: 'POST',
        headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: 'o1', ...body }),
      });
    expect((await create(submissionBody())).status).toBe(201);

    const { id } = (await (await submit(member, submissionBody())).json()) as { id: string };
    const approve = await post(admin, `/admin/mcp-connectors/submissions/${id}/approve`);
    expect(approve.status).toBe(200);
    const connectorId = ((await approve.json()) as { id: string }).id;

    const r = await testPool.query<{ server_key: string }>(
      'SELECT server_key FROM mcp_connectors WHERE id = $1',
      [connectorId],
    );
    expect(r.rows[0].server_key).toBe('jira-mcp-2');
  });

  test('approve: the suffix loops past an already-taken -2 to -3', async () => {
    await seedOrgs();
    await enableSubmissions('o1');
    const member = await memberTok();
    const admin = await superAdminTok('o1');

    const create = (body: Record<string, unknown>) =>
      app.request('/admin/mcp-connectors', {
        method: 'POST',
        headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: 'o1', ...body }),
      });
    expect((await create(submissionBody())).status).toBe(201);
    expect((await create(submissionBody({ serverKey: 'jira-mcp-2', url: 'https://b.example.com' }))).status).toBe(201);

    const { id } = (await (await submit(member, submissionBody())).json()) as { id: string };
    const approve = await post(admin, `/admin/mcp-connectors/submissions/${id}/approve`);
    expect(approve.status).toBe(200);
    const connectorId = ((await approve.json()) as { id: string }).id;

    const r = await testPool.query<{ server_key: string }>(
      'SELECT server_key FROM mcp_connectors WHERE id = $1',
      [connectorId],
    );
    expect(r.rows[0].server_key).toBe('jira-mcp-3');
  });

  test('reject: no reason → 400 reason_required; with reason → rejected + reason stored + audit; then approve 409', async () => {
    await seedOrgs();
    await enableSubmissions('o1');
    const member = await memberTok();
    const admin = await superAdminTok('o1');
    const { id } = (await (await submit(member, submissionBody())).json()) as { id: string };

    const noReason = await post(admin, `/admin/mcp-connectors/submissions/${id}/reject`, JSON.stringify({}));
    expect(noReason.status).toBe(400);
    expect(await noReason.json()).toEqual({ error: 'reason_required' });

    const ok = await post(admin, `/admin/mcp-connectors/submissions/${id}/reject`, JSON.stringify({ reason: 'URL 无法访问' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });

    const row = await testPool.query<{ status: string; reject_reason: string | null }>(
      `SELECT status, reject_reason FROM mcp_connector_submissions WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe('rejected');
    expect(row.rows[0].reject_reason).toBe('URL 无法访问');

    const audit = await testPool.query<{ payload: unknown }>(
      `SELECT payload FROM audit_events WHERE action = 'mcp_submission_reject' AND target_id = $1`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
    expect((audit.rows[0].payload as Record<string, unknown>).reason).toBe('URL 无法访问');

    // A decided submission cannot be approved afterwards.
    const approve = await post(admin, `/admin/mcp-connectors/submissions/${id}/approve`);
    expect(approve.status).toBe(409);
    expect(await approve.json()).toEqual({ error: 'not_pending' });
  });

  test('withdraw: non-author (incl. admin) → 403; author → withdrawn; then withdraw 409', async () => {
    await seedOrgs();
    await enableSubmissions('o1');
    const author = await memberTok('author');
    const other = await memberTok('other');
    const admin = await superAdminTok('o1');
    const { id } = (await (await submit(author, submissionBody())).json()) as { id: string };

    const byAdmin = await post(admin, `/admin/mcp-connectors/submissions/${id}/withdraw`);
    expect(byAdmin.status).toBe(403);
    const byOther = await post(other, `/admin/mcp-connectors/submissions/${id}/withdraw`);
    expect(byOther.status).toBe(403);

    const byAuthor = await post(author, `/admin/mcp-connectors/submissions/${id}/withdraw`);
    expect(byAuthor.status).toBe(200);
    expect(await byAuthor.json()).toEqual({ ok: true });

    const row = await testPool.query<{ status: string }>(
      `SELECT status FROM mcp_connector_submissions WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe('withdrawn');

    const audit = await testPool.query<{ user_id: string | null }>(
      `SELECT user_id FROM audit_events WHERE action = 'mcp_submission_withdraw' AND target_id = $1`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].user_id).toBe('author');

    const again = await post(author, `/admin/mcp-connectors/submissions/${id}/withdraw`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'not_pending' });
  });

  test('list: camelCase wire rows + org-wide counts; ordered submitted_at DESC; ?status= filters rows but not counts', async () => {
    await seedOrgs();
    await enableSubmissions('o1');
    const author = await memberTok('author');
    const member2 = await memberTok('other');
    const admin = await superAdminTok('o1');

    const s1 = (await (await submit(author, submissionBody({ serverKey: 'alpha' }))).json()) as { id: string };
    const s2 = (await (await submit(author, submissionBody({ serverKey: 'beta' }))).json()) as { id: string };
    const s3 = (await (await submit(member2, submissionBody({ serverKey: 'gamma' }))).json()) as { id: string };

    // Decide two of them: s2 rejected, s3 withdrawn.
    expect((await post(admin, `/admin/mcp-connectors/submissions/${s2.id}/reject`, JSON.stringify({ reason: 'no' }))).status).toBe(200);
    expect((await post(member2, `/admin/mcp-connectors/submissions/${s3.id}/withdraw`)).status).toBe(200);

    // Stagger the timestamps so the DESC ordering is deterministic.
    await testPool.query(`UPDATE mcp_connector_submissions SET submitted_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [s1.id]);
    await testPool.query(`UPDATE mcp_connector_submissions SET submitted_at = '2026-01-02T00:00:00Z' WHERE id = $1`, [s2.id]);
    await testPool.query(`UPDATE mcp_connector_submissions SET submitted_at = '2026-01-03T00:00:00Z' WHERE id = $1`, [s3.id]);

    const res = await get(admin, '/admin/mcp-connectors/submissions?orgId=o1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      submissions: Array<Record<string, unknown>>;
      counts: Record<string, number>;
    };
    expect(body.counts).toEqual({ pending: 1, approved: 0, rejected: 1, withdrawn: 1 });
    expect(body.submissions.map((s) => s.id)).toEqual([s3.id, s2.id, s1.id]); // newest first

    const row = body.submissions.find((s) => s.id === s1.id) as Record<string, unknown>;
    expect(row.name).toBe('Jira 连接器');
    expect(row.desc).toBe(null);
    expect(row.authorId).toBe('author');
    expect(row.version).toBe('1.0.0');
    expect(row.status).toBe('pending');
    expect(row.rejectReason).toBe(null);
    expect(row.approvedConnectorId).toBe(null);
    expect(typeof row.submittedAt).toBe('string');
    expect(new Date(row.submittedAt as string).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(row.cfg).toEqual(expect.objectContaining({ serverKey: 'alpha' }));

    // ?status=pending filters the rows; the counts stay org-wide.
    const filtered = (await (await get(admin, '/admin/mcp-connectors/submissions?orgId=o1&status=pending')).json()) as {
      submissions: Array<Record<string, unknown>>;
      counts: Record<string, number>;
    };
    expect(filtered.submissions).toHaveLength(1);
    expect(filtered.submissions[0].id).toBe(s1.id);
    expect(filtered.counts).toEqual({ pending: 1, approved: 0, rejected: 1, withdrawn: 1 });
  });

  test('cross-org: o2 admin gets 404 on o1 submission ids, 400 org_mismatch listing o1; o2 queue is empty; o1 row untouched', async () => {
    await seedOrgs();
    await enableSubmissions('o1');
    const author = await memberTok('author');
    const o1Admin = await superAdminTok('o1');
    const o2Admin = await superAdminTok('o2');
    const { id } = (await (await submit(author, submissionBody())).json()) as { id: string };

    const list = await get(o2Admin, '/admin/mcp-connectors/submissions?orgId=o1');
    expect(list.status).toBe(400);
    expect(await list.json()).toEqual({ error: 'org_mismatch' });

    for (const action of ['approve', 'reject', 'withdraw'] as const) {
      const res = await post(
        o2Admin,
        `/admin/mcp-connectors/submissions/${id}/${action}`,
        action === 'reject' ? JSON.stringify({ reason: 'x' }) : undefined,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }

    const o2List = (await (await get(o2Admin, '/admin/mcp-connectors/submissions?orgId=o2')).json()) as {
      submissions: unknown[];
      counts: Record<string, number>;
    };
    expect(o2List.submissions).toHaveLength(0);
    expect(o2List.counts).toEqual({ pending: 0, approved: 0, rejected: 0, withdrawn: 0 });

    const still = await testPool.query<{ status: string }>(
      `SELECT status FROM mcp_connector_submissions WHERE id = $1`,
      [id],
    );
    expect(still.rows[0].status).toBe('pending');
    // The o1 admin can still see it.
    const o1List = (await (await get(o1Admin, '/admin/mcp-connectors/submissions?orgId=o1')).json()) as {
      submissions: Array<{ id: string }>;
    };
    expect(o1List.submissions).toHaveLength(1);
    expect(o1List.submissions[0].id).toBe(id);
  });

  test('authz: a plain member (no mcp:* points) 403s on list/approve/reject; no token → 401', async () => {
    await seedOrgs();
    await enableSubmissions('o1');
    const member = await memberTok();
    const { id } = (await (await submit(member, submissionBody())).json()) as { id: string };

    const list = await get(member, '/admin/mcp-connectors/submissions?orgId=o1');
    expect(list.status).toBe(403);

    const approve = await post(member, `/admin/mcp-connectors/submissions/${id}/approve`);
    expect(approve.status).toBe(403);

    const reject = await post(member, `/admin/mcp-connectors/submissions/${id}/reject`, JSON.stringify({ reason: 'x' }));
    expect(reject.status).toBe(403);

    const anon = await app.request('/admin/mcp-connectors/submissions?orgId=o1');
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: 'unauthorized' });
  });
});
