import DOMPurify from 'dompurify';

import { LibraryArtifactType } from '../../shared/library/constants';
import type {
  LibraryThumbnailRenderRequest,
  LibraryThumbnailRenderResult,
} from '../../shared/library/thumbnail';

declare global {
  interface Window {
    renderLibraryThumbnail: (
      request: LibraryThumbnailRenderRequest,
    ) => Promise<LibraryThumbnailRenderResult>;
  }
}

const root = document.getElementById('library-thumbnail-root');
if (!root) throw new Error('Missing thumbnail root');

let activeCleanup: (() => void) | undefined;

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const VIDEO_MIME_TYPES: Record<string, string> = {
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => (
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
);

const nextFrame = (): Promise<void> => new Promise(resolve => {
  requestAnimationFrame(() => resolve());
});

const waitForStableLayout = async (): Promise<void> => {
  if (document.fonts?.ready) await document.fonts.ready;
  await nextFrame();
  await nextFrame();
};

const configureDocument = (request: LibraryThumbnailRenderRequest): void => {
  document.documentElement.style.width = `${request.width}px`;
  document.documentElement.style.height = `${request.height}px`;
  document.body.style.width = `${request.width}px`;
  document.body.style.height = `${request.height}px`;
  root.style.width = `${request.width}px`;
  root.style.height = `${request.height}px`;
};

const resetRoot = (): void => {
  activeCleanup?.();
  activeCleanup = undefined;
  root.replaceChildren();
  root.removeAttribute('class');
  root.removeAttribute('style');
};

const loadElement = (element: HTMLImageElement | HTMLVideoElement): Promise<void> => new Promise(
  (resolve, reject) => {
    const cleanup = () => {
      element.removeEventListener('load', handleLoad);
      element.removeEventListener('loadeddata', handleLoad);
      element.removeEventListener('error', handleError);
    };
    const handleLoad = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error('Media could not be decoded'));
    };
    element.addEventListener('load', handleLoad, { once: true });
    element.addEventListener('loadeddata', handleLoad, { once: true });
    element.addEventListener('error', handleError, { once: true });
  },
);

const fitElement = (
  element: HTMLElement,
  width: number,
  height: number,
  padding = 12,
): void => {
  element.style.transform = 'none';
  element.style.transformOrigin = 'top left';
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const availableWidth = Math.max(1, width - (padding * 2));
  const availableHeight = Math.max(1, height - (padding * 2));
  const scale = Math.min(availableWidth / bounds.width, availableHeight / bounds.height, 1);
  element.style.position = 'absolute';
  element.style.left = `${Math.max(padding, (width - (bounds.width * scale)) / 2)}px`;
  element.style.top = `${Math.max(padding, (height - (bounds.height * scale)) / 2)}px`;
  element.style.margin = '0';
  element.style.transform = `scale(${scale})`;
};

const renderImage = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<void> => {
  const blob = new Blob([toArrayBuffer(bytes)], {
    type: IMAGE_MIME_TYPES[request.extension] || 'application/octet-stream',
  });
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  image.alt = '';
  image.decoding = 'async';
  image.src = objectUrl;
  image.className = 'thumbnail-media';
  root.appendChild(image);
  activeCleanup = () => URL.revokeObjectURL(objectUrl);
  await loadElement(image);
};

