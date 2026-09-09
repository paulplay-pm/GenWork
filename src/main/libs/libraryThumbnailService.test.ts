import { describe, expect, test } from 'vitest';

import { LibraryThumbnailService } from './libraryThumbnailService';

const createStat = (mtimeMs: number, size = 10) => ({
  isFile: () => true,
  mtimeMs,
  size,
});

const flushTasks = (): Promise<void> => new Promise(resolve => {
  setImmediate(resolve);
});

describe('LibraryThumbnailService', () => {
  test('uses a fixed cross-platform 16:9 thumbnail size', async () => {
    let receivedSize: { width: number; height: number } | undefined;
    const service = new LibraryThumbnailService({
      statFile: async () => createStat(100),
      createThumbnail: async (_filePath, size) => {
        receivedSize = size;
        return Buffer.from('thumbnail');
      },
    });

    await service.generate('/tmp/library-fixed-size.png');

    expect(receivedSize).toEqual({ width: 480, height: 270 });
  });

  test('caches by resolved path, mtime and size', async () => {
    let mtimeMs = 100;
    let createCount = 0;
    const service = new LibraryThumbnailService({
      statFile: async () => createStat(mtimeMs),
      createThumbnail: async () => Buffer.from(`thumbnail-${++createCount}`),
    });

    const first = await service.generate('/tmp/library-cache.docx');
    const second = await service.generate('/tmp/library-cache.docx');
    expect(second).toBe(first);
    expect(createCount).toBe(1);

    mtimeMs = 200;
    const changed = await service.generate('/tmp/library-cache.docx');
    expect(changed).not.toBe(first);
    expect(createCount).toBe(2);
  });

  test('deduplicates simultaneous requests for the same file version', async () => {
    let createCount = 0;
    let releaseThumbnail: ((value: Buffer) => void) | undefined;
    const service = new LibraryThumbnailService({
      statFile: async () => createStat(100),
      createThumbnail: async () => {
        createCount += 1;
        return new Promise<Buffer>(resolve => {
          releaseThumbnail = resolve;
        });
      },
    });

    const first = service.generate('/tmp/library-deduplicate.pdf');
    const second = service.generate('/tmp/library-deduplicate.pdf');
    await flushTasks();
    expect(createCount).toBe(1);

    releaseThumbnail?.(Buffer.from('thumbnail'));
    await expect(Promise.all([first, second])).resolves.toEqual([
      'data:image/png;base64,dGh1bWJuYWls',
      'data:image/png;base64,dGh1bWJuYWls',
    ]);
  });

  test('limits concurrent thumbnail generation', async () => {
    let activeCount = 0;
    let peakActiveCount = 0;
    const releases: Array<() => void> = [];
    const service = new LibraryThumbnailService({
      maxConcurrency: 2,
      statFile: async () => createStat(100),
      createThumbnail: async filePath => {
        activeCount += 1;
        peakActiveCount = Math.max(peakActiveCount, activeCount);
        await new Promise<void>(resolve => {
          releases.push(resolve);
        });
        activeCount -= 1;
        return Buffer.from(filePath);
      },
    });

    const requests = [
      service.generate('/tmp/library-one.pdf'),
      service.generate('/tmp/library-two.pdf'),
      service.generate('/tmp/library-three.pdf'),
    ];
    await flushTasks();
    expect(releases).toHaveLength(2);
    expect(peakActiveCount).toBe(2);

    releases.shift()?.();
    await flushTasks();
    expect(releases).toHaveLength(2);
    releases.splice(0).forEach(release => release());
    await Promise.all(requests);
    expect(peakActiveCount).toBe(2);
  });
});
