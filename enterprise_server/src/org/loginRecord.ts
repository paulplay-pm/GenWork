import { pool } from '../db/pool';

/**
 * Login event recording (Task 7; wired into the real login flow in Task 10).
 * Every attempt — success or failure — appends a `login_events` row; only a
 * successful login refreshes `users.last_login_at/ip/device`.
 */
export const loginRecord = {
  async recordLogin(
    orgId: string,
    userId: string | null,
    ip: string | null,
    device: string | null,
    result: 'success' | 'failed',
  ): Promise<void> {
    await pool.query(
      `INSERT INTO login_events(id, org_id, user_id, ip, device, result) VALUES ($1,$2,$3,$4,$5,$6)`,
      [crypto.randomUUID(), orgId, userId, ip, device, result],
    );
    if (result === 'success' && userId) {
      await pool.query(
        `UPDATE users SET last_login_at=now(), last_login_ip=$2, last_login_device=$3 WHERE id=$1`,
        [userId, ip, device],
      );
    }
  },
};
