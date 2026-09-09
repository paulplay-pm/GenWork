// enterprise_server/src/sso/finishCallback.ts
// The security-critical core of SSO member-login federation:
//   code exchange (PKCE) → identity resolution → JIT user resolve → JWT → audit.
// `SsoConsumedState` is the camelCase view returned by consumeState (state.ts).
import { randomUUID } from 'node:crypto';

import { auditStore } from '../audit/auditStore';
import { signToken } from '../auth/jwt';
import { pool } from '../db/pool';
import { loginRecord } from '../org/loginRecord';
import { Role } from '../shared/enterpriseServerConstants';
import { decryptClientSecret } from '../vault/ssoSecret';
import {
  DomainNotAllowedError,
  EmailRequiredError,
  resolveUser,
  UserDisabledError,
  UsernameConflictError,
} from './jit';
import { exchangeCode, fetchUserInfo, verifyIdToken } from './oauth';
import { type SsoLoginContext,ssoLoginContextStore } from './ssoLoginContext';
import type { SsoConsumedState } from './state';
import { type SsoConnectionRow,STATE_TTL_MS } from './types';

export interface FinishArgs { code: string; state: SsoConsumedState; redirectUri: string; }
export type FinishResult =
  | { token: string }
  | { error: string }
  | { pendingBind: { connectionName: string; providerType: string; externalId: string } }
  // Self-binding success on the web surface: callers (e.g. the dedicated
  // /auth/sso/bind-callback route) need the resolved connectionId and the
  // IdP-issued externalId alongside the token so they can render the
  // post-bind landing page without re-querying the DB. Other surfaces
  // (console, desktop) keep the legacy { token } shape.
  | { kind: 'web_self_binding_success'; token: string; userId: string; orgId: string; connectionId: string; externalId: string };

