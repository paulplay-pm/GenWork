import AdmZip from 'adm-zip';
import { describe, expect, test } from 'vitest';

import { MAX_ZIP_BYTES, SkillZipError, parseSkillZip } from '../../src/lib/skillZip';

function zipWith(topDir: string, files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content));
  }
  return zip.toBuffer();
}

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SkillZipError);
    expect((e as SkillZipError).code).toBe(code);
    return;
  }
  throw new Error(`expected SkillZipError with code "${code}" but nothing was thrown`);
}

describe('parseSkillZip', () => {
  test('reads top-level dir name, version from SKILL.md frontmatter, sha256/size', () => {
    const buf = zipWith('pdf-tool', {
      'pdf-tool/SKILL.md': '---\nname: pdf-tool\nversion: 2.3.1\ndescription: x\n---\nbody',
    });
    const out = parseSkillZip(buf);
    expect(out.name).toBe('pdf-tool');
    expect(out.version).toBe('2.3.1');
    expect(out.size).toBe(buf.byteLength);
    expect(out.fileName).toBe('pdf-tool.zip');
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('defaults version to 1.0.0 when frontmatter has none', () => {
    const buf = zipWith('plain-skill', { 'plain-skill/SKILL.md': '# hi' });
    expect(parseSkillZip(buf).version).toBe('1.0.0');
  });

  test('normalizes a non-slug top dir to lowercase slug or throws invalid_name', () => {
    // "My Skill" is not a valid slug and does not normalize cleanly -> invalid_name
    const buf = zipWith('My Skill', { 'My Skill/SKILL.md': '# x' });
    expectCode(() => parseSkillZip(buf), 'invalid_name');
  });

  test('throws empty / too_large / bad_zip', () => {
    expectCode(() => parseSkillZip(Buffer.alloc(0)), 'empty');
    // A buffer just over the 10MB cap (no need to build a real zip that big —
    // the size check runs before the zip is parsed).
    expectCode(() => parseSkillZip(Buffer.alloc(MAX_ZIP_BYTES + 1)), 'too_large');
    expectCode(() => parseSkillZip(Buffer.from('not a zip')), 'bad_zip');
    // A zip with no SKILL.md anywhere
    expectCode(() => parseSkillZip(zipWith('x', { 'x/README.md': 'no skill here' })), 'bad_zip');
  });

  test('accepts a mixed-case top dir (lowercased name, original-case SKILL.md lookup)', () => {
    // "MySkill" lowercases to the valid slug "myskill", but the zip entry keeps
    // the author's original case. The canonical name is the lowercase slug; the
    // SKILL.md lookup must use the original case or the zip is misread as bad_zip.
    const buf = zipWith('MySkill', {
      'MySkill/SKILL.md': '---\nname: MySkill\nversion: 3.1.4\ndescription: x\n---\nbody',
    });
    const out = parseSkillZip(buf);
    expect(out.name).toBe('myskill');
    expect(out.version).toBe('3.1.4');
    expect(out.fileName).toBe('myskill.zip');
  });

  test('ignores the macOS Finder __MACOSX metadata sibling (Compress artifact)', () => {
    // "Compress" in Finder on macOS adds a parallel __MACOSX tree of
    // resource-fork stubs. Without special-casing it, the "exactly one
    // top-level dir" check sees TWO dirs (MySkill + __MACOSX) and rejects the
    // zip as bad_zip — the dominant real-world input on a Mac. The __MACOSX
    // stubs carry no SKILL.md, so the real dir must win.
    const buf = zipWith('MySkill', {
      'MySkill/SKILL.md': '---\nname: MySkill\nversion: 2.0.0\n---\nbody',
      '__MACOSX/MySkill/._SKILL.md': 'resource-fork stub',
    });
    const out = parseSkillZip(buf);
    expect(out.name).toBe('myskill');
    expect(out.version).toBe('2.0.0');
  });

  test('a zip of ONLY __MACOSX metadata (no real skill) is still bad_zip', () => {
    // Tolerating __MACOSX must not turn a zip with no actual skill into a valid
    // one: with the metadata tree stripped out there is no top-level dir left.
    const buf = zipWith('__MACOSX', { '__MACOSX/skill/._SKILL.md': 'stub' });
    expectCode(() => parseSkillZip(buf), 'bad_zip');
  });

  test('rejects path traversal entry', () => {
    const buf = zipWith('safe', { 'safe/SKILL.md': '# x', 'safe/../evil.txt': 'boom' });
    expectCode(() => parseSkillZip(buf), 'bad_zip');
  });
});