const renderVideo = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<void> => {
  const blob = new Blob([toArrayBuffer(bytes)], {
    type: VIDEO_MIME_TYPES[request.extension] || 'application/octet-stream',
  });
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = objectUrl;
  activeCleanup = () => URL.revokeObjectURL(objectUrl);
  await loadElement(video);

  const targetTime = Number.isFinite(video.duration) && video.duration > 0
    ? Math.min(Math.max(video.duration * 0.1, 0.1), 1)
    : 0;
  if (targetTime > 0) {
    await new Promise<void>(resolve => {
      const timer = window.setTimeout(resolve, 1_500);
      video.addEventListener('seeked', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
      video.currentTime = targetTime;
    });
  }

  const canvas = document.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  const context = canvas.getContext('2d');
  if (!context || video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new Error('Video frame is unavailable');
  }
  context.fillStyle = '#111318';
  context.fillRect(0, 0, request.width, request.height);
  const scale = Math.min(request.width / video.videoWidth, request.height / video.videoHeight);
  const drawWidth = video.videoWidth * scale;
  const drawHeight = video.videoHeight * scale;
  context.drawImage(
    video,
    (request.width - drawWidth) / 2,
    (request.height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  root.appendChild(canvas);
};

const renderPdf = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<void> => {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).href;
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    disableFontFace: false,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  activeCleanup = () => {
    void pdf.destroy();
  };
  const page = await pdf.getPage(1);
  const initialViewport = page.getViewport({ scale: 1 });
  const padding = 10;
  const scale = Math.min(
    (request.width - (padding * 2)) / initialViewport.width,
    (request.height - (padding * 2)) / initialViewport.height,
  );
  const viewport = page.getViewport({ scale });
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  canvas.style.position = 'absolute';
  canvas.style.left = `${Math.floor((request.width - viewport.width) / 2)}px`;
  canvas.style.top = `${Math.floor((request.height - viewport.height) / 2)}px`;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('PDF canvas is unavailable');
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  root.appendChild(canvas);
  await page.render({ canvasContext: context, viewport }).promise;
};

const renderDocx = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<void> => {
  const { renderAsync } = await import('docx-preview');
  root.className = 'thumbnail-document-root';
  await renderAsync(toArrayBuffer(bytes), root, undefined, {
    className: 'thumbnail-docx',
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderHeaders: true,
    renderFooters: true,
  });
  await waitForStableLayout();
  const pages = Array.from(root.querySelectorAll<HTMLElement>('section.thumbnail-docx'));
  pages.slice(1).forEach(page => { page.style.display = 'none'; });
  const page = pages[0] || root.firstElementChild as HTMLElement | null;
  if (!page) throw new Error('DOCX page is unavailable');
  fitElement(page, request.width, request.height, 8);
};

const renderSpreadsheet = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<void> => {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(toArrayBuffer(bytes), { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;
  if (!worksheet) throw new Error('Spreadsheet is empty');

  const table = document.createElement('table');
  table.className = 'thumbnail-sheet';
  const range = worksheet['!ref']
    ? XLSX.utils.decode_range(worksheet['!ref'])
    : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  const maxRow = Math.min(range.e.r, range.s.r + 17);
  const maxColumn = Math.min(range.e.c, range.s.c + 9);
  for (let rowIndex = range.s.r; rowIndex <= maxRow; rowIndex += 1) {
    const row = document.createElement('tr');
    for (let columnIndex = range.s.c; columnIndex <= maxColumn; columnIndex += 1) {
      const cell = document.createElement(rowIndex === range.s.r ? 'th' : 'td');
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const value = worksheet[address];
      cell.textContent = value?.w ?? (value?.v === undefined ? '' : String(value.v));
      row.appendChild(cell);
    }
    table.appendChild(row);
  }
  root.appendChild(table);
  await nextFrame();
  fitElement(table, request.width, request.height, 8);
};

const renderPptx = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<void> => {
  const pptxPreview = await import('pptx-preview');
  const previewer = pptxPreview.init(root, { width: 640, mode: 'list' });
  activeCleanup = () => previewer.destroy?.();
  await previewer.preview(toArrayBuffer(bytes));
  await waitForStableLayout();
  const slides = Array.from(root.querySelectorAll<HTMLElement>('.pptx-preview-wrapper > div'));
  slides.slice(1).forEach(slide => { slide.style.display = 'none'; });
  const slide = slides[0] || root.firstElementChild as HTMLElement | null;
  if (!slide) throw new Error('PPTX slide is unavailable');
  fitElement(slide, request.width, request.height, 4);
};

const renderHtml = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<void> => {
  const source = new TextDecoder('utf-8').decode(bytes);
  const sanitized = DOMPurify.sanitize(source, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
  });
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', '');
  iframe.srcdoc = sanitized;
  iframe.className = 'thumbnail-html-frame';
  iframe.style.width = `${request.width * 2}px`;
  iframe.style.height = `${request.height * 2}px`;
  iframe.style.transform = 'scale(0.5)';
  root.appendChild(iframe);
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('HTML preview timed out')), 3_000);
    iframe.addEventListener('load', () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
};

const renderMermaid = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<void> => {
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'neutral',
  });
  const source = new TextDecoder('utf-8').decode(bytes);
  const renderId = `library-thumbnail-${Date.now()}`;
  const { svg } = await mermaid.render(renderId, source);
  const surface = document.createElement('div');
  surface.className = 'thumbnail-vector';
  surface.innerHTML = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
  root.appendChild(surface);
  await nextFrame();
  fitElement(surface, request.width, request.height, 12);
};

