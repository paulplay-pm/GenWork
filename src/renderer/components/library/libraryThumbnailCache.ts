const MAX_CACHE_ENTRIES = 128;

const thumbnailCache = new Map<string, string>();
const thumbnailRequests = new Map<string, Promise<string | undefined>>();

export const createLibraryThumbnailCacheKey = (
  filePath: string,
  fileMtimeMs?: number,
): string => `${filePath}\0${fileMtimeMs ?? 'unknown'}`;

export const getCachedLibraryThumbnail = (cacheKey: string): string | undefined => {
  const value = thumbnailCache.get(cacheKey);
  if (!value) return undefined;
  thumbnailCache.delete(cacheKey);
  thumbnailCache.set(cacheKey, value);
  return value;
};

export const loadLibraryThumbnail = (
  cacheKey: string,
  load: () => Promise<string | undefined>,
): Promise<string | undefined> => {
  const cached = getCachedLibraryThumbnail(cacheKey);
  if (cached) return Promise.resolve(cached);

  const existingRequest = thumbnailRequests.get(cacheKey);
  if (existingRequest) return existingRequest;

  const request = load().then(value => {
    if (!value) return undefined;
    thumbnailCache.set(cacheKey, value);
    while (thumbnailCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = thumbnailCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      thumbnailCache.delete(oldestKey);
    }
    return value;
  }).finally(() => {
    thumbnailRequests.delete(cacheKey);
  });
  thumbnailRequests.set(cacheKey, request);
  return request;
};

export const clearLibraryThumbnailCache = (): void => {
  thumbnailCache.clear();
  thumbnailRequests.clear();
};
