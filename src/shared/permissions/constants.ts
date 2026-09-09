export const PermissionIpcChannel = {
  CheckCalendar: 'permissions:checkCalendar',
  RequestCalendar: 'permissions:requestCalendar',
} as const;

export type PermissionIpcChannel = typeof PermissionIpcChannel[keyof typeof PermissionIpcChannel];

export const SystemPermissionStatus = {
  Authorized: 'authorized',
  Denied: 'denied',
  Restricted: 'restricted',
  NotDetermined: 'not-determined',
  NotSupported: 'not-supported',
} as const;

export type SystemPermissionStatus = typeof SystemPermissionStatus[keyof typeof SystemPermissionStatus];
