import { apiClient } from './client';

export interface KitCategory { id: string; name_zh: string; name_en: string; display_order?: number; }

export interface KitScope { allCompany: boolean; deptIds: string[]; userIds: string[]; }

export interface KitAdmin {
  id: string; // == slug
  name_en: string | null; name_zh: string | null;
  description_en: string | null; description_zh: string | null;
  icon: string | null; author: string | null; version: string | null; category: string | null;
  tryAsking: Array<{ en: string; zh: string }>;
  skillList: Array<Record<string, unknown>>;
  scope: KitScope; scopeSummary: string;
  zip: { fileName: string | null; fileSize: number | null };
  enabled: boolean; isBuiltin: boolean;
  updatedAt: string;
}

export const kitCatalogApi = {
  listKits: () => apiClient.get<KitAdmin[]>('/api/admin/kits'),
  parseZip: (file: File) =>
    apiClient.postRaw<{ size: number; sha256: string; tempToken: string }>(
      '/api/admin/kits/parse-zip', file, { 'content-type': 'application/zip' }),
  createKit: (input: {
    tempToken: string; slug: string;
    nameEn?: string; nameZh?: string;
    descriptionEn?: string; descriptionZh?: string;
    icon?: string; author?: string; version?: string;
    category_id: string;
    tryAsking?: Array<{ en: string; zh: string }>;
    skillList?: Array<Record<string, unknown>>;
    scope: KitScope;
  }) => apiClient.post<{ slug: string }>('/api/admin/kits', input),
  updateKit: (slug: string, patch: {
    nameEn?: string; nameZh?: string;
    descriptionEn?: string; descriptionZh?: string;
    icon?: string; author?: string; version?: string;
    category_id?: string; scope?: KitScope; enabled?: boolean;
  }) => apiClient.patch<void>(`/api/admin/kits/${slug}`, patch),
  uploadZip: (slug: string, file: File) =>
    apiClient.postRaw<{ status: string }>(`/api/admin/kits/${slug}/zip`, file, { 'content-type': 'application/zip' }),
  deleteKit: (slug: string) => apiClient.delete<void>(`/api/admin/kits/${slug}`),
  listCategories: () => apiClient.get<KitCategory[]>('/api/admin/kits/categories'),
  createCategory: (input: { name_zh: string; name_en: string; display_order?: number }) =>
    apiClient.post<{ category_id: string }>('/api/admin/kits/categories', input),
  updateCategory: (id: string, input: { name_zh?: string; name_en?: string }) =>
    apiClient.put<void>(`/api/admin/kits/categories/${id}`, input),
  deleteCategory: (id: string) => apiClient.delete<void>(`/api/admin/kits/categories/${id}`),
};
