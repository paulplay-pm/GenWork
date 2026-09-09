import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

interface ThumbnailFileStat {
  isFile: () => boolean;
  mtimeMs: number;
  size: number;
}

interface ThumbnailSize {
  width: number;
  height: number;
}

interface LibraryThumbnailServiceOptions {
  createThumbnail: (filePath: string, size: ThumbnailSize) => Promise<Buffer>;
  getCacheDirectory?: () => string;
  statFile?: (filePath: string) => Promise<ThumbnailFileStat>;
  maxConcurrency?: number;
  maxMemoryEntries?: number;
  maxDiskEntries?: number;
  size?: ThumbnailSize;
}

const THUMBNAIL_CACHE_VERSION = 'cross-platform-renderer-v1';
const DEFAULT_THUMBNAIL_SIZE = { width: 480, height: 270 };

export class LibraryThumbnailService {
  private readonly createThumbnail: LibraryThumbnailServiceOptions['createThumbnail'];
  private readonly getCacheDirectory?: () => string;
  private readonly statFile: NonNullable<LibraryThumbnailServiceOptions['statFile']>;
  private readonly maxConcurrency: number;
  private readonly maxMemoryEntries: number;
  private readonly maxDiskEntries: number;
  private readonly size: ThumbnailSize;
  private readonly memoryCache = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly waiters: Array<() => void> = [];
  private activeCount = 0;
  private diskPrunePromise?: Promise<void>;

  constructor(options: LibraryThumbnailServiceOptions) {
    this.createThumbnail = options.createThumbnail;
    this.getCacheDirectory = options.getCacheDirectory;
    this.statFile = options.statFile ?? (filePath => fs.promises.stat(filePath));
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 3));
    this.maxMemoryEntries = Math.max(1, Math.floor(options.maxMemoryEntries ?? 128));
    this.maxDiskEntries = Math.max(1, Math.floor(options.maxDiskEntries ?? 256));
    this.size = options.size ?? DEFAULT_THUMBNAIL_SIZE;
  }

  async generate(filePath: string): Promise<string> {
    if (!filePath.trim()) throw new Error('Missing file path');

    const resolvedPath = path.resolve(filePath.trim());
    const stat = await this.statFile(resolvedPath);
    if (!stat.isFile()) throw new Error('Not a file');

    const cacheKey = [
      THUMBNAIL_CACHE_VERSION,
      resolvedPath,
      stat.mtimeMs,
      stat.size,
    ].join('\0');
    const memoryValue = this.getMemoryValue(cacheKey);
    if (memoryValue) return memoryValue;

    const existingRequest = this.inFlight.get(cacheKey);
    if (existingRequest) return existingRequest;

    const request = this.runWithConcurrencyLimit(async () => {
      const diskValue = await this.readDiskValue(cacheKey);
      if (diskValue) return diskValue;

      const buffer = await this.createThumbnail(resolvedPath, this.size);
      if (buffer.length === 0) throw new Error('Thumbnail is empty');
      await this.writeDiskValue(cacheKey, buffer);
      return `data:image/png;base64,${buffer.toString('base64')}`;
    }).then(dataUrl => {
      this.setMemoryValue(cacheKey, dataUrl);
      return dataUrl;
    }).finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, request);
    return request;
  }

  private getMemoryValue(cacheKey: string): string | undefined {
    const value = this.memoryCache.get(cacheKey);
    if (!value) return undefined;
    this.memoryCache.delete(cacheKey);
    this.memoryCache.set(cacheKey, value);
    return value;
  }

  private setMemoryValue(cacheKey: string, value: string): void {
    this.memoryCache.delete(cacheKey);
    this.memoryCache.set(cacheKey, value);
    while (this.memoryCache.size > this.maxMemoryEntries) {
      const oldestKey = this.memoryCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.memoryCache.delete(oldestKey);
    }
  }

  private getDiskPath(cacheKey: string): string | undefined {
    if (!this.getCacheDirectory) return undefined;
    const digest = crypto.createHash('sha256').update(cacheKey).digest('hex');
    return path.join(this.getCacheDirectory(), `${digest}.png`);
  }

  private async readDiskValue(cacheKey: string): Promise<string | undefined> {
    const cachePath = this.getDiskPath(cacheKey);
    if (!cachePath) return undefined;
    try {
      const buffer = await fs.promises.readFile(cachePath);
      if (buffer.length === 0) return undefined;
      void fs.promises.utimes(cachePath, new Date(), new Date()).catch((): void => {
        // Cache recency is best-effort.
      });
      return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch {
      return undefined;
    }
  }

  private async writeDiskValue(cacheKey: string, buffer: Buffer): Promise<void> {
    const cachePath = this.getDiskPath(cacheKey);
    if (!cachePath) return;
    try {
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.promises.writeFile(cachePath, buffer);
      this.scheduleDiskPrune();
    } catch {
      // A cache write failure must not prevent the thumbnail from being displayed.
    }
  }

  private scheduleDiskPrune(): void {
    if (this.diskPrunePromise || !this.getCacheDirectory) return;
    this.diskPrunePromise = this.pruneDiskCache()
      .catch((): void => {
        // Cache cleanup is best-effort.
      })
      .finally((): void => {
        this.diskPrunePromise = undefined;
      });
  }

  private async pruneDiskCache(): Promise<void> {
    const cacheDirectory = this.getCacheDirectory?.();
    if (!cacheDirectory) return;
    const entries = await fs.promises.readdir(cacheDirectory, { withFileTypes: true });
    const cacheFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.png'));
    if (cacheFiles.length <= this.maxDiskEntries) return;

    const filesWithStats = await Promise.all(cacheFiles.map(async entry => {
      const filePath = path.join(cacheDirectory, entry.name);
      const stat = await fs.promises.stat(filePath);
      return { filePath, lastUsedAt: stat.mtimeMs };
    }));
    filesWithStats.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const deleteCount = filesWithStats.length - this.maxDiskEntries;
    await Promise.all(filesWithStats.slice(0, deleteCount).map(({ filePath }) => (
      fs.promises.unlink(filePath).catch((): void => {
        // A concurrently removed cache entry needs no further handling.
      })
    )));
  }

  private async runWithConcurrencyLimit<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrency) {
      await new Promise<void>(resolve => {
        this.waiters.push(resolve);
      });
    }
    this.activeCount += 1;
    try {
      return await task();
    } finally {
      this.activeCount -= 1;
      this.waiters.shift()?.();
    }
  }
}
