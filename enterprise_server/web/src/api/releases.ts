import { apiClient } from './client';

export interface ReleaseChangelog {
  zh?: { title: string; content: string[] };
  en?: { title: string; content: string[] };
}

export interface ReleaseInstaller {
  id: string;
  fileName: string;
  fileSize: number;
  sha256: string;
}

export interface ReleaseInstallers {
  macArm?: ReleaseInstaller;
  windowsX64?: ReleaseInstaller;
}

export interface ReleaseView {
  id: string;
  version: string;
  published_at: string;
  change_log: ReleaseChangelog;
  installers: ReleaseInstallers;
  enabled: boolean;
  is_latest: boolean;
}

export const releasesApi = {
  list: (orgId: string): Promise<ReleaseView[]> =>
    apiClient.get<ReleaseView[]>(`/admin/releases?orgId=${encodeURIComponent(orgId)}`),

  add: (input: {
    orgId: string;
    version: string;
    published_at?: string;
    changeLog: ReleaseChangelog;
    installers: ReleaseInstallers;
  }): Promise<string> =>
    apiClient
      .post<{ id: string }>('/admin/releases', input)
      .then((r) => r.id),

  update: (
    id: string,
    patch: {
      changeLog?: ReleaseChangelog;
      installers?: ReleaseInstallers;
      enabled?: boolean;
    },
  ): Promise<{ ok: true }> => apiClient.patch<{ ok: true }>(`/admin/releases/${id}`, patch),

  setLatest: (id: string): Promise<{ ok: true }> =>
    apiClient.post<{ ok: true }>(`/admin/releases/${id}/set-latest`),

  remove: (id: string): Promise<void> => apiClient.delete(`/admin/releases/${id}`),
};
