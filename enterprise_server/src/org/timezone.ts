import { pool } from '../db/pool';
import { formatInTimeZone } from 'date-fns-tz';

export const timezone = {
  resolveZone(zone: string): string {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return zone;
    } catch {
      throw new Error(`invalid IANA timezone: ${zone}`);
    }
  },

  async quotaWindowDate(userId: string, ts: Date): Promise<string> {
    const r = await pool.query<{ ut: string | null; ot: string }>(
      `SELECT u.timezone AS ut, o.timezone AS ot
       FROM users u JOIN orgs o ON o.id = u.org_id
       WHERE u.id = $1`,
      [userId]
    );
    if (r.rowCount === 0) throw new Error('user not found');
    const zone = this.resolveZone(r.rows[0].ut ?? r.rows[0].ot ?? 'UTC');
    return formatInTimeZone(ts, zone, 'yyyy-MM-dd');
  },
};