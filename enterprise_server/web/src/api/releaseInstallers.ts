import { apiClient } from './client';

export type InstallerPlatform = 'macArm' | 'windowsX64';

export interface InstallerMeta {
  id: string;
  fileName: string;
  fileSize: number;
  sha256: string;
}

export interface UploadProgress {
  done: number;
  total: number;
}

export interface ResumeState {
  uploadId: string;
  totalAccepted: number;
  chunkSize?: number;
}

/** Thrown when a chunked upload fails. `.resume` lets the caller continue. */
export class InstallerUploadError extends Error {
  resume?: ResumeState;
  constructor(message: string, resume?: ResumeState) {
    super(message);
    this.name = 'InstallerUploadError';
    this.resume = resume;
  }
}

async function raw(method: string, url: string, token: string | null, body?: BodyInit): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/octet-stream';
  const res = await fetch(url, { method, headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code: string | undefined;
    try {
      // Server returns `{ error: '<code>' }` (matches src/routes/releaseInstallerUploads.ts
      // and the rest of the enterprise-server error envelope). Older clients parsed
      // `.detail`, which the server never sends — every upload error message became
      // just "upload failed (http 400)" with the reason lost.
      code = (JSON.parse(text) as { error?: string }).error;
    } catch { /* ignore */ }
    throw new Error(`upload failed (http ${res.status})${code ? `: ${code}` : ''}`);
  }
  return res;
}

/** jsdom's Blob (unit tests) has no `arrayBuffer()`, so fall back to the
 * standard FileReader API when it is missing. Browsers always have it. */
async function readChunkBytes(chunk: Blob): Promise<Uint8Array> {
  if (typeof chunk.arrayBuffer === 'function') {
    return new Uint8Array(await chunk.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read chunk'));
    reader.readAsArrayBuffer(chunk);
  });
}

export interface UploadInstallerOptions {
  platform: InstallerPlatform;
  file: File;
  getToken: () => string | null;
  onProgress?: (progress: UploadProgress) => void;
  resume?: ResumeState;
  /**
   * Bytes per chunk. On a fresh upload the server's returned `chunkSize` is used
   * when this is omitted; pass it explicitly (e.g. on a resume after the server
   * restarted) to control slicing. Defaults to 8 MiB.
   */
  chunkSize?: number;
}

/**
 * Chunked, resumable installer upload. `init` is called once unless `resume`
 * supplies an existing `uploadId`. Each chunk is a `file.slice` PUT. On failure
 * it throws `InstallerUploadError` with `.resume` so the caller can continue.
 */
export async function uploadInstaller(opts: UploadInstallerOptions): Promise<InstallerMeta> {
  const { platform, file, getToken, onProgress, resume, chunkSize } = opts;
  const base = apiClient.baseUrl();
  let uploadId: string;
  let totalAccepted: number;
  let sliceSize = chunkSize ?? resume?.chunkSize;

  if (resume) {
    uploadId = resume.uploadId;
    totalAccepted = resume.totalAccepted;
  } else {
    const token = getToken();
    const res = await raw('POST', `${base}/admin/releases/installers/init`, token, JSON.stringify({
      platform,
      fileName: file.name,
      fileSize: file.size,
    }));
    const { uploadId: id, chunkSize: serverChunkSize } = (await res.json()) as { uploadId: string; chunkSize: number };
    uploadId = id;
    totalAccepted = 0;
    sliceSize = sliceSize ?? serverChunkSize ?? 8 * 1024 * 1024;
  }

  const CHUNK = sliceSize ?? 8 * 1024 * 1024;
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK));

  for (let index = totalAccepted; index < totalChunks; index += 1) {
    const start = index * CHUNK;
    const slice = file.slice(start, Math.min(start + CHUNK, file.size));
    const bytes = await readChunkBytes(slice);
    try {
      const res = await raw('PUT', `${base}/admin/releases/installers/${uploadId}/chunks/${index}`, getToken(), bytes as BodyInit);
      const { totalAccepted: next } = (await res.json()) as { totalAccepted: number };
      totalAccepted = next;
      onProgress?.({ done: Math.min(start + CHUNK, file.size), total: file.size });
    } catch (e) {
      throw new InstallerUploadError((e as Error).message, { uploadId, totalAccepted, chunkSize: CHUNK });
    }
  }

  try {
    const res = await raw('POST', `${base}/admin/releases/installers/${uploadId}/complete`, getToken());
    return (await res.json()) as InstallerMeta;
  } catch (e) {
    throw new InstallerUploadError((e as Error).message, { uploadId, totalAccepted, chunkSize: CHUNK });
  }
}
