import { HtmlShareSourceType } from '@shared/htmlShare/constants';
import DOMPurify from 'dompurify';
import React from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

import type { ArtifactFileShareRequest } from './artifactFileSharePolicy';
import {
  getDocxExpectedPageCount,
  repaginateDocx,
  waitForDocxLayout,
} from './renderers/docxPagination';
import { fixPptxData } from './renderers/pptxPreprocess';

const t = (key: string) => i18nService.t(key);

// ---------------------------------------------------------------------------
// Self-contained share page baking.
//
// The enterprise server serves a share as a plain static page (index.html plus
// referenced assets). The renderer has a live DOM and the render libraries, so
// it bakes each artifact type into a single self-contained HTML string here,
// and the main process packages + ships that string to the server.
//
//   - markdown  -> synchronous remark pipeline -> React elements -> static HTML
//   - mermaid   -> mermaid.render into a hidden container -> SVG
//   - svg       -> DOMPurify-sanitized inline SVG
//   - image     -> inline <img> (data URL / remote URL)
//   - document  -> rendered to static markup/images with the same libraries the
//                   in-app preview uses:
//                     docx  -> docx-preview  -> DOM HTML (inline styles)
//                     xlsx  -> SheetJS       -> HTML tables
//                     pdf   -> pdfjs-dist    -> one <img> per page (data URL)
//                     pptx  -> pptx-preview  -> one <img> per slide (data URL)
//                   unknown office types fall back to a placeholder page.
// ---------------------------------------------------------------------------

function normalizeLocalFilePath(filePath: string): string {
  let normalized = filePath.trim();
  if (/^file:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^file:\/\//i, '');
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      // Keep malformed percent sequences unchanged.
    }
  }
  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Emit a warn-level diagnostic when a document bake degrades to the
 * "not available" placeholder. Recoverable (the share still succeeds) but the
 * cause is worth surfacing — otherwise a missing file, a >100 MB file, or an
 * unreadable path is indistinguishable from a genuinely-unsupported type.
 */
