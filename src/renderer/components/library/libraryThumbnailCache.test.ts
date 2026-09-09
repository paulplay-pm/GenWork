import { afterEach, describe, expect, test } from 'vitest';

import {
  clearLibraryThumbnailCache,
  createLibraryThumbnailCacheKey,
  getCachedLibraryThumbnail,
  loadLibraryThumbnail,
} from './libraryThumbnailCache';

afterEach(() => {
  clearLibraryThumbnailCache();
});

describe('library thumbnail cache', () => {
  test('changes the cache key when the file mtime changes', () => {
    expect(createLibraryThumbnailCacheKey('/tmp/report.pdf', 100)).not.toBe(
      createLibraryThumbnailCacheKey('/tmp/report.pdf', 200),
    );
  });

  test('deduplicates requests and keeps the loaded thumbnail', async () => {
    const cacheKey = createLibraryThumbnailCacheKey('/tmp/report.pdf', 100);
    let loadCount = 0;
    const load = async () => {
      loadCount += 1;
      return 'data:image/png;base64,dGVzdA==';
    };

    const [first, second] = await Promise.all([
      loadLibraryThumbnail(cacheKey, load),
      loadLibraryThumbnail(cacheKey, load),
    ]);

    expect(first).toBe('data:image/png;base64,dGVzdA==');
    expect(second).toBe(first);
    expect(loadCount).toBe(1);
    expect(getCachedLibraryThumbnail(cacheKey)).toBe(first);
  });
});
