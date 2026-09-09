import type { IpcMain } from 'electron';

import { PermissionIpcChannel, SystemPermissionStatus } from '../../../shared/permissions/constants';
import { checkCalendarPermission, requestCalendarPermission } from '../../permissions/calendarPermission';

export interface PermissionHandlerDeps {
  ipcMain: IpcMain;
  isDev: boolean;
}

export function registerPermissionIpcHandlers({ ipcMain, isDev }: PermissionHandlerDeps): void {
  ipcMain.handle(PermissionIpcChannel.CheckCalendar, async () => {
    try {
      const status = await checkCalendarPermission();

      if (isDev && status === SystemPermissionStatus.NotDetermined && process.platform === 'darwin') {
        console.log('[Permissions] Development mode: Auto-requesting calendar permission...');
        try {
          await requestCalendarPermission();
          const newStatus = await checkCalendarPermission();
          console.log(
            '[Permissions] Development mode: Permission status after request:',
            newStatus,
          );
          return { success: true, status: newStatus, autoRequested: true };
        } catch (requestError) {
          console.warn('[Permissions] Development mode: Auto-request failed:', requestError);
        }
      }

      return { success: true, status };
    } catch (error) {
      console.error('[Main] Error checking calendar permission:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check permission',
      };
    }
  });

  ipcMain.handle(PermissionIpcChannel.RequestCalendar, async () => {
    try {
      const granted = await requestCalendarPermission();
      const status = await checkCalendarPermission();
      return { success: true, granted, status };
    } catch (error) {
      console.error('[Main] Error requesting calendar permission:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to request permission',
      };
    }
  });
}
