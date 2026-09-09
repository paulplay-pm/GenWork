import type { BrowserWindow, Session } from 'electron';

export interface VoiceInputPermissionHandlerOptions {
  session: Session;
  getMainWindow: () => BrowserWindow | null;
  isDev: boolean;
  startUrl?: string;
}