function logDocumentBakeFallback(name: string, ext: string, detail: string): void {
  const message = `bakeDocument fell back to placeholder (${ext || 'unknown'} "${name}"): ${detail}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  console.warn(`[ArtifactFileShare] ${message}`);
  try {
    window.electron?.log?.fromRenderer?.('warn', 'ArtifactFileShare', message);
  } catch {
    // Diagnostics must never change the result of a share operation.
  }
}

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function dataUrlToText(dataUrl: string): string {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Read a local file's content as a base64 data URL via the preload bridge. */
async function loadFileDataUrl(filePath: string): Promise<string> {
  const bridge = window.electron?.dialog?.readFileAsDataUrl;
  if (typeof bridge !== 'function') {
    throw new Error(t('artifactShareSourceUnavailable'));
  }
  const result = await bridge(normalizeLocalFilePath(filePath));
  if (!result?.success || !result.dataUrl) {
    throw new Error(result?.error || t('artifactShareSourceUnavailable'));
  }
  return result.dataUrl;
}

/**
 * Resolve the raw text content of a markdown/mermaid/svg artifact. Inline
 * content wins; otherwise read the backing file (the renderer has no `fs`
 * access, so this goes through the data-url bridge and decodes the base64).
 */
async function resolveTextContent(
  artifact: Artifact,
  request: ArtifactFileShareRequest,
): Promise<string> {
  const inline = request.content?.trim() ?? '';
  if (inline) return inline;
  if (artifact.filePath) {
    return dataUrlToText(await loadFileDataUrl(artifact.filePath));
  }
  throw new Error(t('artifactShareSourceUnavailable'));
}

/** Resolve the binary content of a document artifact (data URL inline, or file). */
async function resolveDocumentBuffer(
  artifact: Artifact,
  request: ArtifactFileShareRequest,
): Promise<ArrayBuffer> {
  const inline = request.content?.trim() ?? '';
  if (inline) {
    return dataUrlToArrayBuffer(inline);
  }
  const filePath = request.filePath || artifact.filePath;
  if (filePath) {
    return dataUrlToArrayBuffer(await loadFileDataUrl(filePath));
  }
  throw new Error(t('artifactShareSourceUnavailable'));
}

async function bakeMarkdown(content: string): Promise<string> {
  const { unified } = await import('unified');
  const remarkParse = (await import('remark-parse')).default;
  const remarkGfm = (await import('remark-gfm')).default;
  const remarkMath = (await import('remark-math')).default;
  const remarkRehype = (await import('remark-rehype')).default;
  const { toJsxRuntime } = await import('hast-util-to-jsx-runtime');

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype);
  const tree = processor.runSync(processor.parse(content));
  const element = toJsxRuntime(tree as never, {
    jsx,
    jsxs,
    Fragment: React.Fragment,
    elementAttributeNameCase: 'react',
  });
  return renderToStaticMarkup(element);
}

async function bakeMermaid(content: string): Promise<string> {
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'default',
  });
  const container = document.createElement('div');
  container.setAttribute('data-genwork-mermaid-render-container', 'true');
  container.style.position = 'absolute';
  container.style.left = '0';
  container.style.top = '0';
  container.style.visibility = 'hidden';
  container.style.pointerEvents = 'none';
  document.body.appendChild(container);
  const id = `genwork-bake-mermaid-${Date.now()}`;
  try {
    const { svg } = await mermaid.render(id, content, container);
    return `<div class="diagram">${svg}</div>`;
  } finally {
    container.remove();
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(`i${id}`)?.remove();
  }
}

function bakeSvg(content: string): string {
  const sanitized = DOMPurify.sanitize(content, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
  });
  return `<div class="diagram">${sanitized}</div>`;
}

async function bakeImage(artifact: Artifact, request: ArtifactFileShareRequest): Promise<string> {
  let src = request.content?.trim() ?? '';
  if (!src && artifact.filePath) {
    src = await loadFileDataUrl(artifact.filePath);
  }
  if (!src) {
    return `<div class="empty">${escapeHtml(t('artifactDocumentLoading'))}</div>`;
  }
  return `<figure class="image"><img src="${escapeHtml(src)}" alt="${escapeHtml(request.title)}" /></figure>`;
}

// ---------------------------------------------------------------------------
// Office document baking (docx / xlsx / pdf / pptx).
//
// Each renders into an offscreen container/iframe using the same library the
// in-app preview uses, then serializes the result into self-contained markup so
// the static share page shows the real content, not a placeholder.
// ---------------------------------------------------------------------------

/** docx -> static HTML via docx-preview (content carries inline styles). */
async function bakeDocx(data: ArrayBuffer): Promise<string> {
  const { renderAsync } = await import('docx-preview');

  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.width = '860px';
  host.style.visibility = 'hidden';
  document.body.appendChild(host);
  try {
    const wordDocument = await renderAsync(data, host, undefined, {
      className: 'docx-preview',
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      ignoreWidth: false,
      ignoreHeight: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
    });
    await waitForDocxLayout(host);
    const pagination = repaginateDocx(host, {
      expectedPageCount: getDocxExpectedPageCount(wordDocument),
    });
    void pagination;
    return `<div class="bake-docx">${host.innerHTML}</div>`;
  } finally {
    host.remove();
  }
}

/** xlsx/xls/csv/tsv -> static HTML tables via SheetJS (one per worksheet). */
async function bakeSheet(data: ArrayBuffer, fileName: string): Promise<string> {
  const XLSX = await import('xlsx');
  const ext = getFileExtension(fileName);
  const workbook =
    ext === '.csv' || ext === '.tsv'
      ? XLSX.read(new TextDecoder('utf-8').decode(new Uint8Array(data)), {
          type: 'string',
          FS: ext === '.tsv' ? '\t' : undefined,
        })
      : XLSX.read(new Uint8Array(data), { type: 'array', cellStyles: true });

  const sections = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const table = XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' });
    return `<section class="bake-sheet"><h2>${escapeHtml(name)}</h2>${table}</section>`;
  });
  return `<div class="bake-sheet-wrap">${sections.join('')}</div>`;
}

/** Resolve a pdf.js worker/asset URL the same way the in-app preview does. */
function getPdfJsAssetUrl(assetPath: string): string {
  if (import.meta.env.DEV) {
    return new URL(`/pdfjs/${assetPath}`, window.location.origin).href;
  }
  return new URL(`../pdfjs/${assetPath}`, import.meta.url).href;
}

/** pdf -> one data-URL <img> per page via pdfjs-dist. */
async function bakePdf(data: ArrayBuffer): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url,
  ).href;

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(data),
    cMapUrl: getPdfJsAssetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: getPdfJsAssetUrl('standard_fonts/'),
    disableFontFace: false,
    useSystemFonts: true,
  }).promise;

  const images: string[] = [];
  const targetWidth = 1240; // ~2x A4-ish width for crisp text without huge payloads
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, targetWidth / baseViewport.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    await page.render({ canvasContext: ctx, viewport }).promise;
    images.push(`<img src="${canvas.toDataURL('image/png')}" alt="page ${pageNumber}" />`);
  }
  return `<div class="bake-pages">${images.join('')}</div>`;
}

/**
 * pptx -> one self-contained slide per <div> via pptx-preview (isolated iframe).
 *
 * pptx-preview renders each slide as a DOM subtree with fully inline styles:
 * the wrapper <div> carries its own width/height/overflow:hidden clipping box,
 * and the slide layers are positioned via `transform: scale()` about origin (0,0).
 * Slide images are emitted as self-contained `data:` URLs, so serializing the DOM
 * is faithful on a static page with no runtime. Only <audio>/<video> use blob:
 * URLs (URL.createObjectURL), which do not survive a static page, so those are
 * stripped before serialization.
 */
async function bakePptx(data: ArrayBuffer): Promise<string> {
  const pptxPreview = await import('pptx-preview');
  const fixedData = await fixPptxData(data);
  const renderWidth = 600;

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.left = '-10000px';
  iframe.style.top = '0';
  iframe.style.width = `${renderWidth}px`;
  iframe.style.height = '800px';
  iframe.sandbox = 'allow-scripts allow-same-origin';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    throw new Error(t('artifactDocumentError'));
  }
  doc.open();
  doc.write(
    [
      '<!DOCTYPE html><html><head><meta charset="utf-8" /><style>',
      '*{margin:0;padding:0;box-sizing:border-box;}',
      'html,body{background:#f3f4f6;}',
      '#bake-host .pptx-preview-wrapper{background:transparent !important;}',
      '</style></head><body><div id="bake-host"></div></body></html>',
    ].join(''),
  );
  doc.close();

  const host = doc.getElementById('bake-host');
  if (!host) {
    iframe.remove();
    throw new Error(t('artifactDocumentError'));
  }

  let previewer: Awaited<ReturnType<typeof import('pptx-preview').init>> | null = null;
  try {
    previewer = pptxPreview.init(host, { width: renderWidth, mode: 'list' });
    // `preview` resolves after every slide is rendered synchronously (list mode),
    // and slide images are already self-contained data: URLs, so the DOM is ready.
    await previewer.preview(fixedData);

    // Each slide is a `.pptx-preview-slide-wrapper` (distinct from the wrapper's
    // pagination/next controls). Strip blob-backed inline media first.
    host.querySelectorAll('audio, video').forEach((el) => el.remove());

    const slides = Array.from(host.querySelectorAll('.pptx-preview-slide-wrapper'));
    if (slides.length === 0) {
      throw new Error(t('artifactDocumentError'));
    }

    // outerHTML (not innerHTML) so the wrapper's own inline width/height and
    // overflow clipping box are preserved.
    const slideHtml = slides.map((slide) => slide.outerHTML).join('');
    return `<div class="bake-pages">${slideHtml}</div>`;
  } finally {
    previewer?.destroy?.();
    iframe.remove();
  }
}

function bakeDocumentPlaceholder(artifact: Artifact, request: ArtifactFileShareRequest): string {
  const name = artifact.fileName || artifact.title || request.title || 'document';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  return [
    '<div class="doc-note">',
    `<div class="doc-note-icon">📄</div>`,
    `<h1>${escapeHtml(name)}</h1>`,
    ext ? `<p class="doc-note-ext">${escapeHtml(ext.toUpperCase())}</p>` : '',
    `<p class="doc-note-hint">${escapeHtml(t('artifactFileShareDocumentNotBakedHint'))}</p>`,
    '</div>',
  ].join('');
}

/** Render a document artifact to static markup, or a placeholder if unsupported. */
async function bakeDocument(artifact: Artifact, request: ArtifactFileShareRequest): Promise<string> {
  const name = artifact.fileName || request.fileName || artifact.title || request.title || 'document';
  const ext = getFileExtension(name);

  let data: ArrayBuffer;
  try {
    data = await resolveDocumentBuffer(artifact, request);
  } catch (error) {
    logDocumentBakeFallback(
      name,
      ext,
      `could not resolve document content (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return bakeDocumentPlaceholder(artifact, request);
  }

  switch (ext) {
    case '.docx':
      return bakeDocx(data);
    case '.xlsx':
    case '.xls':
    case '.csv':
    case '.tsv':
      return bakeSheet(data, name);
    case '.pdf':
      return bakePdf(data);
    case '.pptx':
      return bakePptx(data);
    default:
      logDocumentBakeFallback(name, ext, 'extension is not previewable (docx/xlsx/pptx/pdf/csv/tsv)');
      return bakeDocumentPlaceholder(artifact, request);
  }
}

