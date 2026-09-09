import { app } from 'electron';
import fs from 'fs';
import path from 'path';

const COMPUTER_USE_LOG_RETENTION_DAYS = 7;
const COMPUTER_USE_DAILY_LOG_RE = /^computer-use-(js|helper)-\d{4}-\d{2}-\d{2}\.log$/;

export type ComputerUseLogEntry = {
  archiveName: string;
  filePath: string;
};

export function getComputerUseLogDir(): string {
  return path.join(app.getPath('userData'), 'computer-use', 'logs');
}

export function ensureComputerUseLogDir(): string {
  const logDir = getComputerUseLogDir();
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

export function getComputerUseLogRetentionDays(): number {
  return COMPUTER_USE_LOG_RETENTION_DAYS;
}

export function getRecentComputerUseLogEntries(
  logDir = getComputerUseLogDir(),
  now = new Date(),
): ComputerUseLogEntry[] {
  if (!fs.existsSync(logDir)) return [];

  const cutoffMs = now.getTime() - COMPUTER_USE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  return fs.readdirSync(logDir)
    .filter(fileName => COMPUTER_USE_DAILY_LOG_RE.test(fileName))
    .map(fileName => ({ archiveName: fileName, filePath: path.join(logDir, fileName) }))
    .filter(({ filePath }) => {
      try {
        return fs.statSync(filePath).mtimeMs >= cutoffMs;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.archiveName.localeCompare(b.archiveName));
}
