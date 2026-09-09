/**
 * PPTX preprocessing shared by the in-app preview (DocumentRenderer) and the
 * share-page bake (bakeArtifactSharePage).
 *
 * pptx-preview has several quirks that require rewriting the zip before it can
 * render faithfully; the same fixes are needed wherever a PPTX is turned into
 * on-screen slides (live preview or a baked share image), so they live here.
 */

const PPTX_IMAGE_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const PPTX_MEDIA_DIR = 'ppt/media/';
const PPTX_DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PPTX_PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const PPTX_IMAGE_CONTENT_TYPES: Record<string, string> = {
  bmp: 'image/bmp',
  emf: 'image/x-emf',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  wmf: 'image/x-wmf',
};

function getRelationshipSourceDir(relsPath: string): string {
  const sourcePath = relsPath.replace('/_rels/', '/').replace(/\.rels$/, '');
  const lastSlash = sourcePath.lastIndexOf('/');
  return lastSlash >= 0 ? sourcePath.slice(0, lastSlash) : '';
}

function normalizeZipPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function resolveRelationshipTarget(relsPath: string, target: string): string {
  const decodedTarget = decodeRelationshipTarget(target);
  if (decodedTarget.startsWith('/')) return normalizeZipPath(decodedTarget.slice(1));

  const sourceDir = getRelationshipSourceDir(relsPath);
  return normalizeZipPath(sourceDir ? `${sourceDir}/${decodedTarget}` : decodedTarget);
}

function getRelativeZipPath(fromDir: string, toPath: string): string {
  const fromParts = fromDir ? fromDir.split('/').filter(Boolean) : [];
  const toParts = toPath.split('/').filter(Boolean);

  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  return [...fromParts.map(() => '..'), ...toParts].join('/');
}

function getFileExtension(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const dotIndex = basename.lastIndexOf('.');
  return dotIndex >= 0 ? basename.slice(dotIndex).toLowerCase() : '';
}

function decodeRelationshipTarget(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

function findZipPath(zip: { files: Record<string, { dir?: boolean }>; file(path: string): unknown }, path: string): string | null {
  if (zip.file(path)) return path;

  const lowerPath = path.toLowerCase();
  return Object.keys(zip.files).find(candidate => !zip.files[candidate].dir && candidate.toLowerCase() === lowerPath) || null;
}

function detectImageExtension(bytes: Uint8Array, fallbackExtension: string): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return '.png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return '.jpg';
  }
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return '.gif';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return '.bmp';
  }
  return fallbackExtension.toLowerCase();
}

function createPptxPreviewMediaPath(zip: { file(path: string): unknown }, index: number, extension: string): string {
  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;
  let candidate = `${PPTX_MEDIA_DIR}image_genwork_${index}${normalizedExtension}`;
  let suffix = 1;

  while (zip.file(candidate)) {
    candidate = `${PPTX_MEDIA_DIR}image_genwork_${index}_${suffix}${normalizedExtension}`;
    suffix += 1;
  }

  return candidate;
}

function ensureContentTypeDefaults(contentTypesXml: string, extensions: Set<string>): string {
  const defaults = new Set<string>();
  contentTypesXml.replace(/<Default\b[^>]*\bExtension="([^"]+)"/g, (_entry, extension: string) => {
    defaults.add(extension.toLowerCase());
    return _entry;
  });

  const additions = Array.from(extensions)
    .map(extension => extension.replace(/^\./, '').toLowerCase())
    .filter(extension => PPTX_IMAGE_CONTENT_TYPES[extension] && !defaults.has(extension))
    .map(extension => (
      `<Default Extension="${extension}" ContentType="${PPTX_IMAGE_CONTENT_TYPES[extension]}"/>`
    ));

  if (additions.length === 0) return contentTypesXml;

  const insertion = additions.join('');
  if (contentTypesXml.includes('<Override')) {
    return contentTypesXml.replace('<Override', `${insertion}<Override`);
  }

  return contentTypesXml.replace('</Types>', `${insertion}</Types>`);
}

async function getPptxSlideSize(zip: { file(path: string): { async(type: 'string'): Promise<string> } | null }): Promise<{ cx: string; cy: string }> {
  const defaultSize = { cx: '9144000', cy: '5143500' };
  const presentationFile = zip.file('ppt/presentation.xml');
  if (!presentationFile) return defaultSize;

  const presentationXml = await presentationFile.async('string');
  const doc = new DOMParser().parseFromString(presentationXml, 'application/xml');
  const slideSize = doc.getElementsByTagName('p:sldSz')[0];
  if (!slideSize) return defaultSize;

  return {
    cx: slideSize.getAttribute('cx') || defaultSize.cx,
    cy: slideSize.getAttribute('cy') || defaultSize.cy,
  };
}