const renderText = async (
  request: LibraryThumbnailRenderRequest,
  bytes: Uint8Array,
): Promise<void> => {
  const previewBytes = bytes.subarray(0, 256 * 1024);
  const source = new TextDecoder('utf-8').decode(previewBytes);
  const pre = document.createElement('pre');
  pre.className = request.artifactType === LibraryArtifactType.Markdown
    ? 'thumbnail-text thumbnail-markdown'
    : 'thumbnail-text';
  pre.textContent = source;
  root.appendChild(pre);
};

const renderRequest = async (request: LibraryThumbnailRenderRequest): Promise<void> => {
  const bytes = decodeBase64(request.contentBase64);
  if (request.artifactType === LibraryArtifactType.Image
    || request.artifactType === LibraryArtifactType.Svg) {
    await renderImage(request, bytes);
    return;
  }
  if (request.artifactType === LibraryArtifactType.Video) {
    await renderVideo(request, bytes);
    return;
  }
  if (request.artifactType === LibraryArtifactType.Html) {
    await renderHtml(request, bytes);
    return;
  }
  if (request.artifactType === LibraryArtifactType.Mermaid) {
    await renderMermaid(request, bytes);
    return;
  }
  if (request.artifactType === LibraryArtifactType.Markdown
    || request.artifactType === LibraryArtifactType.Text
    || request.artifactType === LibraryArtifactType.Code) {
    await renderText(request, bytes);
    return;
  }
  if (request.extension === '.pdf') {
    await renderPdf(request, bytes);
    return;
  }
  if (request.extension === '.docx') {
    await renderDocx(request, bytes);
    return;
  }
  if (request.extension === '.pptx') {
    await renderPptx(request, bytes);
    return;
  }
  if (['.xls', '.xlsx', '.csv', '.tsv'].includes(request.extension)) {
    await renderSpreadsheet(request, bytes);
    return;
  }
  throw new Error('Unsupported document thumbnail format');
};

window.renderLibraryThumbnail = async request => {
  resetRoot();
  configureDocument(request);
  try {
    await renderRequest(request);
    await waitForStableLayout();
    return { success: true };
  } catch (error) {
    resetRoot();
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Thumbnail rendering failed',
    };
  }
};

document.documentElement.className = 'library-thumbnail-page';
document.body.className = 'library-thumbnail-page';
const style = document.createElement('style');
style.textContent = `
  * { box-sizing: border-box; }
  html.library-thumbnail-page,
  body.library-thumbnail-page {
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: #f5f6f8;
    color: #20242c;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  #library-thumbnail-root {
    position: relative;
    overflow: hidden;
    background: #f5f6f8;
  }
  .thumbnail-media {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center;
  }
  #library-thumbnail-root > canvas {
    display: block;
  }
  .thumbnail-document-root {
    background: #eceff3 !important;
  }
  .thumbnail-document-root .docx-wrapper {
    padding: 0 !important;
    background: transparent !important;
  }
  .thumbnail-document-root section.thumbnail-docx {
    box-shadow: 0 2px 10px rgba(24, 31, 43, 0.18);
  }
  .thumbnail-sheet {
    border-collapse: collapse;
    table-layout: fixed;
    min-width: 620px;
    background: #fff;
    color: #20242c;
    font-size: 14px;
    line-height: 1.3;
    box-shadow: 0 2px 10px rgba(24, 31, 43, 0.14);
  }
  .thumbnail-sheet th,
  .thumbnail-sheet td {
    width: 110px;
    max-width: 110px;
    height: 28px;
    padding: 4px 7px;
    overflow: hidden;
    border: 1px solid #dfe3e8;
    text-align: left;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .thumbnail-sheet th {
    background: #e8eef9;
    color: #28466f;
    font-weight: 600;
  }
  .thumbnail-html-frame {
    position: absolute;
    inset: 0 auto auto 0;
    border: 0;
    background: #fff;
    transform-origin: top left;
  }
  .thumbnail-vector {
    display: inline-block;
    min-width: 160px;
    min-height: 100px;
  }
  .thumbnail-vector svg {
    display: block;
    max-width: none !important;
    height: auto;
  }
  .thumbnail-text {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 22px 26px;
    overflow: hidden;
    background: #fff;
    color: #303641;
    font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .thumbnail-markdown {
    color: #252a32;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 15px;
    line-height: 1.65;
  }
`;
document.head.appendChild(style);
