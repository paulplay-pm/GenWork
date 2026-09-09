import {
  AppUpdateStatus,
  type AppUpdateStatus as AppUpdateStatusValue,
} from '../../../shared/appUpdate/constants';

export const isAppUpdateInteractionBlockingStatus = (
  status: AppUpdateStatusValue,
): boolean => (
  status === AppUpdateStatus.Downloading
  || status === AppUpdateStatus.Ready
  || status === AppUpdateStatus.Installing
);

export const shouldBlockAppInteractionForUpdate = (
  isUserInitiatedFlowActive: boolean,
  status: AppUpdateStatusValue,
): boolean => (
  isUserInitiatedFlowActive && isAppUpdateInteractionBlockingStatus(status)
);

