export type MediaGenerationMode = 'auto' | 'image' | 'video' | 'none';

export interface MediaModel {
  modelId: string;
  displayName: string;
  provider: string;
  mediaType: 'image' | 'video';
  generationTimeout: number;
  pricing: Record<string, unknown>;
  pricingDescription?: string;
  capabilities?: string;
  description?: string;
  unitCredits?: number;
  unitLabel?: string;
}

export interface MediaQuotaStatus {
  subscribed: boolean;
  planName: string;
  planDisplayName: string;
  yearMonth: string;
  totalAvailableCredits: number;
}

export interface MediaGenerationSelection {
  mode: MediaGenerationMode;
  modelId?: string;
  modelName?: string;
  imageModelId?: string;
  videoModelId?: string;
}

export interface MediaTaskStatus {
  taskId: number;
  model: string;
  type: 'image' | 'video';
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  progress: number;
  resultUrls: string[];
  metadata: Record<string, unknown>;
  quotaRemaining: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface MediaAttachmentRef {
  token: string;
  mediaType: 'image' | 'video' | 'audio';
  index: number;
  fileId: string;
  fileName: string;
  mimeType: string;
  localPath?: string;
  remoteUrl?: string;
  dataUrl?: string;
  role?: 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video' | 'reference_audio';
}
