import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  createLibraryThumbnailRenderRequest,
  LibraryThumbnailLimits,
  type LibraryThumbnailRenderResult,
} from '../../shared/library/thumbnail';

interface ThumbnailSize {
  width: number;
  height: number;
}

interface LibraryThumbnailRendererOptions {
  developmentServerUrl?: string;
  productionHtmlPath: string;
  maxSourceBytes?: number;
  renderTimeoutMs?: number;
  captureTimeoutMs?: number;
}

const LIBRARY_THUMBNAIL_PARTITION = 'library-thumbnail-renderer';

const isRenderResult = (value: unknown): value is LibraryThumbnailRenderResult => (
  typeof value === 'object'
  && value !== null
  && typeof (value as LibraryThumbnailRenderResult).success === 'boolean'
);

export class LibraryThumbnailRenderer {
  private readonly developmentServerUrl?: string;
  private readonly productionHtmlPath: string;
  private readonly maxSourceBytes: number;
  private readonly renderTimeoutMs: number;
  private readonly captureTimeoutMs: number;
  private window?: BrowserWindow;
  private queueTail: Promise<void> = Promise.resolve();

  constructor(options: LibraryThumbnailRendererOptions) {
    this.developmentServerUrl = options.developmentServerUrl;
    this.productionHtmlPath = options.productionHtmlPath;
    this.maxSourceBytes = options.maxSourceBytes ?? LibraryThumbnailLimits.MaxSourceBytes;
    this.renderTimeoutMs = options.renderTimeoutMs ?? LibraryThumbnailLimits.RenderTimeoutMs;
    this.captureTimeoutMs = options.captureTimeoutMs ?? LibraryThumbnailLimits.CaptureTimeoutMs;
  }

  render(filePath: string, size: ThumbnailSize): Promise<Buffer> {
    const task = this.queueTail.then(() => this.renderNow(filePath, size));
    this.queueTail = task.then(
      (): void => {},
      (): void => {},
    );
    return task;
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = undefined;
  }

  private async renderNow(filePath: string, size: ThumbnailSize): Promise<Buffer> {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > this.maxSourceBytes) {
      throw new Error('File is too large for thumbnail rendering');
    }

    const content = await fs.promises.readFile(filePath);
    const request = createLibraryThumbnailRenderRequest(
      path.basename(filePath),
      content.toString('base64'),
      size.width,
      size.height,
    );
    if (!request) throw new Error('Unsupported thumbnail format');

    const rendererWindow = await this.ensureWindow(size);
    rendererWindow.setContentSize(size.width, size.height, false);
    rendererWindow.webContents.setZoomFactor(1);

    const script = `window.renderLibraryThumbnail(${JSON.stringify(request)})`;
    let result: unknown;
    try {
      result = await this.withTimeout(
        rendererWindow.webContents.executeJavaScript(script, true),
        this.renderTimeoutMs,
        'Thumbnail rendering timed out',
      );
    } catch (error) {
      this.resetWindow(rendererWindow);
      throw error;
    }
    if (!isRenderResult(result) || !result.success) {
      throw new Error(isRenderResult(result) ? result.error || 'Thumbnail rendering failed' : 'Invalid thumbnail renderer response');
    }

    const image = await this.withTimeout(
      rendererWindow.webContents.capturePage({
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
      }),
      this.captureTimeoutMs,
      'Thumbnail capture timed out',
    );
    if (image.isEmpty()) throw new Error('Thumbnail capture is empty');
    return image.toPNG();
  }

  private async ensureWindow(size: ThumbnailSize): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const rendererWindow = new BrowserWindow({
      width: size.width,
      height: size.height,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#F5F6F8',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition: LIBRARY_THUMBNAIL_PARTITION,
        backgroundThrottling: false,
        devTools: false,
        spellcheck: false,
        enableWebSQL: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    rendererWindow.setMenu(null);
    rendererWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    rendererWindow.webContents.on('will-navigate', event => {
      event.preventDefault();
    });
    rendererWindow.webContents.on('render-process-gone', () => {
      this.resetWindow(rendererWindow);
    });
    rendererWindow.on('closed', () => {
      if (this.window === rendererWindow) this.window = undefined;
    });

    try {
      if (this.developmentServerUrl) {
        const rendererUrl = new URL('/library-thumbnail.html', this.developmentServerUrl);
        await rendererWindow.loadURL(rendererUrl.href);
      } else {
        await rendererWindow.loadFile(this.productionHtmlPath);
      }
      const isReady = await rendererWindow.webContents.executeJavaScript(
        'typeof window.renderLibraryThumbnail === "function"',
        true,
      );
      if (isReady !== true) throw new Error('Thumbnail renderer did not initialize');
      this.window = rendererWindow;
      return rendererWindow;
    } catch (error) {
      rendererWindow.destroy();
      throw error;
    }
  }

  private resetWindow(rendererWindow: BrowserWindow): void {
    if (!rendererWindow.isDestroyed()) rendererWindow.destroy();
    if (this.window === rendererWindow) this.window = undefined;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
