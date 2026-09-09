import { apiClient } from './client';

export interface SkillCategory { id: string; name_zh: string; name_en: string; display_order?: number; }
export interface SkillSource { from?: string; url?: string; author?: string; }

// --- Org-scoped wire shapes (T9) ---

export interface SkillScope { allCompany: boolean; deptIds: string[]; userIds: string[]; }

export interface SkillAdmin {
  id: string; name: string; name_zh: string | null; description: string;
  category: string; version: string | null; icon: string | null;
  scope: SkillScope; scopeSummary: string;
  zip: { fileName: string | null; fileSize: number | null };
  enabled: boolean; useCount30d: number;
  updatedAt: string; createdBy: string | null; updatedBy: string | null;
}

export type SkillSubmissionStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface SkillSubmission {
  id: string; name: string; desc: string | null; authorId: string;
  version: string; submittedAt: string; status: SkillSubmissionStatus;
  rejectReason: string | null; cfg: Record<string, unknown>; approvedSkillId: string | null;
}

export interface SkillSubmissionList { submissions: SkillSubmission[]; counts?: Record<SkillSubmissionStatus, number>; }

export const skillMarketplaceApi = {
  listSkills: () => apiClient.get<SkillAdmin[]>('/api/admin/skill-marketplace/skills'),
  parseZip: (file: File) =>
    apiClient.postRaw<{ name: string; version: string; size: number; sha256: string; tempToken: string }>(
      '/api/admin/skill-marketplace/skills/parse-zip', file, { 'content-type': 'application/zip' }),
  createSkill: (input: { tempToken: string; nameZh?: string; author?: string; category_id: string; desc?: string; icon?: string; scope: SkillScope }) =>
    apiClient.post<{ skill_id: string }>('/api/admin/skill-marketplace/skills', input),
  updateSkill: (id: string, patch: { nameZh?: string; author?: string; desc?: string; icon?: string; category_id?: string; scope?: SkillScope; enabled?: boolean }) =>
    apiClient.patch<void>(`/api/admin/skill-marketplace/skills/${id}`, patch),
  uploadZip: (id: string, file: File) =>
    apiClient.postRaw<{ status: string }>(`/api/admin/skill-marketplace/skills/${id}/zip`, file, { 'content-type': 'application/zip' }),
  deleteSkill: (id: string) => apiClient.delete(`/api/admin/skill-marketplace/skills/${id}`),
  listCategories: () => apiClient.get<SkillCategory[]>('/api/admin/skill-marketplace/categories'),
  createCategory: (input: { name_zh: string; name_en: string; display_order?: number }) =>
    apiClient.post<{ category_id: string }>('/api/admin/skill-marketplace/categories', input),
  updateCategory: (id: string, input: { name_zh?: string; name_en?: string }) =>
    apiClient.put<void>(`/api/admin/skill-marketplace/categories/${id}`, input),
  deleteCategory: (id: string) => apiClient.delete(`/api/admin/skill-marketplace/categories/${id}`),
  listSubmissions: (status?: string) =>
    apiClient.get<SkillSubmissionList>(`/api/admin/skill-marketplace/submissions${status ? `?status=${status}` : ''}`),
  approveSubmission: (id: string) =>
    apiClient.post<{ ok: boolean; id: string }>(`/api/admin/skill-marketplace/submissions/${id}/approve`),
  rejectSubmission: (id: string, reason: string) =>
    apiClient.post<{ ok: boolean }>(`/api/admin/skill-marketplace/submissions/${id}/reject`, { reason }),
  withdrawSubmission: (id: string) =>
    apiClient.post<{ ok: boolean }>(`/api/admin/skill-marketplace/submissions/${id}/withdraw`),
  getSettings: () => apiClient.get<{ membersCanSubmit: boolean }>('/api/admin/skill-marketplace/settings'),
  setSettings: (input: { membersCanSubmit: boolean }) =>
    apiClient.patch<{ ok: boolean; membersCanSubmit: boolean }>('/api/admin/skill-marketplace/settings', input),
};
