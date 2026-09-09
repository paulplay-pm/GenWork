import { pool } from '../db/pool';

export interface ArchiveMeta {
  id: string;
  org_id: string;
  user_id: string;
  size_bytes: number;
  archived_at: Date;
}

export const archiveService = {
  async store(orgId: string, userId: string, blob: Buffer): Promise<{ archiveId: string; size: number }> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO user_archives(id, org_id, user_id, archive_blob, size_bytes)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, orgId, userId, blob, blob.length]
    );
    return { archiveId: id, size: blob.length };
  },

  async list(orgId: string, userId?: string): Promise<ArchiveMeta[]> {
    const r = userId
      ? await pool.query<ArchiveMeta>(
          `SELECT id, org_id, user_id, size_bytes, archived_at
           FROM user_archives WHERE org_id=$1 AND user_id=$2 ORDER BY archived_at DESC`,
          [orgId, userId]
        )
      : await pool.query<ArchiveMeta>(
          `SELECT id, org_id, user_id, size_bytes, archived_at
           FROM user_archives WHERE org_id=$1 ORDER BY archived_at DESC`,
          [orgId]
        );
    return r.rows;
  },

  async getBlob(archiveId: string): Promise<Buffer> {
    const r = await pool.query<{ archive_blob: Uint8Array }>(
      `SELECT archive_blob FROM user_archives WHERE id=$1`,
      [archiveId]
    );
    if (r.rowCount === 0) throw new Error('archive not found');
    return Buffer.from(r.rows[0].archive_blob);
  },
};