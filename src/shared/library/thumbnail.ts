import {
  getLibraryArtifactTypeForExtension,
  type LibraryArtifactType,
} from './constants';

export const LibraryThumbnailDimensions = {
  Width: 480,
  Height: 270,
} as const;

export const LibraryThumbnailLimits = {
  MaxSourceBytes: 64 * 1024 * 1024,
  RenderTimeoutMs: 12_000,
  CaptureTimeoutMs: 5_000,
} as const;

export interface LibraryThumbnailRenderRequest {
  fileName: string;
  extension: string;
  artifactType: LibraryArtifactType;
  contentBase64: string;
  width: number;
  height: number;
}

export interface LibraryThumbnailRenderResult {
  success: boolean;
  error?: string;
}

export const createLibraryThumbnailRenderRequest = (
  fileName: string,
  contentBase64: string,
  width: number = LibraryThumbnailDimensions.Width,
  height: number = LibraryThumbnailDimensions.Height,
): LibraryThumbnailRenderRequest | null => {
  const dotIndex = fileName.lastIndexOf('.');
  const extension = dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
  const artifactType = getLibraryArtifactTypeForExtension(extension);
  if (!artifactType) return null;
  return {
    fileName,
    extension,
    artifactType,
    contentBase64,
    width,
    height,
  };
};
