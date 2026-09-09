import { pool } from '../db/pool';

export interface ReleaseChangelog {
  zh?: { title: string; content: string[] };
  en?: { title: string; content: string[] };
}

export interface ReleaseInstaller {
  id: string;
  fileName: string;
  fileSize: number;
  sha256: string;
}

export interface ReleaseInstallers {
  macArm?: ReleaseInstaller;
  windowsX64?: ReleaseInstaller;
}

export interface ReleaseView {
  id: string;
  version: string;
  published_at: string;
  change_log: ReleaseChangelog;
  installers: ReleaseInstallers;
  enabled: boolean;
  is_latest: boolean;
}

const SELECT_COLS = `id, version, published_at, change_log, installers, enabled, is_latest`;

export const appRelease = {
  async listForAdmin(orgId: string): Promise<ReleaseView[]> {
    const r = await pool.query<ReleaseView>(
      `SELECT ${SELECT_COLS} FROM app_releases
       WHERE org_id = $1
       ORDER BY published_at DESC, created_at DESC`,
      [orgId],
    );
    return r.rows;
  },

  async getLatestEnabled(orgId: string): Promise<ReleaseView | null> {
    const r = await pool.query<ReleaseView>(
      `SELECT ${SELECT_COLS} FROM app_releases
       WHERE org_id = $1 AND is_latest = true AND enabled = true
       LIMIT 1`,
      [orgId],
    );
    return r.rowCount === 0 ? null : r.rows[0];
  },

  async add(
    orgId: string,
    input: {
      version: string;
      published_at?: string;
      change_log: ReleaseChangelog;
      installers: ReleaseInstallers;
    },
  ): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO app_releases
         (id, org_id, version, published_at, change_log, installers)
       VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6)`,
      [
        id,
        orgId,
        input.version,
        input.published_at ?? null,
        JSON.stringify(input.change_log ?? {}),
        JSON.stringify(input.installers ?? {}),
      ],
    );
    return { id };
  },

  async update(
    id: string,
    patch: {
      change_log?: ReleaseChangelog;
      installers?: ReleaseInstallers;
      enabled?: boolean;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.change_log !== undefined) {
      sets.push(`change_log = $${i++}`);
      vals.push(JSON.stringify(patch.change_log));
    }
    if (patch.installers !== undefined) {
      sets.push(`installers = $${i++}`);
      vals.push(JSON.stringify(patch.installers));
    }
    if (patch.enabled !== undefined) {
      sets.push(`enabled = $${i++}`);
      vals.push(patch.enabled);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await pool.query(`UPDATE app_releases SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  },

  async setLatest(id: string): Promise<void> {
    await pool.query('BEGIN');
    try {
      const r = await pool.query<{ org_id: string; enabled: boolean; installers: ReleaseInstallers }>(
        `SELECT org_id, enabled, installers FROM app_releases WHERE id = $1`,
        [id],
      );
      if (r.rowCount === 0) throw new Error('not_found');
      const row = r.rows[0];
      if (!row.enabled) throw new Error('disabled');
      const hasInstaller = !!(row.installers.macArm || row.installers.windowsX64);
      if (!hasInstaller) throw new Error('no_installer');
      await pool.query(`UPDATE app_releases SET is_latest = false WHERE org_id = $1`, [row.org_id]);
      await pool.query(`UPDATE app_releases SET is_latest = true WHERE id = $1`, [id]);
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
  },

  /**
   * Resolve an installer fileId (the on-disk file name stem) to the release
   * that owns it, returning the owner org + file metadata. Null if no release
   * references the fileId. Used by the download route for the cross-org guard.
   */
  async getInstallerMeta(
    fileId: string,
  ): Promise<{ orgId: string; fileName: string; fileSize: number; sha256: string } | null> {
    const r = await pool.query<{ org_id: string; installers: ReleaseInstallers }>(
      `SELECT org_id, installers FROM app_releases
       WHERE installers->'macArm'->>'id' = $1
          OR installers->'windowsX64'->>'id' = $1
       LIMIT 1`,
      [fileId],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    // Both platforms can be present on a release; pick the one that actually
    // owns this fileId, not just the first present platform.
    const meta =
      row.installers.macArm?.id === fileId
        ? row.installers.macArm
        : row.installers.windowsX64?.id === fileId
          ? row.installers.windowsX64
          : null;
    if (!meta) return null;
    return { orgId: row.org_id, fileName: meta.fileName, fileSize: meta.fileSize, sha256: meta.sha256 };
  },

  async remove(id: string): Promise<void> {
    await pool.query(`DELETE FROM app_releases WHERE id = $1`, [id]);
  },
};
