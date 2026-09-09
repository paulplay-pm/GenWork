import { apiClient } from './client';

export interface UsageResponse {
  window_date: string;
  items: { model_id: string; used: number }[];
}

export const usageApi = {
  today: () => apiClient.get<UsageResponse>('/usage/today'),
};