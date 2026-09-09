export const DataMigrationIpc = {
  Backup: 'openclaw:dataMigration:backup',
  Restore: 'openclaw:dataMigration:restore',
  GetLastRestoreResult: 'openclaw:dataMigration:getLastRestoreResult',
} as const;

export type DataMigrationIpc =
  typeof DataMigrationIpc[keyof typeof DataMigrationIpc];

export const DataMigrationRestoreStatus = {
  Success: 'success',
  Failed: 'failed',
} as const;

export type DataMigrationRestoreStatus =
  typeof DataMigrationRestoreStatus[keyof typeof DataMigrationRestoreStatus];

export interface DataMigrationBackupResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  sizeBytes?: number;
  error?: string;
}

export interface DataMigrationRestoreScheduleResult {
  success: boolean;
  canceled?: boolean;
  scheduledRestart?: boolean;
  rollbackPath?: string;
  error?: string;
}

export interface DataMigrationLastRestoreResult {
  status: DataMigrationRestoreStatus;
  archivePath: string;
  rollbackPath?: string;
  restoredAt: string;
  error?: string;
}

export interface DataMigrationLastRestoreResponse {
  success: boolean;
  result?: DataMigrationLastRestoreResult | null;
  error?: string;
}