export async function finishSsoCallback(args: FinishArgs): Promise<FinishResult> {
  const { code, state, redirectUri } = args;

  // Reload the full connection row, scoped by org (state carries only ids).
  const r = await pool.query<SsoConnectionRow>(
    `SELECT ${COLS} FROM sso_connections WHERE id = $1 AND org_id = $2`,
    [state.connectionId, state.orgId]
  );
  const conn = r.rows[0];
  if (!conn) return { error: 'unknown_connection' };

  let clientSecret: string | null = null;
  if (conn.client_secret_encrypted) clientSecret = decryptClientSecret(conn.client_secret_encrypted);

  let identity: Record<string, unknown>;
  let fromIdToken = false;
  try {
    const exchanged = await exchangeCode(
      conn, code, state.codeVerifier ?? undefined, clientSecret ?? undefined, redirectUri,
    );
    if (conn.protocol === 'oidc' && exchanged.idToken && clientSecret) {
      // v1: HS256 ID tokens verified with the IdP-shared client_secret.
      // R14: verifyIdToken is async — it MUST be awaited (an un-awaited call
      // would leave `identity` as a Promise and every ID-token login would
      // fail with `missing_external_id`). Gating on `clientSecret` keeps
      // public PKCE clients (no secret) and pure-OAuth2 connections on the
      // userinfo path, where verifyIdToken would otherwise throw.
      const payload = await verifyIdToken(conn, exchanged.idToken, clientSecret);
      identity = payload as unknown as Record<string, unknown>;
      fromIdToken = true;
    } else {
      identity = await fetchUserInfo(conn, exchanged.accessToken);
    }
  } catch (e) {
    await auditStore.write({
      orgId: state.orgId, action: 'sso_login_failed',
      payload: { ssoConnectionId: state.connectionId, reason: (e as Error).message },
    });
    await recordFailedLogin(state.orgId);
    return { error: 'token_exchange_failed' };
  }

  // R13a: aud check, conditional on the IdP including `aud`. When present it
  // must equal (string) or contain (array) this connection's client_id — a
  // token issued for a different client is a replay/forge and must be
  // rejected. IdPs that omit aud are unaffected. Lives here (not in oauth.ts)
  // because the expected client_id is connection-scoped.
  if (fromIdToken) {
    const aud = identity.aud;
    if (aud !== undefined && aud !== null) {
      const audMatches = typeof aud === 'string'
        ? aud === conn.client_id
        : Array.isArray(aud) && aud.includes(conn.client_id ?? '');
      if (!audMatches) {
        await auditStore.write({
          orgId: state.orgId, action: 'sso_login_failed',
          payload: { ssoConnectionId: state.connectionId, reason: 'id_token_aud_mismatch' },
        });
        await recordFailedLogin(state.orgId);
        return { error: 'id_token_aud_mismatch' };
      }
    }
  }

  const externalId = String(identity[conn.identity_id_field] ?? '');
  const email = conn.email_field && identity[conn.email_field]
    ? String(identity[conn.email_field]) : null;
  const loginName = conn.login_name_field && identity[conn.login_name_field]
    ? String(identity[conn.login_name_field]) : null;
  if (!externalId) {
    await auditStore.write({
      orgId: state.orgId, action: 'sso_login_failed',
      payload: { ssoConnectionId: state.connectionId, reason: 'missing_external_id' },
    });
    await recordFailedLogin(state.orgId);
    return { error: 'missing_external_id' };
  }

  // §4.3 self_binding branch. Runs BEFORE the strict-mode gate: when the
  // user is already authenticated and re-binding from /me/sso-binding/start,
  // the in-memory store carries { kind: 'self_binding', userId } and we must
  // write users.sso_(connection,external) for that userId — NOT fall through
  // to resolveUser (which would JIT-provision a brand-new user keyed on the
  // IdP's externalId, completely separate from the logged-in user).
  const sbCtx = ssoLoginContextStore.get(state.state);
  if (sbCtx?.kind === 'self_binding') {
    // Look up the user once so we can both check status and read extra_roles
    // for the JWT (resolves parked Ruling 6 from T4 — a user with
    // extra_roles=['org_admin'] who re-binds keeps that role, instead of
    // being downgraded to [Role.User] as the T4 finalizer hardcoded).
    const u = await pool.query<{ id: string; status: string; org_id: string; extra_roles: string[] | null }>(
      `SELECT id, status, org_id, extra_roles FROM users WHERE id = $1`,
      [sbCtx.userId]
    );
    const userRow = u.rows[0];
    if (!userRow || userRow.org_id !== sbCtx.orgId) {
      ssoLoginContextStore.delete(state.state);
      return { error: 'bind_org_mismatch' };
    }
    if (userRow.status !== 'active') {
      await auditStore.write({
        orgId: state.orgId, action: 'sso_user_self_bound_denied',
        payload: { userId: sbCtx.userId, reason: 'user_disabled', ssoConnectionId: state.connectionId },
      });
      ssoLoginContextStore.delete(state.state);
      return { error: 'user_disabled' };
    }
    // Pre-check: externalId already bound to a DIFFERENT user. The
    // users_sso_binding_uniq index would catch this too (23505 on the
    // UPDATE below), but pre-checking returns a friendlier, more specific
    // error code and avoids any state churn on the row the index would
    // have failed to update (so the other user's binding stays intact and
    // u-current is NOT touched — a deliberate non-regression of the
    // "don't touch anyone's data on a denied bind" invariant).
    const dupCheck = await pool.query<{ id: string }>(
      `SELECT id FROM users
        WHERE org_id = $1 AND sso_connection_id = $2
          AND sso_external_id = $3 AND id <> $4`,
      [sbCtx.orgId, sbCtx.connectionId, externalId, sbCtx.userId],
    );
    if (dupCheck.rowCount) {
      await auditStore.write({
        orgId: sbCtx.orgId, userId: sbCtx.userId, action: 'sso_user_self_bound_denied',
        payload: { reason: 'external_id_bound_to_other_user', ssoConnectionId: sbCtx.connectionId, externalId },
      });
      ssoLoginContextStore.delete(state.state);
      return { error: 'bind_external_id_exists' };
    }
    // UPSERT the binding. ON CONFLICT on the (sso_connection_id, sso_external_id)
    // partial-unique index → 23505 → sso_binding_duplicate (spec §4.2.B).
    try {
      await pool.query(
        `UPDATE users
            SET sso_connection_id = $1, sso_external_id = $2
          WHERE id = $3 AND org_id = $4`,
        [sbCtx.connectionId, externalId, sbCtx.userId, sbCtx.orgId]
      );
    } catch (e: unknown) {
      if ((e as { code?: string }).code === '23505') {
        await auditStore.write({
          orgId: state.orgId, userId: sbCtx.userId, action: 'sso_user_self_bound_denied',
          payload: { reason: 'sso_binding_duplicate_race', ssoConnectionId: state.connectionId, externalId },
        });
        ssoLoginContextStore.delete(state.state);
        return { error: 'sso_binding_duplicate' };
      }
      throw e;
    }
    await pool.query(
      `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [randomUUID(), sbCtx.orgId, sbCtx.userId, sbCtx.connectionId, externalId]
    );
    const roles = userRow.extra_roles ?? [Role.User];
    const token = await signToken({ sub: sbCtx.userId, orgId: sbCtx.orgId, roles });
    // Clear the parked entry so a second callback hit doesn't redo the bind
    // (the sso_login_states row is already gone — consumeState is one-shot).
    ssoLoginContextStore.delete(state.state);
    await auditStore.write({
      orgId: sbCtx.orgId, userId: sbCtx.userId, action: 'sso_user_self_bound',
      payload: { ssoConnectionId: sbCtx.connectionId, externalId, source: 'self_binding' },
    });
    if (sbCtx.returnTarget === 'web') {
      return {
        kind: 'web_self_binding_success',
        token, userId: sbCtx.userId, orgId: sbCtx.orgId,
        connectionId: sbCtx.connectionId, externalId,
      };
    }
    return { token };
  }

  // 0. Strict-mode gate. Lives here, NOT in resolveUser — when
  // require_prebinding is true, we look up users.sso_(connection,external)
  // directly and bypass resolveUser (so email_domain_whitelist / JIT do
  // not run for the strict-mode path).
  if (conn.require_prebinding) {
    const bound = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users
        WHERE org_id = $1 AND sso_connection_id = $2 AND sso_external_id = $3`,
      [state.orgId, state.connectionId, externalId],
    );
    if (bound.rowCount) {
      if (bound.rows[0]!.status !== 'active') {
        await auditStore.write({
          orgId: state.orgId, action: 'sso_login_failed',
          payload: { ssoConnectionId: state.connectionId, reason: 'user_disabled' },
        });
        await recordFailedLogin(state.orgId);
        return { error: 'user_disabled' };
      }
      const uid = bound.rows[0]!.id;
      await pool.query(
        `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [randomUUID(), state.orgId, uid, state.connectionId, externalId],
      );
      const roleRes = await pool.query<{ extra_roles: string[] | null }>(
        `SELECT extra_roles FROM users WHERE id = $1`, [uid]
      );
      const roles = roleRes.rows[0]?.extra_roles ?? [Role.User];
      const token = await signToken({ sub: uid, orgId: state.orgId, roles });
      try { await loginRecord.recordLogin(state.orgId, uid, null, null, 'success'); } catch { /* best-effort */ }
      await auditStore.write({
        orgId: state.orgId, userId: uid, action: 'sso_login_succeeded',
        payload: { ssoConnectionId: state.connectionId, externalId, createdJit: false },
      });
      return { token };
    }
    // Unbound + strict mode → two-stage. Park the state so /bind-sso can
    // verify the password and resume. We do NOT call resolveUser here.
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    const ctx: SsoLoginContext = {
      kind: 'pending_bind',
      orgId: state.orgId, connectionId: state.connectionId,
      externalId, email, loginName,
      returnTarget: state.returnTarget,
      redirectUri: state.redirectUri, codeVerifier: state.codeVerifier,
      expiresAt,
    };
    ssoLoginContextStore.set(state.state, ctx);
    await auditStore.write({
      orgId: state.orgId, action: 'sso_login_failed',
      payload: { ssoConnectionId: state.connectionId, reason: 'sso_login_pending_bind', externalId },
    });
    return { pendingBind: { connectionName: conn.name, providerType: conn.provider_type, externalId } };
  }

  let userId: string;
  let createdJit = false;
  try {
    const resolved = await resolveUser({
      orgId: state.orgId, connectionId: state.connectionId, externalId, email, loginName,
    });
    userId = resolved.userId;
    createdJit = resolved.createdJit;
  } catch (e) {
    const errorCode = e instanceof DomainNotAllowedError ? 'domain_not_allowed'
      : e instanceof EmailRequiredError ? 'email_required'
      : e instanceof UsernameConflictError ? 'username_conflict'
      : e instanceof UserDisabledError ? 'user_disabled'
      : 'jit_failed';
    await auditStore.write({
      orgId: state.orgId, action: 'sso_login_failed',
      payload: { ssoConnectionId: state.connectionId, reason: errorCode },
    });
    await recordFailedLogin(state.orgId);
    return { error: errorCode };
  }

  // Same JWT shape as a password login: roles come from the user's
  // extra_roles (falling back to [Role.User] when unset), so a JIT member
  // promoted to another role (e.g. org_admin) exercises it through SSO too.
  const roleRes = await pool.query<{ extra_roles: string[] | null }>(
    `SELECT extra_roles FROM users WHERE id = $1 AND org_id = $2`, [userId, state.orgId]
  );
  const roles = roleRes.rows[0]?.extra_roles ?? [Role.User];
  const token = await signToken({ sub: userId, orgId: state.orgId, roles });

  try {
    await loginRecord.recordLogin(state.orgId, userId, null, null, 'success');
  } catch { /* best-effort */ }
  await auditStore.write({
    orgId: state.orgId, userId, action: 'sso_login_succeeded',
    payload: { ssoConnectionId: state.connectionId, externalId, createdJit },
  });
  if (createdJit) {
    await auditStore.write({
      orgId: state.orgId, userId, action: 'sso_jit_provisioned',
      payload: { ssoConnectionId: state.connectionId, externalId },
    });
  }

  return { token };
}

// Best-effort failed-attempt record (loginRecord's contract: every attempt
// appends a login_events row; no user is known on failure).
async function recordFailedLogin(orgId: string): Promise<void> {
  try {
    await loginRecord.recordLogin(orgId, null, null, null, 'failed');
  } catch { /* best-effort */ }
}

const COLS = `id, org_id, name, provider_type, protocol, authorize_url, token_url, userinfo_url, client_id, client_secret_encrypted, client_secret_masked, scopes, identity_id_field, login_name_field, email_field, email_domain_whitelist, require_prebinding, enabled, sort_order, created_by, created_at, updated_at`;
