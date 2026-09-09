import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';
import { openLocalPathWithToast } from '@/utils/localFileActions';

import { getDocxExpectedPageCount, repaginateDocx, waitForDocxLayout } from './docxPagination';
import {
  type OfficePreviewZoomControlsConfig,
  useRegisterOfficePreviewZoomControls,
} from './OfficePreviewActionsContext';
import { useOfficePreviewZoom } from './OfficeZoomControls';
import { fixPptxData } from './pptxPreprocess';
import { SheetRenderer } from './sheet/SheetRenderer';

const t = (key: string) => i18nService.t(key);

function getExtension(name: string): string {
  const lastDot = name.lastIndexOf('.');
  return lastDot === -1 ? '' : name.slice(lastDot).toLowerCase();
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function normalizeLocalFilePath(filePath: string): string {
  let normalized = filePath;
  if (normalized.startsWith('file:///')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file://')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file:/')) {
    normalized = normalized.slice(5);
  }

  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }

  return normalized;
}

function useFileContent(artifact: Artifact): { data: ArrayBuffer | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (artifact.content) {
        try {
          const buf = dataUrlToArrayBuffer(artifact.content);
          if (!cancelled) { setData(buf); setLoading(false); }
        } catch (e) {
          if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
        }
        return;
      }

      if (artifact.filePath && window.electron?.dialog?.readFileAsDataUrl) {
        const filePath = normalizeLocalFilePath(artifact.filePath);
        try {
          const result = await window.electron.dialog.readFileAsDataUrl(filePath);
          if (cancelled) return;
          if (result?.success && result.dataUrl) {
            const buf = dataUrlToArrayBuffer(result.dataUrl);
            setData(buf);
          } else {
            setError(result?.error || 'Failed to read file');
          }
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        }
        setLoading(false);
        return;
      }

      setError('No content available');
      setLoading(false);
    };

    load();
    return () => { cancelled = true; };
  }, [artifact.content, artifact.filePath]);

  return { data, loading, error };
}

// --- Docx Sub-Renderer (docx-preview, high-fidelity rendering) ---

const DOCX_BASE_WIDTH = 794; // A4 width in px at 96dpi

const DocxSubRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const { data, loading, error: loadError } = useFileContent(artifact);
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const { zoomFactor, zoomIn, zoomOut, resetZoom, handleWheelZoom } = useOfficePreviewZoom();
  const zoomControls = useMemo<OfficePreviewZoomControlsConfig | null>(() => {
    if (!rendered || pageCount <= 0) return null;
    return {
      zoomFactor,
      onZoomOut: zoomOut,
      onZoomIn: zoomIn,
      onResetZoom: resetZoom,
    };
  }, [pageCount, rendered, resetZoom, zoomFactor, zoomIn, zoomOut]);

  useRegisterOfficePreviewZoomControls(zoomControls);

  useEffect(() => {
    if (loadError) { setError(loadError); return; }
    if (!data || !containerRef.current) return;

    let cancelled = false;

    const render = async () => {
      try {
        const { renderAsync } = await import('docx-preview');
        if (cancelled || !containerRef.current) return;

        setError(null);
        setRendered(false);
        setPageCount(0);
        containerRef.current.innerHTML = '';
        const wordDocument = await renderAsync(data, containerRef.current, undefined, {
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

        await waitForDocxLayout(containerRef.current);
        if (cancelled || !containerRef.current) return;

        const paginationResult = repaginateDocx(containerRef.current, {
          expectedPageCount: getDocxExpectedPageCount(wordDocument),
        });
        const renderedPageCount = supplementDocxPageNumbers(containerRef.current) || paginationResult.pageCount;
        if (!cancelled) {
          setPageCount(renderedPageCount);
          setRendered(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    render();
    return () => { cancelled = true; };
  }, [data, loadError]);

  // Adaptive zoom based on container width
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !rendered) return;

    const updateZoom = () => {
      const containerWidth = wrapper.clientWidth - 48; // account for document gutter
      const fitScale = containerWidth < DOCX_BASE_WIDTH ? containerWidth / DOCX_BASE_WIDTH : 1;
      if (containerRef.current) {
        containerRef.current.style.zoom = String(fitScale * zoomFactor);
      }
    };

    const ro = new ResizeObserver(updateZoom);
    ro.observe(wrapper);
    updateZoom();

    return () => ro.disconnect();
  }, [rendered, zoomFactor]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm p-4">
        {t('artifactDocumentError')}: {error}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        {t('artifactDocumentLoading')}
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col overflow-hidden bg-[#f5f5f5]">
      {rendered && pageCount > 0 && (
        <div className="shrink-0 border-b border-[#e0e0e0] px-3 py-1.5 text-xs text-[#999]">
          <span>{pageCount} {t('artifactPdfPageCount')}</span>
        </div>
      )}
      <div ref={wrapperRef} className="flex-1 overflow-auto" onWheel={handleWheelZoom}>
        <div ref={containerRef} className="docx-container" />
      </div>
      <style>{`
        .docx-container {
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          align-items: center;
          min-width: 100%;
          padding: 24px;
        }
        .docx-container .docx-preview-wrapper {
          background: transparent !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          width: max-content !important;
          min-width: 100% !important;
          font-family: initial !important;
          font-size: initial !important;
          line-height: normal !important;
          letter-spacing: normal !important;
        }
        .docx-container section.docx-preview {
          background: white !important;
          color: #000;
          box-shadow: 0 2px 8px rgba(0,0,0,0.12);
          margin: 0 auto 16px !important;
          border-radius: 2px;
          box-sizing: border-box;
          font-family: initial !important;
          font-size: initial !important;
          line-height: normal !important;
          letter-spacing: normal !important;
        }
        .docx-container .docx-preview table {
          width: auto;
          margin: 0;
        }
        .docx-container .docx-preview th,
        .docx-container .docx-preview td {
          padding: 0;
          border-color: currentColor;
        }
        .docx-container .docx-preview th {
          background-color: transparent;
          opacity: 1;
        }
      `}</style>
    </div>
  );
};

function supplementDocxPageNumbers(container: HTMLElement): number {
  const pages = Array.from(container.querySelectorAll<HTMLElement>('section.docx-preview'));
  const totalPages = pages.length;

  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    const scopes = Array.from(page.querySelectorAll<HTMLElement>('header, footer'));

    scopes.forEach(scope => {
      const textBlocks = Array.from(scope.querySelectorAll<HTMLElement>('p'));
      const targets = textBlocks.length > 0 ? textBlocks : [scope];

      targets.forEach(target => {
        const originalText = target.textContent || '';
        const supplementedText = supplementDocxPageNumberText(originalText, pageNumber, totalPages);
        if (supplementedText !== originalText) {
          target.textContent = supplementedText;
        }
      });
    });
  });

  return totalPages;
}

function supplementDocxPageNumberText(text: string, pageNumber: number, totalPages: number): string {
  let result = text;
  result = result.replace(/第\s*页/g, `第 ${pageNumber} 页`);
  result = result.replace(/共\s*页/g, `共 ${totalPages} 页`);

  if (/^\s*Page\s*of\s*$/i.test(result)) {
    return result.replace(/Page\s*of/i, `Page ${pageNumber} of ${totalPages}`);
  }

  if (/^\s*Page\s*$/i.test(result)) {
    return result.replace(/Page/i, `Page ${pageNumber}`);
  }

  return result;
}

// --- Pdf Sub-Renderer (pdfjs-dist, lazy page rendering) ---

const PDF_PAGE_GAP = 16;

function getPdfJsAssetUrl(assetPath: string): string {
  if (import.meta.env.DEV) {
    return new URL(`/pdfjs/${assetPath}`, window.location.origin).href;
  }

  return new URL(`../pdfjs/${assetPath}`, import.meta.url).href;
}

const PdfCanvasSubRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const { data, loading, error: loadError } = useFileContent(artifact);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [renderWidth, setRenderWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const { zoomFactor, zoomIn, zoomOut, resetZoom, handleWheelZoom } = useOfficePreviewZoom();
  const zoomControls = useMemo<OfficePreviewZoomControlsConfig | null>(() => {
    if (!pdfDoc || pageCount <= 0) return null;
    return {
      zoomFactor,
      onZoomOut: zoomOut,
      onZoomIn: zoomIn,
      onResetZoom: resetZoom,
    };
  }, [pageCount, pdfDoc, resetZoom, zoomFactor, zoomIn, zoomOut]);

  useRegisterOfficePreviewZoomControls(zoomControls);

  // Measure container width once it's laid out (debounced)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const measure = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const w = container.clientWidth - 48;
        if (w > 0 && Math.abs(w - renderWidth) > 5) setRenderWidth(w);
      }, 200);
    };

    // Initial measure without debounce
    const w = container.clientWidth - 48;
    if (w > 0) setRenderWidth(w);

    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [renderWidth, pdfDoc]);

  // Load PDF document
  useEffect(() => {
    if (loadError) { setError(loadError); return; }
    if (!data) return;

    let cancelled = false;

    const loadPdf = async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

        const pdf = await pdfjsLib.getDocument({
          data: new Uint8Array(data),
          cMapUrl: getPdfJsAssetUrl('cmaps/'),
          cMapPacked: true,
          standardFontDataUrl: getPdfJsAssetUrl('standard_fonts/'),
          disableFontFace: false,
          useSystemFonts: true,
        }).promise;
        if (cancelled) return;

        setPdfDoc(pdf);
        setPageCount(pdf.numPages);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    loadPdf();
    return () => { cancelled = true; };
  }, [data, loadError]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm p-4">
        {t('artifactDocumentError')}: {error}
      </div>
    );
  }

  if (loading || !pdfDoc) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        {t('artifactDocumentLoading')}
      </div>
    );
  }

  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  const zoomedRenderWidth = Math.max(120, Math.floor(renderWidth * zoomFactor));

  return (
    <div className="relative h-full flex flex-col overflow-hidden bg-[#f5f5f5]">
      <div className="shrink-0 border-b border-[#e0e0e0] px-3 py-1.5 text-xs text-[#999]">
        <span>{pageCount} {t('artifactPdfPageCount')}</span>
      </div>
      <div ref={containerRef} className="flex-1 overflow-auto p-6" onWheel={handleWheelZoom}>
        {renderWidth > 0 && pages.map(pageNum => (
          <div key={pageNum} style={{ marginBottom: PDF_PAGE_GAP }}>
            <PdfPageCanvas pdfDoc={pdfDoc} pageNumber={pageNum} width={zoomedRenderWidth} />
          </div>
        ))}
      </div>
    </div>
  );
};

