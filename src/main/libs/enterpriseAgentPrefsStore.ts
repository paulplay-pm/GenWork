import type Database from 'better-sqlite3';

export class EnterpriseAgentPrefsStore {
  constructor(private readonly db: Database.Database) {}

  get(enterpriseAgentId: string): string {
    const row = this.db
      .prepare('SELECT working_directory AS wd FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?')
      .get(enterpriseAgentId) as { wd?: string } | undefined;
    return row?.wd ?? '';
  }

  upsert(enterpriseAgentId: string, workingDirectory: string): void {
    this.db.prepare(
      `INSERT INTO enterprise_agent_prefs (enterprise_agent_id, working_directory, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(enterprise_agent_id) DO UPDATE SET
         working_directory = excluded.working_directory,
         updated_at = excluded.updated_at`,
    ).run(enterpriseAgentId, workingDirectory, Date.now());
  }

  getModel(enterpriseAgentId: string): string {
    const row = this.db
      .prepare('SELECT model_ref AS mr FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?')
      .get(enterpriseAgentId) as { mr?: string } | undefined;
    return row?.mr ?? '';
  }

  setModel(enterpriseAgentId: string, modelRef: string): void {
    const existing = this.db
      .prepare('SELECT 1 FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?')
      .get(enterpriseAgentId);
    if (existing) {
      this.db.prepare(
        'UPDATE enterprise_agent_prefs SET model_ref = ?, updated_at = ? WHERE enterprise_agent_id = ?',
      ).run(modelRef, Date.now(), enterpriseAgentId);
    } else {
      this.db.prepare(
        `INSERT INTO enterprise_agent_prefs (enterprise_agent_id, working_directory, model_ref, updated_at)
         VALUES (?, '', ?, ?)`,
      ).run(enterpriseAgentId, modelRef, Date.now());
    }
  }

  remove(enterpriseAgentId: string): void {
    this.db.prepare('DELETE FROM enterprise_agent_prefs WHERE enterprise_agent_id = ?').run(enterpriseAgentId);
  }
}
