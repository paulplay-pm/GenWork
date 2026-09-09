import { exec } from 'child_process';
import { promisify } from 'util';

import { SystemPermissionStatus, type SystemPermissionStatus as SystemPermissionStatusValue } from '../../shared/permissions/constants';

const execAsync = promisify(exec);

export async function checkCalendarPermission(): Promise<SystemPermissionStatusValue> {
  if (process.platform === 'darwin') {
    try {
      await execAsync('osascript -l JavaScript -e \'Application("Calendar").name()\'', {
        timeout: 5000,
      });
      console.log('[Permissions] macOS Calendar access: authorized');
      return SystemPermissionStatus.Authorized;
    } catch (error: unknown) {
      const stderr =
        typeof error === 'object' && error && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '')
          : '';

      if (
        stderr.includes('不能获取对象') ||
        stderr.includes('not authorized') ||
        stderr.includes('Permission denied')
      ) {
        console.log('[Permissions] macOS Calendar access: not-determined (needs permission)');
        return SystemPermissionStatus.NotDetermined;
      }
      console.warn('[Permissions] Failed to check macOS calendar permission:', error);
      return SystemPermissionStatus.NotDetermined;
    }
  }

  if (process.platform === 'win32') {
    try {
      const checkScript = `
        try {
          $Outlook = New-Object -ComObject Outlook.Application
          $Outlook.Version
        } catch { exit 1 }
      `;
      await execAsync(`powershell -Command "${checkScript}"`, { timeout: 10000 });
      console.log('[Permissions] Windows Outlook is available');
      return SystemPermissionStatus.Authorized;
    } catch {
      console.log('[Permissions] Windows Outlook not available or not accessible');
      return SystemPermissionStatus.NotDetermined;
    }
  }

  return SystemPermissionStatus.NotSupported;
}

export async function requestCalendarPermission(): Promise<boolean> {
  if (process.platform === 'darwin') {
    try {
      await execAsync(
        'osascript -l JavaScript -e \'Application("Calendar").calendars()[0].name()\'',
        { timeout: 10000 },
      );
      return true;
    } catch (error) {
      console.warn('[Permissions] Failed to request macOS calendar permission:', error);
      return false;
    }
  }

  if (process.platform === 'win32') {
    const status = await checkCalendarPermission();
    return status === SystemPermissionStatus.Authorized;
  }

  return false;
}
