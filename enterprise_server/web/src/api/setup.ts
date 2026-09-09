import { apiClient } from './client';
import type { SetupStartResponse, SetupRedeemResponse, SetupStatus } from './types';

export const setupApi = {
  status: () => apiClient.get<SetupStatus>('/api/setup/status'),
  start: (orgName: string) =>
    apiClient.post<SetupStartResponse>('/api/setup/start', { orgName }),
  redeem: (input: { orgId: string; code: string; username: string; password: string }) =>
    apiClient.post<SetupRedeemResponse>('/api/setup/redeem', input),
};