function getSlidePathFromRelsPath(relsPath: string): string | null {
  if (!relsPath.startsWith('ppt/slides/_rels/') || !relsPath.endsWith('.rels')) return null;
  return relsPath.replace('ppt/slides/_rels/', 'ppt/slides/').replace(/\.rels$/, '');
}

function getNextSlideShapeId(doc: Document): string {
  const ids = Array.from(doc.getElementsByTagName('p:cNvPr'))
    .map(node => Number(node.getAttribute('id') || '0'))
    .filter(Number.isFinite);
  return String(Math.max(0, ...ids) + 1);
}

function hasBackgroundFallback(doc: Document, relId: string): boolean {
  return Array.from(doc.getElementsByTagName('p:cNvPr')).some(node => (
    node.getAttribute('name') === `GenWork Background Fallback ${relId}`
  ));
}

function createElement(doc: Document, namespace: string, name: string, attrs: Record<string, string> = {}): Element {
  const element = doc.createElementNS(namespace, name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function createPictureBlipFill(doc: Document, backgroundBlipFill: Element): Element {
  const pictureBlipFill = createElement(doc, PPTX_PRESENTATION_NS, 'p:blipFill');
  Array.from(backgroundBlipFill.childNodes).forEach(child => {
    pictureBlipFill.appendChild(child.cloneNode(true));
  });

  return pictureBlipFill;
}

function createBackgroundFallbackPic(doc: Document, relId: string, blipFill: Element, size: { cx: string; cy: string }): Element {
  const pic = createElement(doc, PPTX_PRESENTATION_NS, 'p:pic');
  const nvPicPr = createElement(doc, PPTX_PRESENTATION_NS, 'p:nvPicPr');
  const cNvPr = createElement(doc, PPTX_PRESENTATION_NS, 'p:cNvPr', {
    id: getNextSlideShapeId(doc),
    name: `GenWork Background Fallback ${relId}`,
  });
  const cNvPicPr = createElement(doc, PPTX_PRESENTATION_NS, 'p:cNvPicPr');
  const nvPr = createElement(doc, PPTX_PRESENTATION_NS, 'p:nvPr');
  nvPicPr.append(cNvPr, cNvPicPr, nvPr);

  const fallbackBlipFill = createPictureBlipFill(doc, blipFill);
  const spPr = createElement(doc, PPTX_PRESENTATION_NS, 'p:spPr');
  const xfrm = createElement(doc, PPTX_DRAWING_NS, 'a:xfrm');
  const off = createElement(doc, PPTX_DRAWING_NS, 'a:off', { x: '0', y: '0' });
  const ext = createElement(doc, PPTX_DRAWING_NS, 'a:ext', size);
  const prstGeom = createElement(doc, PPTX_DRAWING_NS, 'a:prstGeom', { prst: 'rect' });
  const avLst = createElement(doc, PPTX_DRAWING_NS, 'a:avLst');

  xfrm.append(off, ext);
  prstGeom.append(avLst);
  spPr.append(xfrm, prstGeom);
  pic.append(nvPicPr, fallbackBlipFill, spPr);

  return pic;
}

async function addBackgroundImageFallbacks(
  zip: { file(path: string, data?: string): { async(type: 'string'): Promise<string> } | null },
  relsToFallbackRelIds: Map<string, Set<string>>,
): Promise<void> {
  if (relsToFallbackRelIds.size === 0) return;

  const slideSize = await getPptxSlideSize(zip);

  for (const [relsPath, relIds] of relsToFallbackRelIds) {
    const slidePath = getSlidePathFromRelsPath(relsPath);
    if (!slidePath) continue;

    const slideFile = zip.file(slidePath);
    if (!slideFile) continue;

    const slideXml = await slideFile.async('string');
    const doc = new DOMParser().parseFromString(slideXml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) continue;

    const spTree = doc.getElementsByTagName('p:spTree')[0];
    const grpSpPr = doc.getElementsByTagName('p:grpSpPr')[0];
    if (!spTree || !grpSpPr) continue;

    let changed = false;
    const backgroundBlipFills = Array.from(doc.getElementsByTagName('p:bgPr'))
      .map(bgPr => bgPr.getElementsByTagName('a:blipFill')[0])
      .filter((blipFill): blipFill is Element => Boolean(blipFill));

    for (const blipFill of backgroundBlipFills) {
      const blip = blipFill.getElementsByTagName('a:blip')[0];
      const relId = blip?.getAttribute('r:embed');
      if (!relId || !relIds.has(relId) || hasBackgroundFallback(doc, relId)) continue;

      const fallbackPic = createBackgroundFallbackPic(doc, relId, blipFill, slideSize);
      spTree.insertBefore(fallbackPic, grpSpPr.nextSibling);
      changed = true;
    }

    if (changed) {
      zip.file(slidePath, new XMLSerializer().serializeToString(doc));
    }
  }
}

/**
 * Fix PPTX files before passing them to pptx-preview:
 * 1. Re-compress with Deflate (some are stored uncompressed)
 * 2. Remove Content_Types.xml entries that reference non-existent files
 * 3. Copy non-standard media names to ppt/media/image* because pptx-preview only preloads that prefix
 */
export async function fixPptxData(data: ArrayBuffer): Promise<ArrayBuffer> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);

  // Fix Content_Types.xml: remove Override entries for missing files.
  const ctFile = zip.file('[Content_Types].xml');
  let contentTypesXml: string | null = null;
  if (ctFile) {
    let ct = await ctFile.async('string');
    const overrideRe = /<Override[^>]+PartName="([^"]+)"[^>]*\/>/g;
    const toRemove: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = overrideRe.exec(ct)) !== null) {
      const partName = match[1];
      const zipPath = partName.startsWith('/') ? partName.slice(1) : partName;
      if (!zip.file(zipPath)) {
        toRemove.push(match[0]);
      }
    }
    for (const entry of toRemove) {
      ct = ct.replace(entry, '');
    }
    contentTypesXml = ct;
  }

  const mediaPathMap = new Map<string, string>();
  const addedMediaExtensions = new Set<string>();
  const backgroundFallbackRelIds = new Map<string, Set<string>>();
  let normalizedMediaIndex = 1;

  for (const relsPath of Object.keys(zip.files).filter(path => path.endsWith('.rels'))) {
    const relsFile = zip.file(relsPath);
    if (!relsFile) continue;

    const relsXml = await relsFile.async('string');
    const doc = new DOMParser().parseFromString(relsXml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) continue;

    const sourceDir = getRelationshipSourceDir(relsPath);
    const relationships = Array.from(doc.getElementsByTagName('Relationship'));
    let changed = false;

    for (const relationship of relationships) {
      if (relationship.getAttribute('Type') !== PPTX_IMAGE_RELATIONSHIP_TYPE) continue;
      if (relationship.getAttribute('TargetMode') === 'External') continue;

      const target = relationship.getAttribute('Target');
      if (!target) continue;

      const resolvedTarget = resolveRelationshipTarget(relsPath, target);
      const mediaPath = findZipPath(zip, resolvedTarget);
      if (!mediaPath || !mediaPath.toLowerCase().startsWith(PPTX_MEDIA_DIR)) continue;

      const basename = mediaPath.slice(PPTX_MEDIA_DIR.length);
      if (mediaPath.startsWith(PPTX_MEDIA_DIR) && basename.startsWith('image')) {
        const normalizedTarget = getRelativeZipPath(sourceDir, mediaPath);
        if (normalizedTarget !== target) {
          relationship.setAttribute('Target', normalizedTarget);
          changed = true;
        }
        continue;
      }

      const mediaFile = zip.file(mediaPath);
      if (!mediaFile) continue;

      let normalizedTarget = mediaPathMap.get(mediaPath);
      if (!normalizedTarget) {
        const mediaData = await mediaFile.async('arraybuffer');
        const extension = detectImageExtension(new Uint8Array(mediaData), getFileExtension(mediaPath));
        normalizedTarget = createPptxPreviewMediaPath(zip, normalizedMediaIndex, extension || '.png');
        normalizedMediaIndex += 1;
        mediaPathMap.set(mediaPath, normalizedTarget);
        addedMediaExtensions.add(getFileExtension(normalizedTarget));
        zip.file(normalizedTarget, mediaData);
      }

      const relId = relationship.getAttribute('Id');
      if (relId) {
        if (!backgroundFallbackRelIds.has(relsPath)) {
          backgroundFallbackRelIds.set(relsPath, new Set<string>());
        }
        backgroundFallbackRelIds.get(relsPath)?.add(relId);
      }

      relationship.setAttribute('Target', getRelativeZipPath(sourceDir, normalizedTarget));
      changed = true;
    }

    if (changed) {
      zip.file(relsPath, new XMLSerializer().serializeToString(doc));
    }
  }

  await addBackgroundImageFallbacks(zip, backgroundFallbackRelIds);

  if (contentTypesXml !== null) {
    zip.file('[Content_Types].xml', ensureContentTypeDefaults(contentTypesXml, addedMediaExtensions));
  }

  // Re-generate with Deflate compression
  return await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}
