// enterprise_server/src/sso/jit.ts
import { randomUUID } from 'node:crypto';

import { pool } from '../db/pool';
import { Role } from '../shared/enterpriseServerConstants';

export class DomainNotAllowedError extends Error { constructor() { super('domain_not_allowed'); this.name = 'DomainNotAllowedError'; } }
export class EmailRequiredError extends Error { constructor() { super('email_required'); this.name = 'EmailRequiredError'; } }
export class UsernameConflictError extends Error { constructor() { super('username_conflict'); this.name = 'UsernameConflictError'; } }
export class UserDisabledError extends Error { constructor() { super('user_disabled'); this.name = 'UserDisabledError'; } }

// A federated user must be `active` to resolve (2a/2b return points) — a
// disabled member must not get a valid JWT or a fresh binding row.
async function assertUserActive(userId: string, orgId: string): Promise<void> {
  const st = await pool.query<{ status: string }>(
    `SELECT status FROM users WHERE id = $1 AND org_id = $2`, [userId, orgId]
  );
  if (st.rows[0]?.status !== 'active') throw new UserDisabledError();
}

export interface ResolveUserInput {
  orgId: string;
  connectionId: string;
  externalId: string;
  email: string | null;
  loginName: string | null;
}

export interface ResolveUserResult { userId: string; createdJit: boolean; }

export async function resolveUser(input: ResolveUserInput): Promise<ResolveUserResult> {
  const { orgId, connectionId, externalId, email, loginName } = input;

  // 1. Email-domain gate.
  const connRes = await pool.query<{ email_domain_whitelist: string[] }>(
    `SELECT email_domain_whitelist FROM sso_connections WHERE id = $1 AND org_id = $2`,
    [connectionId, orgId]
  );
  const whitelist = connRes.rows[0]?.email_domain_whitelist ?? [];
  if (whitelist.length > 0) {
    if (!email) throw new EmailRequiredError();
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain || !whitelist.map((d) => d.toLowerCase()).includes(domain)) {
      throw new DomainNotAllowedError();
    }
  }
  // When no whitelist is set, an IdP that omits email (e.g. Feishu with
  // no `email` scope granted) is accepted as long as it returns an
  // external_id. Cross-IdP dedup (2b) and the username fallback below
  // both already gate on `if (email)` / `email?.`, so a null email flows
  // through to a JIT create bound solely by (connection, external_id).
  // Trade-off: the same human logging in via two different IdPs that
  // both omit email will get two distinct users.

  // 2a. Look up by (connection, external_id).
  const byIdp = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM user_idp_identities WHERE sso_connection_id = $1 AND external_id = $2`,
    [connectionId, externalId]
  );
  if (byIdp.rowCount) {
    const uid = byIdp.rows[0]!.user_id;
    await assertUserActive(uid, orgId);
    return { userId: uid, createdJit: false };
  }

  // 2b. Cross-IdP dedup by (org_id, email).
  if (email) {
    const byEmail = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE org_id = $1 AND email = $2`,
      [orgId, email]
    );
    if (byEmail.rowCount) {
      const userId = byEmail.rows[0]!.id;
      // A disabled user must not get a fresh binding row either.
      await assertUserActive(userId, orgId);
      await pool.query(
        `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [randomUUID(), orgId, userId, connectionId, externalId]
      );
      return { userId, createdJit: false };
    }
  }

  // 2c. JIT create.
  // `||` (not `??`): an IdP may return loginName as '' — that must fall
  // through to the email local-part (or a stable fallback) so the username
  // is never empty (two '' usernames would collide → permanent lockout).
  const ln = loginName?.trim();
  const username = (ln || email?.split('@')[0] || `sso-${externalId.slice(0, 8)}`).trim();
  const userId = randomUUID();
  try {
    await pool.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users(id, org_id, username, password_hash, display_name, email, extra_roles)
         VALUES ($1,$2,$3,'',$4,$5,$6)`,
        [userId, orgId, username, ln ?? username, email, JSON.stringify([Role.User])]
      );
      await tx.query(
        `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), orgId, userId, connectionId, externalId]
      );
    });
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code === '23505') throw new UsernameConflictError();
    throw e;
  }
  return { userId, createdJit: true };
}
