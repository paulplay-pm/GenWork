import crypto from 'node:crypto';

import AdmZip from 'adm-zip';

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const MAX_ZIP_BYTES = 10 * 1024 * 1024;

export class SkillZipError extends Error {
  constructor(
    public code: 'empty' | 'too_large' | 'bad_zip' | 'invalid_name',
    message: string,
  ) {
    super(message);
  }
}

/** First common top-level directory (the one that holds SKILL.md). */
function topLevelDir(zip: AdmZip): string {
  const dirs = new Set<string>();
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const first = e.entryName.split('/').filter(Boolean)[0];
    // `__MACOSX` is the Finder "Compress" metadata artifact (resource-fork
    // stubs) that macOS zips always add alongside the real folder. Ignoring it
    // keeps the "exactly one top-level dir" contract without rejecting the
    // dominant real-world input (a skill folder compressed on a Mac).
    if (!first || first === '__MACOSX') continue;
    dirs.add(first);
  }
  // Exactly one top-level dir is the contract; SKILL.md must live inside it.
  const withSkillMd = [...dirs].filter((d) =>
    zip.getEntries().some((e) => !e.isDirectory && (e.entryName === `${d}/SKILL.md` || new RegExp(`^${escapeRe(d)}/.*SKILL\\.md$`).test(e.entryName))),
  );
  if (dirs.size !== 1 || withSkillMd.length === 0) {
    throw new SkillZipError('bad_zip', 'zip must contain exactly one top-level directory with a SKILL.md');
  }
  return withSkillMd[0];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readVersion(entry: AdmZip.IZipEntry): string {
  // SKILL.md YAML frontmatter: first `version:` line. Tolerant, best-effort.
  const text = entry.getData().toString('utf8');
  const m = text.match(/^version:\s*(\S+)/m);
  return m ? m[1].trim() : '1.0.0';
}

export function parseSkillZip(buf: Buffer): {
  name: string;
  version: string;
  size: number;
  sha256: string;
  fileName: string;
} {
  if (buf.byteLength === 0) throw new SkillZipError('empty', 'empty zip');
  if (buf.byteLength > MAX_ZIP_BYTES) throw new SkillZipError('too_large', `zip exceeds ${MAX_ZIP_BYTES} bytes`);

  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch {
    throw new SkillZipError('bad_zip', 'unparseable zip');
  }

  // Path traversal guard.
  for (const e of zip.getEntries()) {
    if (e.entryName.split('/').some((seg) => seg === '..' || seg === '.')) {
      throw new SkillZipError('bad_zip', 'zip entry path traversal');
    }
  }

  const top = topLevelDir(zip);
  const normalized = top.toLowerCase();
  if (!SLUG_RE.test(normalized)) {
    throw new SkillZipError('invalid_name', `top-level directory "${top}" is not a valid slug`);
  }
  // Look up SKILL.md by the ORIGINAL-CASE top dir: the canonical skill `name`
  // is the lowercased slug, but the actual zip entry keeps the author's case
  // (e.g. `MySkill/SKILL.md`), so a lowercased lookup would miss it and a valid
  // mixed-case zip would be misreported as `bad_zip`.
  const skillMd = zip.getEntry(`${top}/SKILL.md`);
  if (!skillMd) throw new SkillZipError('bad_zip', 'SKILL.md missing in top-level directory');

  return {
    name: normalized,
    version: readVersion(skillMd),
    size: buf.byteLength,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    fileName: `${normalized}.zip`,
  };
}
