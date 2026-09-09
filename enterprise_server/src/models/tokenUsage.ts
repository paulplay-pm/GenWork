import { pool } from '../db/pool';
import { timezone } from '../org/timezone';

export interface TokenUsageRow {
  id: string;
  org_id: string;
  user_id: string;
  model_id: string;
  provider: string;
  token_in: number;
  token_out: number;
  total_tokens: number;
  cost_usd: string | null;
  duration_ms: number | null;
  result_code: number;
  quota_window_date: string;
  ts: Date;
}

export const tokenUsage = {
  async write(input: {
    orgId: string;
    userId: string;
    modelId: string;
    provider: string;
    tokenIn: number;
    tokenOut: number;
    resultCode: number;
    durationMs?: number;
    costUsd?: number;
  }): Promise<void> {
    const windowDate = await timezone.quotaWindowDate(input.userId, new Date());
    const total = input.tokenIn + input.tokenOut;
    await pool.query(
      `INSERT INTO token_usage(org_id, user_id, model_id, provider, token_in, token_out, total_tokens, cost_usd, duration_ms, result_code, quota_window_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.orgId,
        input.userId,
        input.modelId,
        input.provider,
        input.tokenIn,
        input.tokenOut,
        total,
        input.costUsd ?? null,
        input.durationMs ?? null,
        input.resultCode,
        windowDate,
      ]
    );
  },

  async usageInWindow(userId: string, modelId: string, windowDate: string): Promise<number> {
    const r = await pool.query<{ s: string }>(
      `SELECT COALESCE(SUM(total_tokens),0)::text AS s FROM token_usage
       WHERE user_id=$1 AND model_id=$2 AND quota_window_date=$3`,
      [userId, modelId, windowDate]
    );
    return Number(r.rows[0].s);
  },

  async today(userId: string): Promise<{ window_date: string; items: { model_id: string; used: number }[] }> {
    const windowDate = await timezone.quotaWindowDate(userId, new Date());
    const r = await pool.query<{ model_id: string; used: number }>(
      `SELECT model_id, SUM(total_tokens)::int AS used
       FROM token_usage WHERE user_id=$1 AND quota_window_date=$2 GROUP BY model_id`,
      [userId, windowDate]
    );
    return { window_date: windowDate, items: r.rows };
  },
};