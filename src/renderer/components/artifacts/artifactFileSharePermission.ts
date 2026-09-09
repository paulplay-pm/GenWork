import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  type HtmlShareConfigurableStatus,
  HtmlShareDisabledSource,
  type HtmlShareDisabledSource as HtmlShareDisabledSourceValue,
  HtmlShareStatus,
  type HtmlShareStatus as HtmlShareStatusValue,
} from '@shared/htmlShare/constants';

export const ArtifactFileSharePermission = {
  Public: HtmlShareAccessMode.Public,
  Code: HtmlShareAccessMode.Code,
  Org: HtmlShareAccessMode.Org,
  Stopped: HtmlShareStatus.Disabled,
} as const;

export type ArtifactFileSharePermission =
  (typeof ArtifactFileSharePermission)[keyof typeof ArtifactFileSharePermission];

export const ArtifactFileSharePermissionConfirmationKind = {
  MakePublic: 'make_public',
  RequireCode: 'require_code',
  Stop: 'stop',
  Resume: 'resume',
} as const;

export type ArtifactFileSharePermissionConfirmationKind =
  typeof ArtifactFileSharePermissionConfirmationKind[
    keyof typeof ArtifactFileSharePermissionConfirmationKind
  ];

export interface ArtifactFileSharePermissionRecord {
  accessMode: HtmlShareAccessModeValue;
  status: HtmlShareStatusValue;
  disabledSource?: HtmlShareDisabledSourceValue | null;
}

export const ArtifactFileSharePermissionChangeAction = {
  UpdateAccess: 'update_access',
  UpdateStatus: 'update_status',
  RestoreActiveLimit: 'restore_active_limit',
  Blocked: 'blocked',
} as const;

export type ArtifactFileSharePermissionChangeAction =
  (typeof ArtifactFileSharePermissionChangeAction)[keyof typeof ArtifactFileSharePermissionChangeAction];

export type ArtifactFileShareResumeLockedSource =
  | typeof HtmlShareDisabledSource.Admin
  | typeof HtmlShareDisabledSource.Moderation
  | typeof HtmlShareDisabledSource.System;

export type ArtifactFileSharePermissionChangeStep =
  | {
      action: typeof ArtifactFileSharePermissionChangeAction.UpdateAccess;
      accessMode: HtmlShareAccessModeValue;
    }
  | {
      action: typeof ArtifactFileSharePermissionChangeAction.UpdateStatus;
      status: HtmlShareConfigurableStatus;
    }
  | {
      action: typeof ArtifactFileSharePermissionChangeAction.RestoreActiveLimit;
    }
  | {
      action: typeof ArtifactFileSharePermissionChangeAction.Blocked;
      disabledSource: ArtifactFileShareResumeLockedSource;
    };

export function deriveArtifactFileSharePermission(
  share: ArtifactFileSharePermissionRecord,
): ArtifactFileSharePermission {
  if (share.status === HtmlShareStatus.Disabled) {
    return ArtifactFileSharePermission.Stopped;
  }
  switch (share.accessMode) {
    case HtmlShareAccessMode.Public:
      return ArtifactFileSharePermission.Public;
    case HtmlShareAccessMode.Org:
      return ArtifactFileSharePermission.Org;
    default:
      return ArtifactFileSharePermission.Code;
  }
}

export function resolveArtifactFileSharePermissionConfirmation(
  current: ArtifactFileSharePermission,
  target: ArtifactFileSharePermission,
): ArtifactFileSharePermissionConfirmationKind | undefined {
  if (current === target) return undefined;
  if (target === ArtifactFileSharePermission.Stopped) {
    return ArtifactFileSharePermissionConfirmationKind.Stop;
  }
  if (current === ArtifactFileSharePermission.Stopped) {
    return ArtifactFileSharePermissionConfirmationKind.Resume;
  }
  return target === ArtifactFileSharePermission.Public
    ? ArtifactFileSharePermissionConfirmationKind.MakePublic
    : ArtifactFileSharePermissionConfirmationKind.RequireCode;
}

export function isArtifactFileShareResumeLocked(
  disabledSource?: HtmlShareDisabledSourceValue | null,
): disabledSource is ArtifactFileShareResumeLockedSource {
  return (
    disabledSource === HtmlShareDisabledSource.Admin ||
    disabledSource === HtmlShareDisabledSource.Moderation ||
    disabledSource === HtmlShareDisabledSource.System
  );
}

function permissionToAccessMode(
  permission: Exclude<ArtifactFileSharePermission, typeof ArtifactFileSharePermission.Stopped>,
): HtmlShareAccessModeValue {
  switch (permission) {
    case ArtifactFileSharePermission.Public:
      return HtmlShareAccessMode.Public;
    case ArtifactFileSharePermission.Org:
      return HtmlShareAccessMode.Org;
    default:
      return HtmlShareAccessMode.Code;
  }
}

export function buildArtifactFileSharePermissionPlan(
  share: ArtifactFileSharePermissionRecord,
  target: ArtifactFileSharePermission,
): ArtifactFileSharePermissionChangeStep[] {
  const current = deriveArtifactFileSharePermission(share);
  if (target === current) {
    return [];
  }

  if (current !== ArtifactFileSharePermission.Stopped) {
    if (target === ArtifactFileSharePermission.Stopped) {
      return [
        {
          action: ArtifactFileSharePermissionChangeAction.UpdateStatus,
          status: HtmlShareStatus.Disabled,
        },
      ];
    }

    return [
      {
        action: ArtifactFileSharePermissionChangeAction.UpdateAccess,
        accessMode: permissionToAccessMode(target),
      },
    ];
  }

  if (target === ArtifactFileSharePermission.Stopped) {
    return [];
  }

  if (isArtifactFileShareResumeLocked(share.disabledSource)) {
    return [
      {
        action: ArtifactFileSharePermissionChangeAction.Blocked,
        disabledSource: share.disabledSource,
      },
    ];
  }

  const targetAccessMode = permissionToAccessMode(target);
  const changeAccessSteps: ArtifactFileSharePermissionChangeStep[] =
    targetAccessMode === share.accessMode
      ? []
      : [
          {
            action: ArtifactFileSharePermissionChangeAction.UpdateAccess,
            accessMode: targetAccessMode,
          },
        ];

  if (share.disabledSource === HtmlShareDisabledSource.ActiveLimit) {
    return [
      ...changeAccessSteps,
      { action: ArtifactFileSharePermissionChangeAction.RestoreActiveLimit },
    ];
  }

  return [
    ...changeAccessSteps,
    {
      action: ArtifactFileSharePermissionChangeAction.UpdateStatus,
      status: HtmlShareStatus.Live,
    },
  ];
}
