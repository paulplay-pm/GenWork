import { HtmlShareSourceType } from '@shared/htmlShare/constants';
import { describe, expect, test } from 'vitest';

import type { Artifact } from '@/types/artifact';

import type { ArtifactFileShareRequest } from './artifactFileSharePolicy';
import { bakeArtifactSharePage } from './bakeArtifactSharePage';

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    type: 'markdown',
    title: 'Identity',
    fileName: 'IDENTITY.md',
    sessionId: 'session-1',
    ...overrides,
  } as Artifact;
}

function makeRequest(
  overrides: Partial<ArtifactFileShareRequest> = {},
): ArtifactFileShareRequest {
  return {
    sourceType: HtmlShareSourceType.MarkdownFile,
    source: 'artifact_file',
    sessionId: 'session-1',
    artifactId: 'artifact-1',
    lookupKey: 'markdown_file:artifact:session-1:artifact-1',
    title: 'Identity',
    content: '# Title\n\nHello **world**',
    ...overrides,
  } as ArtifactFileShareRequest;
}

describe('bakeArtifactSharePage (markdown)', () => {
  test('renders an inline markdown artifact to a self-contained page', async () => {
    const html = await bakeArtifactSharePage({
      artifact: makeArtifact({ content: '# Title\n\nHello **world**' }),
      request: makeRequest({ content: '# Title\n\nHello **world**' }),
    });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<article class="doc">');
    // The remark/gfm pipeline must render the heading and the bold run.
    expect(html).toContain('<h1');
    expect(html).toContain('Hello <strong>world</strong>');
    // Title is escaped and embedded in the shell.
    expect(html).toContain('<title>Identity</title>');
  });

  test('escapes user content so it cannot inject HTML', async () => {
    const malicious = '<script>alert(1)</script>';
    const html = await bakeArtifactSharePage({
      artifact: makeArtifact({ content: malicious }),
      request: makeRequest({ content: malicious }),
    });
    // The raw <script> from the document body must not appear as live markup;
    // the title shell must also be escaped rather than injected.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<title><script>');
  });
});

describe('bakeArtifactSharePage (document placeholder)', () => {
  test('renders a placeholder page for office documents', async () => {
    const html = await bakeArtifactSharePage({
      artifact: makeArtifact({ type: 'document', fileName: 'Report.docx' }),
      request: makeRequest({ sourceType: HtmlShareSourceType.DocumentFile }),
    });
    expect(html).toContain('<div class="doc-note">');
    expect(html).toContain('Report.docx');
    expect(html).toContain('DOCX');
  });
});

describe('bakeArtifactSharePage (office documents)', () => {
  // Build a real xlsx workbook as an ArrayBuffer via SheetJS, then feed the
  // binary to the bake (mirrors how the live flow supplies document content).
  async function makeXlsxBuffer(rows: (string | number)[][]): Promise<string> {
    const XLSX = await import('xlsx');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(rows),
      'Sheet1',
    );
    const written = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    return btoa(String.fromCharCode(...new Uint8Array(written)));
  }

  test('bakes an xlsx document to static HTML tables', async () => {
    const dataUrl = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${await makeXlsxBuffer([
      ['Name', 'Qty'],
      ['Grape', 12],
    ])}`;
    const html = await bakeArtifactSharePage({
      artifact: makeArtifact({ type: 'document', fileName: 'Stock.xlsx' }),
      request: makeRequest({
        sourceType: HtmlShareSourceType.DocumentFile,
        fileName: 'Stock.xlsx',
        content: dataUrl,
      }),
    });
    // The real workbook content is rendered, not the "not available" placeholder.
    expect(html).toContain('<div class="bake-sheet-wrap">');
    expect(html).toContain('<table');
    expect(html).toContain('Grape');
    // And it is not the "not available" placeholder.
    expect(html).not.toContain('<div class="doc-note">');
  });

  test('falls back to a placeholder when the document cannot be loaded', async () => {
    // Unknown extension (not docx/xlsx/pdf/pptx) with no content -> placeholder.
    const html = await bakeArtifactSharePage({
      artifact: makeArtifact({ type: 'document', fileName: 'report.ppt' }),
      request: makeRequest({
        sourceType: HtmlShareSourceType.DocumentFile,
        fileName: 'report.ppt',
      }),
    });
    expect(html).toContain('<div class="doc-note">');
    expect(html).toContain('report.ppt');
    expect(html).not.toContain('<div class="bake-');
  });

  test('falls back to a placeholder when there is no readable content', async () => {
    // A docx with no content and no resolvable file path -> placeholder.
    const html = await bakeArtifactSharePage({
      artifact: makeArtifact({ type: 'document', fileName: 'Mystery.docx' }),
      request: makeRequest({
        sourceType: HtmlShareSourceType.DocumentFile,
        fileName: 'Mystery.docx',
      }),
    });
    expect(html).toContain('<div class="doc-note">');
    expect(html).toContain('Mystery.docx');
  });
});

