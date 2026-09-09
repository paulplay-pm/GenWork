import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  HtmlShareSourceType,
} from '@shared/htmlShare/constants';

import { type Artifact, type ArtifactType, ArtifactTypeValue } from '@/types/artifact';

export const ArtifactFileShareRequestSource = {
  HtmlFile: 'htmlFile',
  ArtifactFile: 'artifactFile',
} as const;

export type ArtifactFileShareRequestSource =
  (typeof ArtifactFileShareRequestSource)[keyof typeof ArtifactFileShareRequestSource];

export type ArtifactFileShareSourceType =
  | typeof HtmlShareSourceType.HtmlFile
  | typeof HtmlShareSourceType.ImageFile
  | typeof HtmlShareSourceType.SvgFile
  | typeof HtmlShareSourceType.DocumentFile
  | typeof HtmlShareSourceType.MarkdownFile
  | typeof HtmlShareSourceType.MermaidFile;

export interface ArtifactFileShareRequest {
  source: ArtifactFileShareRequestSource;
  sourceType: ArtifactFileShareSourceType;
  sessionId: string;
  artifactId: string;
  lookupKey: string;
  title: string;
  accessMode: HtmlShareAccessModeValue;
  fileName?: string;
  filePath?: string;
  content?: string;
  remoteUrl?: string;
}

const ARTIFACT_FILE_SHARE_SOURCE_TYPES: Partial<Record<ArtifactType, ArtifactFileShareSourceType>> =
  {
    [ArtifactTypeValue.Html]: HtmlShareSourceType.HtmlFile,
    [ArtifactTypeValue.Image]: HtmlShareSourceType.ImageFile,
    [ArtifactTypeValue.Svg]: HtmlShareSourceType.SvgFile,
    [ArtifactTypeValue.Document]: HtmlShareSourceType.DocumentFile,
    [ArtifactTypeValue.Markdown]: HtmlShareSourceType.MarkdownFile,
    [ArtifactTypeValue.Mermaid]: HtmlShareSourceType.MermaidFile,
  };

export function getArtifactFileShareSourceType(
  artifact: Artifact,
): ArtifactFileShareSourceType | null {
  return ARTIFACT_FILE_SHARE_SOURCE_TYPES[artifact.type] ?? null;
}

function hasShareableSource(artifact: Artifact, sourceType: ArtifactFileShareSourceType): boolean {
  if (sourceType === HtmlShareSourceType.HtmlFile) {
    return Boolean(artifact.filePath);
  }
  if (
    sourceType === HtmlShareSourceType.DocumentFile ||
    sourceType === HtmlShareSourceType.MarkdownFile ||
    sourceType === HtmlShareSourceType.MermaidFile
  ) {
    return Boolean(artifact.filePath || artifact.content.trim());
  }
  return Boolean(artifact.filePath || artifact.content.trim() || artifact.remoteUrl?.trim());
}

export function isArtifactFileShareable(artifact: Artifact): boolean {
  const sourceType = getArtifactFileShareSourceType(artifact);
  return sourceType ? hasShareableSource(artifact, sourceType) : false;
}

function normalizeArtifactFileShareLookupPath(filePath: string): string {
  let normalized = filePath.trim();
  if (/^file:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^file:\/\//i, '');
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      // Keep malformed percent sequences unchanged, matching the main-process fallback.
    }
  }
  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized.replace(/\\/g, '/').toLowerCase();
}

export function buildArtifactFileShareLookupKey(
  artifact: Artifact,
  sourceType: ArtifactFileShareSourceType,
  fallbackSessionId = '',
): string {
  if (artifact.filePath) {
    return `${sourceType}:file:${normalizeArtifactFileShareLookupPath(artifact.filePath)}`;
  }
  return `${sourceType}:artifact:${artifact.sessionId || fallbackSessionId}:${artifact.id}`;
}

export function buildArtifactFileShareRequest(
  artifact: Artifact,
  fallbackSessionId: string,
  fallbackTitle = '',
): ArtifactFileShareRequest | null {
  const sourceType = getArtifactFileShareSourceType(artifact);
  if (!sourceType || !hasShareableSource(artifact, sourceType)) return null;

  const sessionId = artifact.sessionId || fallbackSessionId;
  const title = artifact.title || artifact.fileName || fallbackTitle;
  const lookupKey = buildArtifactFileShareLookupKey(artifact, sourceType, fallbackSessionId);

  if (sourceType === HtmlShareSourceType.HtmlFile) {
    if (!artifact.filePath) return null;
    return {
      source: ArtifactFileShareRequestSource.HtmlFile,
      sourceType,
      sessionId,
      artifactId: artifact.id,
      lookupKey,
      filePath: artifact.filePath,
      title,
      accessMode: HtmlShareAccessMode.Code,
    };
  }

  return {
    source: ArtifactFileShareRequestSource.ArtifactFile,
    sourceType,
    sessionId,
    artifactId: artifact.id,
    lookupKey,
    title,
    accessMode: HtmlShareAccessMode.Code,
    fileName: artifact.fileName || artifact.title,
    filePath: artifact.filePath,
    content: artifact.content,
    remoteUrl:
      sourceType === HtmlShareSourceType.DocumentFile ||
      sourceType === HtmlShareSourceType.MarkdownFile ||
      sourceType === HtmlShareSourceType.MermaidFile
        ? undefined
        : artifact.remoteUrl,
  };
}
