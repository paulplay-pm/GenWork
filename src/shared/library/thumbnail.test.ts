import { describe, expect, test } from 'vitest';

import { LibraryArtifactType } from './constants';
import {
  createLibraryThumbnailRenderRequest,
  LibraryThumbnailDimensions,
} from './thumbnail';

describe('library thumbnail render request', () => {
  test.each([
    ['report.docx', '.docx', LibraryArtifactType.Document],
    ['report.PDF', '.pdf', LibraryArtifactType.Document],
    ['sheet.xlsx', '.xlsx', LibraryArtifactType.Document],
    ['deck.pptx', '.pptx', LibraryArtifactType.Document],
    ['page.html', '.html', LibraryArtifactType.Html],
    ['photo.png', '.png', LibraryArtifactType.Image],
    ['clip.mp4', '.mp4', LibraryArtifactType.Video],
  ])('builds a renderer request for %s', (fileName, extension, artifactType) => {
    expect(createLibraryThumbnailRenderRequest(fileName, 'YWJj')).toEqual({
      fileName,
      extension,
      artifactType,
      contentBase64: 'YWJj',
      width: LibraryThumbnailDimensions.Width,
      height: LibraryThumbnailDimensions.Height,
    });
  });

  test('rejects files outside the previewable library policy', () => {
    expect(createLibraryThumbnailRenderRequest('archive.zip', 'YWJj')).toBeNull();
    expect(createLibraryThumbnailRenderRequest('README', 'YWJj')).toBeNull();
  });

  test('preserves an explicitly requested capture size', () => {
    const request = createLibraryThumbnailRenderRequest('photo.jpg', 'YWJj', 320, 180);

    expect(request).toMatchObject({ width: 320, height: 180 });
  });
});