const PdfPageCanvas: React.FC<{
  pdfDoc: unknown;
  pageNumber: number;
  width: number;
}> = ({ pdfDoc, pageNumber, width }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfDoc || width <= 0) return;

    // Cancel any in-progress render on this canvas
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    let cancelled = false;

    const renderPage = async () => {
      try {
        const page = await (pdfDoc as any).getPage(pageNumber);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: 1 });
        const scale = width / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(scaledViewport.width * dpr);
        canvas.height = Math.floor(scaledViewport.height * dpr);
        canvas.style.width = `${Math.floor(scaledViewport.width)}px`;
        canvas.style.height = `${Math.floor(scaledViewport.height)}px`;
        setHeight(Math.floor(scaledViewport.height));

        const ctx = canvas.getContext('2d');
        if (!ctx || cancelled) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const renderTask = page.render({ canvasContext: ctx, viewport: scaledViewport });
        renderTaskRef.current = renderTask;

        await renderTask.promise;
        renderTaskRef.current = null;
      } catch (e) {
        // Ignore cancellation errors
        if (e instanceof Error && e.message.includes('Rendering cancelled')) return;
      }
    };

    renderPage();
    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [pdfDoc, pageNumber, width]);

  return (
    <canvas
      ref={canvasRef}
      className="mx-auto block bg-white shadow-md rounded-sm"
      style={{ minHeight: height || 200 }}
    />
  );
};

