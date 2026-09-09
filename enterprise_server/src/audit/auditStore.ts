import { pool } from '../db/pool';
import type { TxClient } from '../db/testDb';

export interface AuditEventInput {
  orgId: string;
  userId?: string | null;
  targetUserId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  payload?: unknown;
  /** Optional transaction client so the audit row commits atomically with the
   * write it records. Defaults to the module pool (the common case). */
  tx?: TxClient;
}

export interface AuditEventRow {
  id: string;
  org_id: string;
  user_id: string | null;
  target_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: unknown;
  ts: Date;
}

export const auditStore = {
  async write(input: AuditEventInput): Promise<void> {
    const db = input.tx ?? pool;
    await db.query(
      `INSERT INTO audit_events(org_id,user_id,target_user_id,action,target_type,target_id,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.orgId,
        input.userId ?? null,
        input.targetUserId ?? null,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        input.payload === undefined ? null : JSON.stringify(input.payload),
      ]
    );
  },

  async query(input: {
    orgId: string;
    userId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<AuditEventRow[]> {
    const where: string[] = ['org_id=$1'];
    const params: unknown[] = [input.orgId];
    if (input.userId) {
      params.push(input.userId);
      where.push(`user_id=$${params.length}`);
    }
    if (input.from) {
      params.push(input.from);
      where.push(`ts>=$${params.length}`);
    }
    if (input.to) {
      params.push(input.to);
      where.push(`ts<=$${params.length}`);
    }
    params.push(input.limit ?? 100);
    const r = await pool.query<AuditEventRow>(
      `SELECT * FROM audit_events WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT $${params.length}`,
      params
    );
    return r.rows;
  },
};