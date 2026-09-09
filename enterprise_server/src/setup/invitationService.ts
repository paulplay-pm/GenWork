import { createHash, randomBytes } from 'node:crypto';

import { hashPassword } from '../auth/password';
import { pool } from '../db/pool';
import { Role } from '../shared/enterpriseServerConstants';

const INVITE_TTL_MS = 6 * 60 * 60 * 1000;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function genCode(): string {
  const raw = randomBytes(24).toString('base64url').toUpperCase();
  return `GENWORK-SETUP-${raw.slice(0, 8)}-${raw.slice(8, 16)}-${raw.slice(16, 24)}`;
}

export class InvalidInvitation extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'InvalidInvitation';
  }
}

export const invitationService = {
  async create(orgId: string): Promise<{ id: string; code: string; expiresAt: Date }> {
    const id = crypto.randomUUID();
    const code = genCode();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await pool.query(
      `INSERT INTO init_invitations(id, org_id, code_hash, expires_at) VALUES ($1,$2,$3,$4)`,
      [id, orgId, hashCode(code), expiresAt]
    );
    return { id, code, expiresAt };
  },

  async redeem(
    code: string,
    input: { orgId: string; username: string; password: string }
  ): Promise<string> {
    const r = await pool.query<{
      id: string;
      status: string;
      expires_at: Date;
    }>(
      `SELECT id, status, expires_at FROM init_invitations
       WHERE org_id=$1 AND code_hash=$2`,
      [input.orgId, hashCode(code)]
    );
    const inv = r.rows[0];
    if (!inv) throw new InvalidInvitation('invalid invitation');
    if (inv.status === 'used') throw new InvalidInvitation('invitation already used');
    if (inv.status !== 'pending') throw new InvalidInvitation('invalid invitation status');
    if (inv.expires_at.getTime() < Date.now()) {
      throw new InvalidInvitation('invitation expired');
    }

    const userId = crypto.randomUUID();
    const roles = [Role.SuperAdmin];
    await pool.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users(id, org_id, username, password_hash, extra_roles)
         VALUES ($1,$2,$3,$4,$5)`,
        [userId, input.orgId, input.username, await hashPassword(input.password), JSON.stringify(roles)]
      );
      // Atomic setup-completion: marks the org as fully bootstrapped in the
      // same transaction as the user INSERT. The /api/setup/* middleware
      // closes the door on the next request. Guarded by `IS NULL` so a
      // re-redeem of a stale code (impossible per the used/expired checks
      // above, but defensive) cannot overwrite a real completion timestamp.
      await tx.query(
        `UPDATE orgs SET setup_completed_at = now()
         WHERE id = $1 AND setup_completed_at IS NULL`,
        [input.orgId]
      );
      await tx.query(
        `UPDATE init_invitations SET status='used', used_at=now(), used_by=$1 WHERE id=$2`,
        [userId, inv.id]
      );
    });
    return userId;
  },

  // 重新生成邀请码：把当前 pending 设为 expired，再创建新的
  async rotate(orgId: string): Promise<{ id: string; code: string; expiresAt: Date }> {
    // The unique index is (org_id, status), not just status='pending', so any
    // leftover `expired` rows from prior rotations would block the new INSERT
    // (and would block the UPDATE itself, since updating a row to a duplicate
    // (org_id, status) hits the index at end of statement). Drop them first.
    await pool.query(
      `DELETE FROM init_invitations WHERE org_id=$1 AND status IN ('pending','expired')`,
      [orgId]
    );
    return this.create(orgId);
  },
};