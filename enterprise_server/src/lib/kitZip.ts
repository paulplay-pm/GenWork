import crypto from 'node:crypto';

import AdmZip from 'adm-zip';

/**
 * A kit zip bundles MANY skill folders, each with its own SKILL.md, laid out
 * FLAT at the archive root (e.g. `architecture/SKILL.md`, `code-review/SKILL.md`)
 * with no wrapping kit directory — unlike a single-skill marketplace zip, whose
 * sole top-level dir carries the skill's slug. So we do NOT infer a slug here;
 * the slug is supplied by the caller (admin create form / seed manifest). We
 * only validate: non-empty, under the size cap, parseable, no traversal, and
 * at least one SKILL.md present. Cap is higher than skills because kits are
 * larger.
 */
export const MAX_KIT_ZIP_BYTES = 50 * 1024 * 1024;

export class KitZipError extends Error {
  constructor(public code: 'empty' | 'too_large' | 'bad_zip' | 'no_skills', message: string) {
    super(message);
  }
}

export function hasPathTraversal(entryName: string): boolean {
  return entryName.split('/').some((seg) => seg === '..' || seg === '.');
}

export function parseKitZip(buf: Buffer): { size: number; sha256: string } {
  if (buf.byteLength === 0) throw new KitZipError('empty', 'empty zip');
  if (buf.byteLength > MAX_KIT_ZIP_BYTES) throw new KitZipError('too_large', `zip exceeds ${MAX_KIT_ZIP_BYTES} bytes`);

  let zip: AdmZip;
  try { zip = new AdmZip(buf); } catch { throw new KitZipError('bad_zip', 'unparseable zip'); }

  // Path traversal guard (mirror skillZip.ts).
  for (const e of zip.getEntries()) {
    if (hasPathTraversal(e.entryName)) {
      throw new KitZipError('bad_zip', 'zip entry path traversal');
    }
  }

  const hasSkillMd = zip.getEntries().some(
    (e) => !e.isDirectory && e.entryName.split('/').pop() === 'SKILL.md',
  );
  if (!hasSkillMd) throw new KitZipError('no_skills', 'zip contains no SKILL.md');

  return { size: buf.byteLength, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