const NativePdfSubRenderer: React.FC<{ artifact: Artifact; onFallback: () => void }> = ({ artifact, onFallback }) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useRegisterOfficePreviewZoomControls(null);

  useEffect(() => {
    if (!artifact.filePath || !window.electron?.artifact?.createPreviewSession) {
      onFallback();
      return;
    }

    let cancelled = false;
    let sessionId: string | null = null;

    const createSession = async () => {
      try {
        setLoading(true);
        const filePath = normalizeLocalFilePath(artifact.filePath!);
        const result = await window.electron?.artifact?.createPreviewSession(filePath);
        if (cancelled) {
          if (result?.success && result.sessionId) {
            void window.electron?.artifact?.destroyPreviewSession(result.sessionId);
          }
          return;
        }

        if (!result?.success || !result.url || !result.sessionId) {
          throw new Error(result?.error || t('artifactDocumentError'));
        }

        sessionId = result.sessionId;
        setPreviewUrl(`${result.url}#toolbar=0&navpanes=0`);
        setLoading(false);
      } catch {
        if (!cancelled) {
          onFallback();
        }
      }
    };

    createSession();

    return () => {
      cancelled = true;
      if (sessionId) {
        void window.electron?.artifact?.destroyPreviewSession(sessionId);
      }
    };
  }, [artifact.contentVersion, artifact.filePath, onFallback]);

  return (
    <div className="relative h-full flex flex-col overflow-hidden bg-[#f5f5f5]">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">
          {t('artifactDocumentLoading')}
        </div>
      )}
      {previewUrl && (
        <iframe
          src={previewUrl}
          className="w-full h-full border-0"
          title={artifact.title || artifact.fileName || t('artifactDocumentPreviewTitle')}
          onError={onFallback}
        />
      )}
    </div>
  );
};

const PdfSubRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const [useCanvasFallback, setUseCanvasFallback] = useState(false);

  useEffect(() => {
    setUseCanvasFallback(false);
  }, [artifact.contentVersion, artifact.filePath]);

  const handleFallback = useCallback(() => {
    setUseCanvasFallback(true);
  }, []);

  if (!artifact.filePath || artifact.content || useCanvasFallback) {
    return <PdfCanvasSubRenderer artifact={artifact} />;
  }

  return <NativePdfSubRenderer artifact={artifact} onFallback={handleFallback} />;
};

// --- Pptx Sub-Renderer ---

const LegacyPptxSubRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const { data, loading, error: loadError } = useFileContent(artifact);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mainPreviewerRef = useRef<{ slideCount?: number; destroy?: () => void } | null>(null);
  const thumbnailPreviewerRef = useRef<{ slideCount?: number; destroy?: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const [slideCount, setSlideCount] = useState(0);
  const [effectiveZoomFactor, setEffectiveZoomFactor] = useState(1);
  const { zoomFactor, zoomIn, zoomOut, resetZoom, handleWheelZoom, handleNativeWheelZoom } = useOfficePreviewZoom();
  const zoomControls = useMemo<OfficePreviewZoomControlsConfig | null>(() => {
    if (slideCount <= 0) return null;
    return {
      zoomFactor,
      displayZoomFactor: effectiveZoomFactor,
      onZoomOut: zoomOut,
      onZoomIn: zoomIn,
      onResetZoom: resetZoom,
    };
  }, [effectiveZoomFactor, resetZoom, slideCount, zoomFactor, zoomIn, zoomOut]);

  useRegisterOfficePreviewZoomControls(zoomControls);

  const PPTX_RENDER_WIDTH = 600;
  const PPTX_THUMBNAIL_WIDTH = 150;
  const PPTX_AUTO_FIT_USAGE = 0.86;
  const PPTX_MAX_AUTO_FIT_SCALE = 1.7;

  useEffect(() => {
    if (loadError) { setError(loadError); return; }
    if (!data) return;

    let cancelled = false;

    const render = async () => {
      try {
        const pptxPreview = await import('pptx-preview');
        const iframe = iframeRef.current;
        const iframeDoc = iframe?.contentDocument || iframe?.contentWindow?.document;
        if (cancelled || !iframeDoc) return;

        // Fix the PPTX data before passing to pptx-preview
        const fixedData = await fixPptxData(data);
        if (cancelled) return;

        mainPreviewerRef.current?.destroy?.();
        thumbnailPreviewerRef.current?.destroy?.();
        mainPreviewerRef.current = null;
        thumbnailPreviewerRef.current = null;
        setRendered(false);
        setEffectiveZoomFactor(1);

        iframeDoc.open();
        iframeDoc.write(`<!DOCTYPE html><html><head><style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          html, body { width: 100%; min-height: 100%; background: #f3f4f6; }
          body { padding: 16px; overflow-y: auto; }
          #pptx-layout { width: 100%; min-height: 100px; }
          #pptx-thumbnails { display: none; }
          #pptx-main {
            width: 100%;
            min-width: 0;
            overflow: auto;
            --pptx-main-scale: 1;
            --pptx-main-width: 600px;
            --pptx-main-padding-y: 0px;
          }
          .pptx-preview-wrapper { background: transparent !important; width: 100% !important; max-width: 100% !important; height: auto !important; overflow: visible !important; }
          #pptx-main .pptx-preview-wrapper {
            width: var(--pptx-main-width) !important;
            max-width: none !important;
            margin: 0 auto !important;
            zoom: var(--pptx-main-scale);
          }
          .pptx-preview-wrapper > div { margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.12); border-radius: 4px; overflow: hidden; }
          .pptx-preview-wrapper > div:last-child { margin-bottom: 0; }
          canvas { width: 100% !important; height: auto !important; display: block; }
          @media (min-width: 760px) {
            html, body { height: 100%; min-height: 100%; overflow: hidden; }
            body { padding: 16px; }
            #pptx-layout {
              display: grid;
              grid-template-columns: 168px minmax(0, 1fr);
              gap: 16px;
              height: 100%;
              min-height: 0;
            }
            #pptx-thumbnails {
              display: block;
              min-height: 0;
              overflow-y: auto;
              padding: 2px 4px 2px 0;
            }
            #pptx-main {
              min-height: 0;
              overflow: auto;
              display: block;
              padding: var(--pptx-main-padding-y) 12px;
            }
            #pptx-main .pptx-preview-wrapper {
              width: var(--pptx-main-width) !important;
              max-width: none !important;
              margin: 0 auto !important;
              zoom: var(--pptx-main-scale);
            }
            #pptx-main .pptx-preview-wrapper > div {
              display: none;
              width: 100% !important;
              margin: 0 !important;
              box-shadow: 0 4px 18px rgba(0,0,0,0.18);
            }
            #pptx-main .pptx-preview-wrapper > div.is-active-slide {
              display: block;
            }
            #pptx-thumbnails .pptx-preview-wrapper > div {
              position: relative;
              width: 100% !important;
              margin: 0 0 10px !important;
              border: 2px solid transparent;
              border-radius: 6px;
              box-shadow: 0 1px 4px rgba(0,0,0,0.12);
              cursor: pointer;
              opacity: 0.82;
              transition: border-color 120ms ease, opacity 120ms ease;
            }
            #pptx-thumbnails .pptx-preview-wrapper > div::before {
              content: attr(data-slide-number);
              position: absolute;
              left: 6px;
              top: 5px;
              z-index: 2;
              min-width: 18px;
              height: 18px;
              border-radius: 9px;
              background: rgba(17,24,39,0.72);
              color: #fff;
              font: 11px/18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              text-align: center;
            }
            #pptx-thumbnails .pptx-preview-wrapper > div.is-active-thumbnail {
              border-color: #3b82f6;
              opacity: 1;
            }
          }
        </style></head><body><div id="pptx-layout"><aside id="pptx-thumbnails"></aside><main id="pptx-main"></main></div></body></html>`);
        iframeDoc.close();

        const mainRoot = iframeDoc.getElementById('pptx-main');
        const thumbnailRoot = iframeDoc.getElementById('pptx-thumbnails');
        if (!mainRoot || !thumbnailRoot) {
          setError('render_failed');
          return;
        }

        const mainPreviewer = pptxPreview.init(mainRoot, { width: PPTX_RENDER_WIDTH, mode: 'list' });
        const thumbnailPreviewer = pptxPreview.init(thumbnailRoot, { width: PPTX_THUMBNAIL_WIDTH, mode: 'list' });
        mainPreviewerRef.current = mainPreviewer;
        thumbnailPreviewerRef.current = thumbnailPreviewer;
        await mainPreviewer.preview(fixedData);
        await thumbnailPreviewer.preview(fixedData.slice(0));

        if (cancelled) return;

        const mainSlides = Array.from(mainRoot.querySelectorAll('.pptx-preview-wrapper > div'));
        const thumbnailSlides = Array.from(thumbnailRoot.querySelectorAll('.pptx-preview-wrapper > div'));
        const count = mainPreviewer.slideCount || mainSlides.length || thumbnailSlides.length || 0;
        setSlideCount(count);

        if (count > 0 && !cancelled) {
          let selectedIndex = 0;
          const slideLabelTemplate = t('artifactSlideLabel');
          const setActiveSlide = (index: number) => {
            selectedIndex = Math.max(0, Math.min(index, count - 1));
            mainSlides.forEach((slide, slideIndex) => {
              slide.classList.toggle('is-active-slide', slideIndex === selectedIndex);
            });
            thumbnailSlides.forEach((slide, slideIndex) => {
              const isActive = slideIndex === selectedIndex;
              slide.classList.toggle('is-active-thumbnail', isActive);
              if (isActive) {
                slide.scrollIntoView({ block: 'nearest' });
              }
            });
          };

          mainSlides.forEach((slide, index) => {
            slide.classList.toggle('is-active-slide', index === selectedIndex);
          });
          thumbnailSlides.forEach((slide, index) => {
            const slideNumber = String(index + 1);
            slide.setAttribute('data-slide-number', slideNumber);
            slide.setAttribute('role', 'button');
            slide.setAttribute('tabindex', '0');
            slide.setAttribute('aria-label', slideLabelTemplate.replace('{n}', slideNumber));
            slide.addEventListener('click', () => setActiveSlide(index));
            slide.addEventListener('keydown', event => {
              const key = (event as KeyboardEvent).key;
              if (key === 'Enter' || key === ' ') {
                event.preventDefault();
                setActiveSlide(index);
              }
            });
            slide.classList.toggle('is-active-thumbnail', index === selectedIndex);
          });
          setRendered(true);
        } else {
          setError('render_failed');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };

    render();
    return () => {
      cancelled = true;
      mainPreviewerRef.current?.destroy?.();
      thumbnailPreviewerRef.current?.destroy?.();
      mainPreviewerRef.current = null;
      thumbnailPreviewerRef.current = null;
    };
  }, [data, loadError]);

  // Adaptive zoom for the rendered PPTX slides inside the iframe.
  useEffect(() => {
    const container = containerRef.current;
    const iframe = iframeRef.current;
    if (!container || !iframe || !rendered) return;

    const updateZoom = () => {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      const mainRoot = iframeDoc?.getElementById('pptx-main');
      if (!mainRoot) return;

      const mainStyle = iframe.contentWindow?.getComputedStyle(mainRoot);
      const horizontalPadding = (parseFloat(mainStyle?.paddingLeft || '0') || 0) + (parseFloat(mainStyle?.paddingRight || '0') || 0);
      const isDesktopLayout = Boolean(iframe.contentWindow?.matchMedia('(min-width: 760px)').matches);
      const minVerticalPadding = isDesktopLayout ? 12 : 0;
      const availableWidth = Math.max(160, mainRoot.clientWidth - horizontalPadding);
      const activeSlide = mainRoot.querySelector<HTMLElement>('.pptx-preview-wrapper > div.is-active-slide')
        || mainRoot.querySelector<HTMLElement>('.pptx-preview-wrapper > div');
      const previousSlideScale = parseFloat(mainStyle?.getPropertyValue('--pptx-main-scale') || '1') || 1;
      const baseSlideHeight = parseFloat(activeSlide?.style.height || '')
        || ((activeSlide?.getBoundingClientRect().height || 0) / previousSlideScale)
        || Math.round(PPTX_RENDER_WIDTH * 9 / 16);
      const availableHeight = Math.max(120, mainRoot.clientHeight - minVerticalPadding * 2);
      const widthFitScale = (availableWidth * PPTX_AUTO_FIT_USAGE) / PPTX_RENDER_WIDTH;
      const heightFitScale = (availableHeight * PPTX_AUTO_FIT_USAGE) / baseSlideHeight;
      const autoFitScale = isDesktopLayout
        ? Math.max(1, Math.min(PPTX_MAX_AUTO_FIT_SCALE, widthFitScale, heightFitScale))
        : Math.min(1, availableWidth / PPTX_RENDER_WIDTH);
      const slideScale = Number((autoFitScale * zoomFactor).toFixed(3));
      mainRoot.style.setProperty('--pptx-main-scale', String(slideScale));
      mainRoot.style.setProperty('--pptx-main-width', `${PPTX_RENDER_WIDTH}px`);
      setEffectiveZoomFactor(current => (Math.abs(current - slideScale) > 0.005 ? slideScale : current));

      const scaledSlideHeight = baseSlideHeight * slideScale;
      const centeredVerticalPadding = scaledSlideHeight > 0
        ? Math.max(minVerticalPadding, Math.floor((mainRoot.clientHeight - scaledSlideHeight) / 2))
        : minVerticalPadding;
      mainRoot.style.setProperty('--pptx-main-padding-y', `${centeredVerticalPadding}px`);
    };

    const ro = new ResizeObserver(updateZoom);
    ro.observe(container);
    updateZoom();

    return () => ro.disconnect();
  }, [rendered, zoomFactor]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !rendered) return;

    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!iframeDoc) return;

    iframeDoc.addEventListener('wheel', handleNativeWheelZoom, { passive: false });
    return () => {
      iframeDoc.removeEventListener('wheel', handleNativeWheelZoom);
    };
  }, [handleNativeWheelZoom, rendered]);

  // Fallback: HTML slides or text extraction when pptx-preview fails
  if (error === 'render_failed') {
    return <PptxHtmlFallback artifact={artifact} data={data!} />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-500 text-sm p-4">
        {t('artifactDocumentError')}: {error}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {slideCount > 0 && (
        <div className="shrink-0 border-b border-border px-4 py-1.5 text-xs text-muted">
          <span>{t('artifactSlideCount').replace('{count}', String(slideCount))}</span>
        </div>
      )}
      <div ref={containerRef} className="flex-1 relative min-h-0" onWheel={handleWheelZoom}>
        {(loading || !rendered) && (
          <div className="absolute inset-0 flex items-center justify-center text-muted text-sm z-10 bg-background">
            {t('artifactDocumentLoading')}
          </div>
        )}
        <iframe
          ref={iframeRef}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin"
          title={artifact.title || 'PPTX Preview'}
        />
      </div>
    </div>
  );
};

const PptxSubRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  return <LegacyPptxSubRenderer artifact={artifact} />;
};

// HTML slides fallback: load slideN.html files from the same directory
const PptxHtmlFallback: React.FC<{ artifact: Artifact; data: ArrayBuffer }> = ({ artifact, data }) => {
  const [slideHtmls, setSlideHtmls] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [useTextFallback, setUseTextFallback] = useState(false);

  useEffect(() => {
    if (!artifact.filePath) { setUseTextFallback(true); setLoading(false); return; }

    let cancelled = false;

    const loadSlideHtmls = async () => {
      let filePath = artifact.filePath!;
      if (filePath.startsWith('file:///')) filePath = filePath.slice(7);
      else if (filePath.startsWith('file://')) filePath = filePath.slice(7);
      else if (filePath.startsWith('file:/')) filePath = filePath.slice(5);
      // Strip leading / before Windows drive letter
      if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);

      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      const slidesDir = `${dir}/slides`;
      const htmls: string[] = [];

      for (let i = 1; i <= 20; i++) {
        const slidePath = `${slidesDir}/slide${i}.html`;
        try {
          const result = await window.electron?.dialog?.readFileAsDataUrl(slidePath);
          if (!result?.success || !result.dataUrl) break;
          const base64 = result.dataUrl.split(',')[1] || '';
          const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
          const html = new TextDecoder('utf-8').decode(bytes);
          htmls.push(html);
        } catch {
          break;
        }
      }

      if (cancelled) return;

      if (htmls.length > 0) {
        setSlideHtmls(htmls);
      } else {
        setUseTextFallback(true);
      }
      setLoading(false);
    };

    loadSlideHtmls();
    return () => { cancelled = true; };
  }, [artifact.filePath]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-muted text-sm">{t('artifactDocumentLoading')}</div>;
  }

  if (useTextFallback) {
    return <PptxTextFallback data={data} />;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-3 py-1.5 text-xs text-muted border-b border-border shrink-0">
        {t('artifactSlideCount').replace('{count}', String(slideHtmls.length))}
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4 bg-[#f3f4f6]">
        {slideHtmls.map((html, i) => (
          <div key={i} className="shadow-lg rounded overflow-hidden">
            <iframe
              srcDoc={html}
              className="w-full border-0 rounded"
              style={{ aspectRatio: '16/9' }}
              sandbox="allow-scripts allow-same-origin"
              title={`Slide ${i + 1}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

// Text extraction fallback for PPTX
interface SlideContent { index: number; texts: string[]; }

async function parsePptxSlides(data: ArrayBuffer): Promise<SlideContent[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);
  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
      const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
      return na - nb;
    });

  const slides: SlideContent[] = [];
  const textRe = /<a:t>([^<]*)<\/a:t>/g;

  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.file(slideFiles[i])!.async('string');
    const texts: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = textRe.exec(xml)) !== null) {
      if (match[1].trim()) texts.push(match[1]);
    }
    textRe.lastIndex = 0;
    slides.push({ index: i + 1, texts });
  }
  return slides;
}

const PptxTextFallback: React.FC<{ data: ArrayBuffer }> = ({ data }) => {
  const [slides, setSlides] = useState<SlideContent[]>([]);
  const [parsed, setParsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    parsePptxSlides(data).then(result => {
      if (!cancelled) { setSlides(result); setParsed(true); }
    }).catch(() => { if (!cancelled) setParsed(true); });
    return () => { cancelled = true; };
  }, [data]);

  if (!parsed) {
    return <div className="flex items-center justify-center h-full text-muted text-sm">{t('artifactDocumentLoading')}</div>;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-3 py-1.5 text-xs text-muted border-b border-border shrink-0">
        {t('artifactSlideCount').replace('{count}', String(slides.length))}
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {slides.map(slide => (
          <div key={slide.index} className="border border-border rounded-lg p-4 bg-surface">
            <div className="text-xs text-muted mb-2 font-medium">
              {t('artifactSlideLabel').replace('{n}', String(slide.index))}
            </div>
            {slide.texts.length > 0 ? (
              <div className="space-y-1">
                {slide.texts.map((text, i) => (
                  <div key={i} className="text-sm text-foreground">{text}</div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted italic">{t('artifactSlideNoText')}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// --- Fallback Sub-Renderer ---

const FileInfoFallback: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const ext = getExtension(artifact.fileName || artifact.filePath || '');

  const handleOpenWithApp = useCallback(() => {
    if (artifact.filePath) {
      void openLocalPathWithToast(artifact.filePath);
    }
  }, [artifact.filePath]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
      <div className="text-5xl">
        {ext === '.pptx' ? '📊' : ext === '.xlsx' ? '📑' : '📄'}
      </div>
      <div className="text-center">
        <div className="text-sm font-medium">{artifact.fileName || artifact.title}</div>
        <div className="text-xs text-muted mt-1">{ext.toUpperCase().slice(1)}</div>
      </div>
      {artifact.filePath && (
        <button
          onClick={handleOpenWithApp}
          className="px-3 py-1.5 text-xs rounded bg-primary text-white hover:bg-primary/90 transition-colors mt-2"
        >
          {t('artifactOpenWithApp')}
        </button>
      )}
    </div>
  );
};

// --- Main Document Renderer ---

interface DocumentRendererProps {
  artifact: Artifact;
}

const DocumentRenderer: React.FC<DocumentRendererProps> = ({ artifact }) => {
  const ext = getExtension(artifact.fileName || artifact.filePath || '');

  switch (ext) {
    case '.docx':
      return <DocxSubRenderer artifact={artifact} />;
    case '.xlsx':
    case '.xls':
    case '.csv':
    case '.tsv':
      return <SheetRenderer artifact={artifact} />;
    case '.pdf':
      return <PdfSubRenderer artifact={artifact} />;
    case '.pptx':
      return <PptxSubRenderer artifact={artifact} />;
    default:
      return <FileInfoFallback artifact={artifact} />;
  }
};

export default DocumentRenderer;
