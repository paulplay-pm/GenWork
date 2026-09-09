// enterprise_server/src/sso/state.ts
import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool';
import { STATE_TTL_MS, type SsoStateRow } from './types';

export interface CreateStateInput {
  orgId: string;
  connectionId: string;
  returnTarget: 'console' | 'desktop' | 'web';
  codeVerifier?: string;
  redirectUri?: string;
}

/** camelCase (JS/wire) view of a consumed one-shot login state. */
export interface SsoConsumedState {
  state: string;
  orgId: string;
  connectionId: string;
  returnTarget: 'console' | 'desktop' | 'web';
  codeVerifier: string | null;
  redirectUri: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export async function createState(
  input: CreateStateInput,
): Promise<{ state: string; codeVerifier: string | null }> {
  const state = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sso_login_states(state, org_id, sso_connection_id, return_target, code_verifier, redirect_uri, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' milliseconds')::interval)`,
    [state, input.orgId, input.connectionId, input.returnTarget,
     input.codeVerifier ?? null, input.redirectUri ?? null, STATE_TTL_MS]
  );
  return { state, codeVerifier: input.codeVerifier ?? null };
}

export async function consumeState(state: string): Promise<SsoConsumedState | null> {
  // One-shot: DELETE … RETURNING. Returns null if missing/expired.
  const r = await pool.query<SsoStateRow>(
    `DELETE FROM sso_login_states
     WHERE state = $1 AND expires_at > now()
     RETURNING state, org_id, sso_connection_id, return_target, code_verifier, redirect_uri, created_at, expires_at`,
    [state]
  );
  if (!r.rowCount || r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    state: row.state,
    orgId: row.org_id,
    connectionId: row.sso_connection_id,
    returnTarget: row.return_target,
    codeVerifier: row.code_verifier,
    redirectUri: row.redirect_uri,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

// Best-effort sweeper; safe to invoke from any request path.
export async function pruneExpiredStates(): Promise<void> {
  await pool.query(`DELETE FROM sso_login_states WHERE expires_at <= now()`);
}