function renderPage(title: string, bodyHtml: string): string {
  const safeTitle = escapeHtml(title || t('htmlShare'));
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${safeTitle}</title>`,
    '<style>',
    'html,body{margin:0;padding:0;background:#f5f6f8;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6;}',
    '.page{max-width:860px;margin:0 auto;padding:32px 24px 64px;}',
    '.page>h1.title{font-size:1.5rem;font-weight:600;margin:0 0 20px;color:#1f2328;}',
    'article.doc{background:#fff;border-radius:12px;padding:32px 36px;box-shadow:0 1px 3px rgba(0,0,0,.08);}',
    'article.doc h1{font-size:1.6rem;font-weight:600;margin:1.2em 0 .5em;}',
    'article.doc h1:first-child{margin-top:0;}',
    'article.doc h2{font-size:1.35rem;font-weight:600;margin:1.1em 0 .4em;}',
    'article.doc h3{font-size:1.15rem;font-weight:600;margin:1em 0 .4em;}',
    'article.doc h4{font-size:1.05rem;font-weight:600;margin:1em 0 .4em;}',
    'article.doc p{margin:.6em 0;}',
    'article.doc ul,article.doc ol{margin:.6em 0;padding-left:1.4em;}',
    'article.doc li{margin:.25em 0;}',
    'article.doc a{color:#2563eb;text-decoration:underline;}',
    'article.doc blockquote{margin:.8em 0;padding:.4em 1em;border-left:3px solid #d0d7de;color:#57606a;}',
    'article.doc code{background:#eff1f3;padding:.15em .4em;border-radius:4px;font-size:.9em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
    'article.doc pre{background:#f6f8fa;padding:14px;border-radius:8px;overflow:auto;}',
    'article.doc pre code{background:none;padding:0;}',
    'article.doc table{border-collapse:collapse;margin:.8em 0;width:100%;max-width:100%;}',
    'article.doc th,article.doc td{border:1px solid #d0d7de;padding:.5em .8em;text-align:left;}',
    'article.doc thead{background:#f6f8fa;}',
    'article.doc img{max-width:100%;border-radius:8px;}',
    '.diagram{display:flex;justify-content:center;align-items:center;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08);}',
    '.diagram svg{max-width:100%;height:auto;}',
    'figure.image{margin:0;background:#fff;border-radius:12px;padding:24px;display:flex;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.08);}',
    'figure.image img{max-width:100%;max-height:78vh;object-fit:contain;}',
    '.doc-note{background:#fff;border-radius:12px;padding:48px 32px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08);}',
    '.doc-note-icon{font-size:3rem;margin-bottom:12px;}',
    '.doc-note h1{font-size:1.3rem;font-weight:600;margin:0 0 4px;}',
    '.doc-note-ext{color:#8b949e;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;margin:0 0 16px;}',
    '.doc-note-hint{color:#57606a;font-size:.9rem;margin:0;}',
    '.empty{background:#fff;border-radius:12px;padding:48px;text-align:center;color:#8b949e;}',
    '.bake-docx{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08);}',
    '.bake-docx .docx-preview-wrapper{background:transparent !important;display:flex !important;flex-direction:column !important;align-items:center !important;width:100% !important;min-width:100%;}',
    '.bake-docx section.docx-preview{background:#fff !important;color:#000;box-shadow:0 2px 8px rgba(0,0,0,.12);margin:0 auto 16px !important;border-radius:2px;box-sizing:border-box;}',
    '.bake-docx section.docx-preview:last-child{margin-bottom:0;}',
    '.bake-docx section.docx-preview table{width:auto;margin:0;}',
    '.bake-docx section.docx-preview th,.bake-docx section.docx-preview td{padding:0;border-color:currentColor;}',
    '.bake-docx section.docx-preview th{background-color:transparent;opacity:1;}',
    '.bake-sheet-wrap{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08);}',
    '.bake-sheet h2{font-size:1.05rem;font-weight:600;margin:16px 0 8px;color:#1f2328;}',
    '.bake-sheet h2:first-child{margin-top:0;}',
    '.bake-sheet .table-container{overflow-x:auto;}',
    '.bake-sheet table{border-collapse:collapse;max-width:100%;margin:0 0 16px;font-size:.9rem;}',
    '.bake-sheet table:last-child{margin-bottom:0;}',
    '.bake-sheet th,.bake-sheet td{border:1px solid #d0d7de;padding:.4em .7em;text-align:left;}',
    '.bake-sheet th{background:#f6f8fa;font-weight:600;}',
    '.bake-pages{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08);}',
    '.bake-pages img{display:block;max-width:100%;height:auto;margin:0 auto 16px;border-radius:2px;box-shadow:0 2px 8px rgba(0,0,0,.12);}',
    '.bake-pages img:last-child{margin-bottom:0;}',
    // PPTX slides are serialized as the wrapper <div> (inline width/height/overflow),
    // so only add a frame and cap the width for narrow viewports.
    '.bake-pages .pptx-preview-slide-wrapper{max-width:100%;border-radius:2px;box-shadow:0 2px 8px rgba(0,0,0,.12);}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="page">',
    `<h1 class="title">${safeTitle}</h1>`,
    bodyHtml,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}

export interface BakeArtifactSharePageInput {
  artifact: Artifact;
  request: ArtifactFileShareRequest;
}

/**
 * Bake an artifact into a fully self-contained `index.html` string for
 * uploading to the enterprise share server.
 */
export async function bakeArtifactSharePage({
  artifact,
  request,
}: BakeArtifactSharePageInput): Promise<string> {
  let body: string;
  switch (request.sourceType) {
    case HtmlShareSourceType.MarkdownFile: {
      body = `<article class="doc">${await bakeMarkdown(await resolveTextContent(artifact, request))}</article>`;
      break;
    }
    case HtmlShareSourceType.MermaidFile: {
      body = await bakeMermaid(await resolveTextContent(artifact, request));
      break;
    }
    case HtmlShareSourceType.SvgFile: {
      body = bakeSvg(await resolveTextContent(artifact, request));
      break;
    }
    case HtmlShareSourceType.ImageFile: {
      body = await bakeImage(artifact, request);
      break;
    }
    case HtmlShareSourceType.DocumentFile:
    default: {
      body = await bakeDocument(artifact, request);
      break;
    }
  }
  return renderPage(request.title, body);
}
